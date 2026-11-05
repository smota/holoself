// holoself link status subcommand (moved verbatim from runEcosystem).
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { LEGACY_MOUNT_DEPRECATION, readLink } from '../../../link/config.mjs'
import { healthStatus } from '../../../link/health.mjs'
import { canonicalProjectPath, canonicalSpaceId, readRegistry } from '../../../link/registry.mjs'
import { scanProposalStore } from '../../../proposals/store.mjs'
import { slash } from '../../../shared/fs.mjs'
import { commandStatus } from '../../link-helpers.mjs'

export async function linkStatus(o, sub, project) {
  const holoselfDir = join(project, '.holoself')
  if (existsSync(holoselfDir) && lstatSync(holoselfDir).isSymbolicLink()) {
    console.log(
      JSON.stringify(
        {
          project: slash(project),
          state: 'legacy-mount',
          mode: 'legacy-mount',
          isLegacyMount: true,
          errors: [`legacy filesystem junction mount detected; run holoself link setup to migrate to a bounded link; ${LEGACY_MOUNT_DEPRECATION}`],
          deprecation: LEGACY_MOUNT_DEPRECATION
        },
        null,
        2
      )
    )
    return true
  }
  let link
  try {
    link = readLink(project, { tolerant: true })
  } catch (error) {
    console.log(JSON.stringify({ project: slash(project), state: 'broken', errors: [error.message] }, null, 2))
    process.exitCode = 1
    return true
  }
  if (link._schemaErrors.length) {
    console.log(JSON.stringify({ project: slash(project), state: 'broken', errors: link._schemaErrors }, null, 2))
    process.exitCode = 1
    return true
  }
  const health = healthStatus(project, link, o),
    { project_context, binding_salt, ledger: _ledger, ...selfContext } = link,
    proposalScan = scanProposalStore(project)
  const selfExists = Boolean(link.path) && existsSync(link.path)
  let registryAttested = false
  if (selfExists) {
    try {
      const reg = readRegistry(link.path)
      const pId = canonicalSpaceId(project)
      const cPath = canonicalProjectPath(project)
      const entry = reg.links.find(l => l.project_id === pId || l.project_path === cPath)
      if (entry && entry.status === 'active' && entry.binding_salt === binding_salt) registryAttested = true
    } catch {}
  }
  const status = {
    project: slash(project),
    state: health.state,
    mode: health.mode,
    isLegacyMount: health.isLegacyMount,
    self_context: { ...selfContext, path: link.path ? slash(link.path) : null },
    project_context,
    binding_salt_present: Boolean(binding_salt && binding_salt.length === 32),
    registry_attested: registryAttested,
    self_exists: selfExists,
    pending_proposals: proposalScan.managed.filter(x => x.status === 'pending').length,
    proposal_health: {
      managed_pending: proposalScan.managed.filter(x => x.status === 'pending').length,
      unmanaged: proposalScan.diagnostics.filter(x => x.code.startsWith('UNMANAGED')).length,
      invalid: proposalScan.diagnostics.filter(x => x.severity === 'error').length
    },
    index_exists: existsSync(join(project, '.holoself', 'catalog', 'catalog.json')),
    bootstrap_exists: health.activation.bootstrap,
    activated_adapters: health.activation.adapters,
    skill_install_policy: health.skillPolicy,
    skill_installations: health.activation.skillInstallations,
    global_skill_installations: health.activation.globalSkillInstallations,
    project_skill_overrides: health.activation.projectSkillOverrides,
    project_skill_override_details: health.activation.projectSkillOverrideDetails,
    project_skill_deployments: health.activation.projectSkillDeployments,
    session_start_hooks: health.activation.hooks,
    hook_policy: health.activation.runtime?.hookPolicy || null,
    cli_command: commandStatus(),
    errors: health.errors
  }
  console.log(JSON.stringify(status, null, 2))
  if (['broken', 'degraded'].includes(status.state)) process.exitCode = 1
  return true
}
