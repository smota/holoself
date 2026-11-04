// Project analysis that finds overlap, conflicts and candidates for proposals.
import { statSync } from 'node:fs'
import { buildCatalogSource } from '../catalog/source.mjs'
import { readLink } from '../link/config.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { canonicalFiles, projectMarkdownFiles } from '../markdown/files.mjs'
import { tokenize } from '../markdown/text.mjs'
import { createRecordDelivery } from '../retrieval/delivery.mjs'
import { catalogCandidateRecords } from '../retrieval/records.mjs'
import { slash } from '../shared/fs.mjs'

export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
}
export function similarity(a, b) {
  const aa = new Set(tokenize(a)),
    bb = new Set(tokenize(b))
  if (!aa.size && !bb.size) return 1
  let both = 0
  for (const x of aa) if (bb.has(x)) both++
  return both / (aa.size + bb.size - both)
}
function loadAnalysisRecords(root, kind, link) {
  const files = kind === 'self' ? canonicalFiles(root) : projectMarkdownFiles(root, link)
  const sourceKind = kind === 'self' ? 'canonical' : 'project'
  const sources = []
  for (const file of files) {
    const built = buildCatalogSource(file, sourceKind, root, null, kind === 'project')
    if (built?.record) sources.push(built.record)
  }
  const spaceId = kind === 'self' ? 'self' : canonicalSpaceId(root)
  const { records } = catalogCandidateRecords({ space_id: spaceId, sources }, root, kind, 'private', null, 'generic', null, null)
  const { deliverRecord } = createRecordDelivery(
    { task: null },
    { project: root, identity: { kind: 'owner:direct' }, registry: null, lens: 'private', resolution: null, subject: null, adapter: 'generic' }
  )
  const deliveredRecords = []
  for (const cand of records) {
    const delivered = deliverRecord(cand)
    if (delivered) deliveredRecords.push({ ...cand, content: delivered.content })
  }
  return deliveredRecords
}
export function analysis(project) {
  const link = readLink(project)
  const selfDocs = loadAnalysisRecords(link.path, 'self', link)
  const projectDocs = loadAnalysisRecords(project, 'project', link)
  const findings = []
  for (const p of projectDocs) {
    let matched = false
    for (const s of selfDocs) {
      if (normalize(p.content) === normalize(s.content) && normalize(p.content)) {
        findings.push({
          classification: 'Exact duplicate',
          project_file: p.path,
          self_file: s.path,
          evidence: 'normalized contents match',
          recommendation: 'Reference canonical self; keep project artifact until reviewed.'
        })
        matched = true
        if (statSync(p.absolute_path).mtimeMs < statSync(s.absolute_path).mtimeMs)
          findings.push({
            classification: 'Stale copy',
            project_file: p.path,
            self_file: s.path,
            evidence: 'matching project copy is older',
            recommendation: 'Regenerate view after review; do not delete automatically.'
          })
        continue
      }
      const score = similarity(p.content, s.content)
      if (score >= 0.72) {
        findings.push({
          classification: 'Semantic duplicate',
          project_file: p.path,
          self_file: s.path,
          evidence: `token similarity ${score.toFixed(2)}`,
          recommendation: 'Compare and retain only project-specific extension.'
        })
        matched = true
      }
      const pNums = [...p.content.matchAll(/\b\d+(?:\.\d+)?%?\b/g)].map(x => x[0])
      const sNums = [...s.content.matchAll(/\b\d+(?:\.\d+)?%?\b/g)].map(x => x[0])
      if (score >= 0.35 && pNums.length && sNums.length && pNums.some(x => !sNums.includes(x))) {
        findings.push({
          classification: 'Contradiction',
          project_file: p.path,
          self_file: s.path,
          evidence: `related text has differing metrics (${pNums.join(', ')} vs ${sNums.join(', ')})`,
          recommendation: 'Verify evidence and create fact_correction or conflict_resolution proposal.'
        })
        matched = true
      }
    }
    if (p.sensitivity === 'employer-confidential' && /public|publish|linkedin/i.test(p.path))
      findings.push({
        classification: 'Sensitive leakage',
        project_file: p.path,
        self_file: null,
        evidence: 'employer-confidential content in publishing-like path',
        recommendation: 'Restrict visibility and remove from public output after review.'
      })
    if (!matched) {
      const candidate = /(identity|career|voice|preference|story|achievement|leadership)/i.test(p.path)
      const unclear = !candidate && /(profile|context)/i.test(p.path)
      findings.push({
        classification: candidate ? 'Candidate for self' : unclear ? 'Unclear ownership' : 'Project-specific content',
        project_file: p.path,
        self_file: null,
        evidence: candidate ? 'durable-context filename pattern' : unclear ? 'context-like path without canonical match' : 'no canonical overlap detected',
        recommendation: candidate
          ? 'Create proposal with evidence.'
          : unclear
            ? 'Review ownership; keep file in place until decided.'
            : 'Keep owned by project.'
      })
    }
  }
  return { generated_at: new Date().toISOString(), project: slash(project), self: slash(link.path), findings }
}
export function filterAnalysis(report, type) {
  if (type === 'overlap')
    return report.findings.filter(x =>
      ['Exact duplicate', 'Semantic duplicate', 'Project-specific content', 'Candidate for self', 'Unclear ownership', 'Sensitive leakage'].includes(
        x.classification
      )
    )
  if (type === 'conflicts') return report.findings.filter(x => x.classification === 'Contradiction' || x.classification === 'Sensitive leakage')
  if (type === 'stale') return report.findings.filter(x => x.classification === 'Stale copy')
  return report.findings
}
