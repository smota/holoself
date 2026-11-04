// holoself propose command (moved verbatim from runEcosystem).
import { readLink } from '../../link/config.mjs'
import { analysis } from '../../proposals/analysis.mjs'
import { createProposal } from '../../proposals/store.mjs'
import { projectPath } from '../link-helpers.mjs'

export async function runPropose(o, sub) {
  const project = projectPath(o),
    link = readLink(project)
  if (link.proposals !== 'enabled') throw new Error('proposals are not enabled for link')
  const candidates = analysis(project).findings.filter(x => x.classification === 'Candidate for self')
  const claim = o.claim || (candidates[0] ? `Review reusable context from ${candidates[0].project_file}` : null)
  if (!claim) throw new Error('propose requires --claim <text> when no candidate is detected')
  const sourceFiles = o.sourceFiles?.length ? o.sourceFiles : candidates[0] ? [candidates[0].project_file] : []
  if (!sourceFiles.length) throw new Error('propose requires --source-file <path>')
  const p = createProposal(project, {
    claim,
    source_files: sourceFiles,
    target: o.targetFile,
    proposal_type: o.proposalType,
    evidence: o.evidence,
    confidence: o.confidence,
    visibility: o.visibility
  })
  console.log(JSON.stringify(p, null, 2))
  return true
}
