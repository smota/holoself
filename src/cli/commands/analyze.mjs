// holoself analyze command (moved verbatim from runEcosystem).
import { dirname, join } from 'node:path'
import { analysis, filterAnalysis } from '../../proposals/analysis.mjs'
import { atomicWrite, ensureDir, slash } from '../../shared/fs.mjs'
import { projectPath } from '../link-helpers.mjs'

export async function runAnalyze(o, sub) {
  if (!['overlap', 'conflicts', 'stale', 'all'].includes(sub)) throw new Error('analyze requires overlap, conflicts, stale, or all')
  const project = projectPath(o),
    report = analysis(project)
  report.analysis = sub
  report.findings = filterAnalysis(report, sub)
  const out = join(project, '.holoself', 'reports', `${sub}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  ensureDir(dirname(out))
  atomicWrite(out, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, report_path: slash(out) }, null, 2))
  return true
}
