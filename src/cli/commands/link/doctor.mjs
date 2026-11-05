// holoself link doctor subcommand (moved verbatim from runEcosystem).
import { existsSync } from 'node:fs'
import { pathKeyedBindingCount } from '../../../bindings.mjs'
import { loadLensRegistry } from '../../../lenses.mjs'
import { readLink } from '../../../link/config.mjs'
import { healthStatus } from '../../../link/health.mjs'
import { contextData } from '../../../retrieval/context.mjs'
import { redactRootPaths } from '../../../shared/redact.mjs'
import { commandStatus } from '../../link-helpers.mjs'

// One summary over hosts with a Holoself hook integration: the first unhealthy state wins, else installed-untrusted, else installed-trust-unverified, else the shared state.
function hookCheck(hooks) {
  const states = hooks.filter(hook => hook.state !== 'unsupported').map(hook => hook.state)
  if (!states.length) return hooks.length ? 'unsupported' : 'not-applicable'
  return (
    states.find(state => ['missing', 'drifted', 'unsafe', 'invalid', 'untracked'].includes(state)) ||
    states.find(state => state === 'installed-untrusted') ||
    states.find(state => state === 'installed-trust-unverified') ||
    states[0]
  )
}
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
      session_start_hook: hookCheck(health.activation.hooks),
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
  let pathKeyedBindings = null
  try {
    pathKeyedBindings = pathKeyedBindingCount(link.path)
  } catch {}
  const ok = !Object.values(checks).some(x => ['missing', 'invalid', 'degraded', 'broken', 'present', 'drifted', 'unsafe', 'untracked'].includes(x))
  console.log(
    JSON.stringify(
      {
        state: ok ? 'activated' : 'degraded',
        checks,
        warnings: checks.warnings || [],
        errors: health.errors,
        // Legacy lens bindings keyed by absolute path (one per machine that has not run link repair yet).
        path_keyed_bindings: pathKeyedBindings,
        project_skill_override_details: health.activation.projectSkillOverrideDetails,
        project_skill_deployments: health.activation.projectSkillDeployments,
        session_start_hooks: health.activation.hooks.map(({ detail, ...hook }) => hook)
      },
      null,
      2
    )
  )
  if (!ok) process.exitCode = 1
  return true
}
