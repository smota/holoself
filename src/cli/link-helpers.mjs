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
    session_start_hooks: plan.hooks.map(({ adapter, file, event, hook_id, support, install, action }) => ({ adapter, file, event, hook_id, support, install, action })),
    ...(plan.unsupportedHooks.length ? { unsupported_hooks: plan.unsupportedHooks } : {})
  }
}
export function printHookResults(result) {
  for (const item of result.hookResults || []) console.log(` - ${item.adapter}: ${item.file} ${item.event} hook (${item.result})`)
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
