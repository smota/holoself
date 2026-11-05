// Shared helpers for the link and proposal CLI commands: confirmation prompts, setup findings, activation.
import { basename, relative, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { activateProject, preflightActivation, readRuntime, recordedActivation } from '../adapters.mjs'
import { markdownFiles } from '../markdown/files.mjs'
import { slash } from '../shared/fs.mjs'

export function projectPath(o) {
  return resolve(o.project || o.target || process.cwd())
}
export async function askConfirm(o, message) {
  if (o.yes) return true
  if (!input.isTTY || !output.isTTY) throw new Error(`${message} Re-run with --yes to confirm.`)
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(`${message} Type "yes" to continue: `)).trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}
export async function askValue(message) {
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(`${message}: `)).trim()
  } finally {
    rl.close()
  }
}
// Reports a nextAllowedLenses result the same way on every attestation command.
export function reportGrant(project, grant, command) {
  if (grant.mode === 'new') console.log(`[ok] granting lenses on this machine: ${grant.allowed.join(', ') || '(none)'}`)
  else if (grant.adds.length || grant.removes.length) {
    console.log(JSON.stringify({ grant_update: { project: slash(project), adds: grant.adds, removes: grant.removes, applied: grant.applied } }, null, 2))
    if (!grant.applied)
      console.log(
        `[note] shared binding adds lenses not granted on this machine: ${grant.adds.join(', ')}; ` +
          `run 'holoself link ${command} --project <dir> --accept-shared-lenses' to grant them`
      )
    else console.log(`adds: [${grant.adds.join(', ')}] / removes: [${grant.removes.join(', ')}]`)
  }
  if (!grant.allowed.length)
    console.log(
      `[note] no lenses are granted to this project on this machine, so it is refused; ` +
        `run 'holoself link repair --project <dir> --accept-shared-lenses' or 'holoself link approve --project <dir> --lenses <a,b>'`
    )
}
export function setupFindings(project) {
  const files = markdownFiles(project)
  const names = files.map(path => slash(relative(project, path)))
  const instructions = names.filter(x => /(^|\/)(AGENTS|CLAUDE|CODEX)\.md$/i.test(x))
  const context = names.filter(x => /(profile|context|bio|cv|resume|voice|identity)/i.test(x))
  const lower = basename(project).toLowerCase()
  const lens = lower.includes('linkedin') ? 'public-voice' : lower.includes('professional') ? 'professional' : 'general'
  return {
    instructions,
    context,
    suggested_lens: lens,
    likely_duplicates: context,
    migration_recommendations: context.map(path => `${path}: compare with canonical self; retain project-specific content and propose reusable knowledge`)
  }
}

// Repair restores what was activated (runtime record, else active markers); `auto` only when nothing is known.
export function repairSelection(project) {
  const recorded = recordedActivation(project)
  return { activate: recorded.ids.join(','), source: recorded.source, dropped: recorded.dropped, skipped: recorded.skipped }
}
// selection: {activate, source, dropped, skipped} from repair; activate/setup pass none and report detected|explicit.
export async function activateLinkedProject(o, project, link, verb = 'Activate', selection = null) {
  if (o.noActivate) return null
  const explicit = Boolean(o.activate || o.platforms?.length),
    source = explicit ? 'explicit' : selection?.source || 'detected'
  const options = {
    activate: o.activate || selection?.activate || 'auto',
    platforms: o.platforms || [],
    instructions: o.instructions,
    installSkill: o.installSkill || readRuntime(project)?.skillInstallPolicy || 'auto',
    hooks: o.hooks || readRuntime(project)?.hookPolicy || 'auto',
    mcp: o.mcp || readRuntime(project)?.mcpPolicy || 'auto',
    approveReadTools: o.approveReadTools ?? readRuntime(project)?.mcpApproveReadTools === true,
    skillHome: o.skillHome,
    dryRun: o.dryRun,
    force: o.force
  }
  const { plan } = preflightActivation(project, options)
  console.log(
    JSON.stringify(
      {
        activation_plan: {
          source,
          adapter_ids: plan.adapters.map(x => x.id),
          ...(selection?.dropped?.length && !explicit ? { dropped_adapters: selection.dropped } : {}),
          ...(selection?.skipped?.length && !explicit ? { skipped_unmanaged: selection.skipped } : {}),
          canonical: plan.canonical,
          adapters: plan.adapters.map(
            ({ id, name, file, support, delivery, discovery, tested_product, tested_version, evidence, last_verified, detected }) => ({
              id,
              name,
              file,
              support,
              delivery,
              discovery,
              tested_product,
              tested_version,
              evidence,
              last_verified,
              detected
            })
          ),
          skills: plan.skills,
          global_skills: plan.globalSkills,
          ...hookPlanSummary(plan),
          ...mcpPlanSummary(plan),
          writes: plan.writes
        }
      },
      null,
      2
    )
  )
  if (!(await askConfirm(o, `${verb} Holoself by modifying bounded managed files: ${plan.writes.join(', ')}?`))) return null
  const result = activateProject(project, link, options)
  for (const item of result.results) console.log(` - ${item.id}: ${item.file} (${item.result})`)
  printHookResults(result)
  return result
}
// Session-start hook part of an activation plan, for the JSON plan printed before confirmation.
export function hookPlanSummary(plan) {
  return {
    hook_policy: plan.hookPolicy,
    session_start_hooks: plan.hooks.map(({ adapter, file, event, hook_id, support, install, action, trust_step }) => ({
      adapter,
      file,
      event,
      hook_id,
      support,
      install,
      action,
      ...(trust_step ? { trust_step } : {})
    })),
    ...(plan.unsupportedHooks.length ? { unsupported_hooks: plan.unsupportedHooks } : {})
  }
}
// MCP part of an activation plan: which hosts get the project-local MCP entry, and which keep BOOTSTRAP + CLI.
export function mcpPlanSummary(plan) {
  return {
    mcp_policy: plan.mcpPolicy,
    mcp_approve_read_tools: plan.mcpApproveReadTools,
    mcp_servers: plan.mcp.map(({ adapter, file, support, install, action, approval, approval_action, reason }) => ({
      adapter,
      file,
      support,
      install,
      action,
      ...(approval ? { read_tool_approval: approval } : {}),
      ...(approval_action ? { approval_action } : {}),
      ...(reason ? { reason } : {})
    })),
    ...(plan.mcpFallback.length ? { mcp_fallback: plan.mcpFallback } : {}),
    ...(plan.mcp.some(entry => entry.install && entry.adapter !== 'claude')
      ? { mcp_commit_warning: 'Codex and AGY MCP configuration embeds this host project path; keep it uncommitted unless explicitly reviewed.' }
      : {})
  }
}
export function printHookResults(result) {
  for (const item of result.hookResults || []) {
    console.log(` - ${item.adapter}: ${item.file} ${item.event} hook (${item.result})`)
    if (item.install && item.trust_step) console.log(`   trust step: ${item.trust_step}`)
  }
  for (const item of result.mcpResults || [])
    console.log(
      ` - ${item.adapter}: ${item.file} MCP server (${item.result})${item.approval_action ? `; read-tool approvals (${item.approval_action})` : ''}` +
        `${item.approve_read_tools && item.approval?.mechanism === 'documented-only' ? `; read-tool approvals not written: ${item.approval.example}` : ''}`
    )
}
export function commandStatus() {
  const invoked = slash(resolve(process.argv[1] || '')),
    packageBin = invoked.includes('/node_modules/')
  return {
    available: 'not-verified',
    invocation: packageBin ? 'package-bin' : 'source-checkout',
    path: invoked || null,
    note: packageBin
      ? 'This process used a package bin, but PATH availability was not independently verified.'
      : 'Run with node bin/holoself.mjs; source checkout does not prove a holoself command is installed on PATH.'
  }
}
