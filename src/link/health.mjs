// Link health: activation state, bootstrap and skill installation checks.
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { activationStatus } from '../adapters.mjs'

export function healthStatus(project, link, o = {}) {
  const holoselfDir = join(project, '.holoself')
  const isLegacyMount = existsSync(holoselfDir) && lstatSync(holoselfDir).isSymbolicLink()
  const activation = activationStatus(project, { skillHome: o.skillHome }),
    selfExists = existsSync(link.path),
    snapshot = existsSync(join(project, '.holoself', 'runtime', 'context-packet.md')),
    skillPolicy = activation.runtime?.skillInstallPolicy || 'auto',
    errors = []
  if (isLegacyMount) errors.push('legacy filesystem junction mount detected; run holoself link setup to migrate to a bounded link')
  if (!selfExists) errors.push('self path missing')
  if (link._bindingError) errors.push(link._bindingError)
  if (!activation.bootstrap && !snapshot) errors.push('bootstrap missing')
  if (!activation.adapters.length && !snapshot) errors.push('no activated adapters')
  for (const a of activation.adapters) {
    if (a.marker !== 'active') errors.push(`${a.file}: ${a.marker}`)
    else if (a.drift) errors.push(`${a.file}: managed block drift`)
  }
  for (const hook of activation.hooks)
    if (['missing', 'drifted', 'unsafe', 'invalid', 'untracked'].includes(hook.state)) errors.push(`${hook.file}: session-start hook ${hook.state}`)
  for (const skill of activation.skillInstallations) if (!skill.installed || skill.kind !== 'full-public-skill') errors.push(`${skill.file}: ${skill.kind}`)
  if (skillPolicy === 'global') {
    if (!activation.globalSkillInstallations.length) errors.push('no global public skill installation')
    for (const skill of activation.globalSkillInstallations)
      if (!skill.installed || skill.kind !== 'full-public-skill') errors.push(`${skill.file}: global ${skill.status}`)
    for (const item of activation.projectSkillOverrideDetails)
      errors.push(`${item.file}: unexpected project skill override (${item.status}); ${item.remediation}`)
  } else if (skillPolicy !== 'none' && !activation.skillInstallations.length) errors.push('no public skill installation')
  const state = isLegacyMount
    ? 'legacy-mount'
    : !selfExists
      ? 'broken'
      : activation.active && errors.length === 0
        ? 'activated'
        : snapshot && !activation.runtime
          ? 'manual-only'
          : activation.runtime
            ? 'degraded'
            : 'configured'
  const mode = isLegacyMount ? 'legacy-mount' : snapshot && !activation.runtime ? 'snapshot' : 'metadata-link'
  return { state, mode, isLegacyMount, activation, snapshot, skillPolicy, errors }
}
