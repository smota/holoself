// Project analysis that finds overlap, conflicts and candidates for proposals.
import { statSync } from 'node:fs'
import { readLink } from '../link/config.mjs'
import { tokenize } from '../markdown/text.mjs'
import { sourceRecords } from '../retrieval/records.mjs'
import { slash } from '../shared/fs.mjs'

export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
}
export function similarity(a, b) {
  const aa = tokenize(a),
    bb = tokenize(b)
  if (!aa.size && !bb.size) return 1
  let both = 0
  for (const x of aa) if (bb.has(x)) both++
  return both / (aa.size + bb.size - both)
}
export function analysis(project) {
  const link = readLink(project)
  const selfDocs = sourceRecords(link.path, 'self', 'private', null, 'generic', link).records
  const projectDocs = sourceRecords(project, 'project', 'private', null, 'generic', link).records
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
