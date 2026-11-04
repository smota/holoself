// holoself link doctor subcommand (moved verbatim from runEcosystem).
import { existsSync } from 'node:fs'
import { loadLensRegistry } from '../../../lenses.mjs'
import { readLink } from '../../../link/config.mjs'
import { healthStatus } from '../../../link/health.mjs'
import { contextData } from '../../../retrieval/context.mjs'
import { redactRootPaths } from '../../../shared/redact.mjs'
import { commandStatus } from '../../link-helpers.mjs'

export async function linkDoctor(o, sub, project) {
  const link = readLink(project),
    health = healthStatus(project, link, o),
    projectHealthy =
      health.activation.skillInstallations.length && health.activation.skillInstallations.every(x => x.kind === 'full-public-skill' && x.installed),
    globalHealthy =
      health.activation.globalSkillInstallations.length && health.activation.globalSkillInstallations.every(x => x.kind === 'full-public-skill' && x.installed),
    skillHealthy = health.skillPolicy === 'none' || (health.skillPolicy === 'global' ? globalHealthy : projectHealthy),
    checks = {
      link: 'valid',
      self_root: existsSync(link.path) ? 'valid' : 'missing',
      lens: loadLensRegistry(link.path).byId.has(link.default_lens) ? 'valid' : 'invalid',
      bootstrap: health.activation.bootstrap ? 'valid' : 'missing',
      activation: health.activation.active ? 'valid' : 'degraded',
      skill_installation:
        health.skillPolicy === 'none'
          ? 'disabled'
          : health.skillPolicy === 'global'
            ? globalHealthy
              ? 'global-full-public-skill'
              : 'degraded'
            : skillHealthy
              ? 'full-public-skill'
              : 'degraded',
      project_skill_overrides: health.skillPolicy === 'global' ? (health.activation.projectSkillOverrides.length ? 'present' : 'absent') : 'not-applicable',
      cli_command: commandStatus(),
      context: 'unknown'
    }
  try {
    const data = contextData({ ...o, project })
    checks.context = data.sources.length ? 'valid' : 'empty'
    checks.warnings = (data.warnings || []).map(w => redactRootPaths(w, [link.path, project]))
  } catch (error) {
    checks.context = 'broken'
    checks.context_error = redactRootPaths(error.message, [link.path, project])
  }
  const ok = !Object.values(checks).some(x => ['missing', 'invalid', 'degraded', 'broken', 'present'].includes(x))
  console.log(
    JSON.stringify(
      {
        state: ok ? 'activated' : 'degraded',
        checks,
        warnings: checks.warnings || [],
        errors: health.errors,
        project_skill_override_details: health.activation.projectSkillOverrideDetails,
        project_skill_deployments: health.activation.projectSkillDeployments
      },
      null,
      2
    )
  )
  if (!ok) process.exitCode = 1
  return true
}
