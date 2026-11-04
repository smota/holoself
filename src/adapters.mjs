import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { VERSION } from './version.mjs'
import {
  HARVEST_PROMPT_NAME,
  HARVEST_PROMPT_TEXT,
  HARVEST_PROMPT_VERSION,
  LINK_START,
  LINK_END,
  auditInstructions,
  bootstrapText,
  canonicalSection,
  harvestPromptText,
  instructionEvidence,
  overlaySection,
  validateHarvestPromptArgs
} from './instructions.mjs'
import {
  HISTORICAL_LINKED_PREFIX,
  HISTORICAL_PUBLIC_FRONTMATTER,
  LEGACY_SKILL,
  NEW_SKILL,
  PUBLIC_SKILL,
  REGISTRY,
  SKILL_BLOCK,
  SKILL_END,
  SKILL_FRONTMATTER,
  SKILL_START,
  atomicWrite,
  detectAdapters,
  frontmatterEnd,
  parseSelection,
  safeProjectFile,
  slash,
  unique,
  uniqueInstructionFiles,
  userSkillTargets
} from './adapters/registry.mjs'
import { injectMarker, managedBlockHash, managedMarkerState, markerInfo, removeMarker } from './adapters/markers.mjs'
import { contentHash, globalSkillStatus, inspectGlobalSkillPath, normalizedSkill, skillState } from './adapters/global-skills.mjs'
import { HOOK_HOSTS, HOOK_ID, HOOK_NOT_INSTALLED, HOOK_POLICIES, hookChange, hookSupport, inspectHook } from './adapters/hooks.mjs'
import {
  MCP_POLICIES,
  applyMcpEntryChanges,
  applyMcpRemovals,
  mcpActivationEntries,
  mcpEntryChanges,
  mcpFallbackAdapters,
  mcpInstallationRecord,
  mcpRemovalChanges,
  mcpRemovalFiles,
  mcpRemovalKept,
  recordedMcp
} from './adapters/mcp-activation.mjs'
import { CLAUDE_APPROVAL_FILE } from './adapters/mcp-approvals.mjs'
import { removeEmptyMcpDirs } from './mcp-config.mjs'
export { globalSkillStatus, installGlobalSkills } from './adapters/global-skills.mjs'
export { injectMarker, managedMarkerState, removeMarker } from './adapters/markers.mjs'
export { detectAdapters, safeProjectFile } from './adapters/registry.mjs'

export {
  HARVEST_PROMPT_NAME,
  HARVEST_PROMPT_TEXT,
  HARVEST_PROMPT_VERSION,
  LINK_START,
  LINK_END,
  auditInstructions,
  bootstrapText,
  harvestPromptText,
  validateHarvestPromptArgs
}
if (!PUBLIC_SKILL.startsWith('---\n') || frontmatterEnd < 6) throw new Error('public Holoself skill has invalid frontmatter')
export function activationPlan(project, options = {}) {
  if (options.installSkill && !['auto', 'project', 'global', 'none'].includes(options.installSkill))
    throw new Error(`invalid --install-skill value: ${options.installSkill}`)
  const detected = detectAdapters(project),
    selection = parseSelection(options.activate)
  let adapters =
    selection.mode === 'all' ? detected : selection.mode === 'list' ? detected.filter(a => selection.ids.includes(a.id)) : detected.filter(a => a.detected)
  const explicit = (options.platforms || [])
    .flatMap(x => x.split(','))
    .map(x => x.trim())
    .filter(Boolean)
  if (explicit.length) adapters = detected.filter(a => explicit.includes(a.id))
  const unknown = unique([...(selection.mode === 'list' ? selection.ids : []), ...explicit].filter(id => !REGISTRY.some(a => a.id === id)))
  if (unknown.length) throw new Error(`unknown platform adapter: ${unknown.join(', ')}`)
  if (!adapters.some(a => a.id === 'agents')) adapters.unshift(detected.find(a => a.id === 'agents'))
  const canonical = slash(options.instructions || 'AGENTS.md')
  safeProjectFile(project, canonical, 'canonical instructions')
  const mapped = adapters.map(a => ({
    id: a.id,
    name: a.name,
    support: a.support,
    delivery: a.delivery,
    discovery: a.discovery,
    tested_product: a.tested_product,
    tested_version: a.tested_version,
    evidence: a.evidence,
    last_verified: a.last_verified,
    detected: a.detected,
    file: slash(a.id === 'agents' ? canonical : a.files.find(f => existsSync(safeProjectFile(project, f, 'adapter instructions'))) || a.files[0]),
    skillDirs: a.skillDirs
  }))
  const install = options.installSkill || 'auto',
    skills = []
  if (!['none', 'global'].includes(install))
    for (const adapter of mapped)
      for (const dir of adapter.skillDirs) {
        const file = slash(join(dir, 'SKILL.md'))
        if (install === 'project' || existsSync(dirname(safeProjectFile(project, file, 'skill installation'))) || adapter.id === 'agents')
          skills.push({ adapter: adapter.id, file })
      }
  const providers = mapped
    .filter(adapter => adapter.id !== 'agents' && REGISTRY.find(item => item.id === adapter.id)?.userSkillDirs?.length)
    .map(adapter => adapter.id)
  const globalSkills =
    install === 'global'
      ? userSkillTargets(providers.length ? providers : ['agents'], options).map(x => ({ ...x, status: inspectGlobalSkillPath(x, options).status }))
      : []
  const hookPolicy = options.hooks || 'auto'
  if (!HOOK_POLICIES.includes(hookPolicy)) throw new Error(`invalid hook policy: ${hookPolicy}`)
  const hooks = mapped
    .filter(adapter => HOOK_HOSTS[adapter.id])
    .map(adapter => {
      const host = HOOK_HOSTS[adapter.id],
        support = hookSupport(adapter.id),
        install = hookPolicy === 'on' || (hookPolicy === 'auto' && support.support === 'verified')
      return {
        adapter: adapter.id,
        file: host.file,
        event: host.event,
        hook_id: HOOK_ID,
        command: host.command,
        support: support.support,
        tested_version: support.tested_version,
        last_verified: support.last_verified,
        install,
        ...(install && host.trustStep ? { trust_step: host.trustStep } : {}),
        action: 'pending'
      }
    })
  const unsupportedHooks = mapped
    .filter(adapter => adapter.id !== 'agents' && !HOOK_HOSTS[adapter.id])
    .map(adapter => ({ adapter: adapter.id, state: 'unsupported', reason: HOOK_NOT_INSTALLED[adapter.id] || 'No session-start hook integration for this host.' }))
  const mcpPolicy = options.mcp || 'auto'
  if (!MCP_POLICIES.includes(mcpPolicy)) throw new Error(`invalid MCP policy: ${mcpPolicy}`)
  const adapterIds = mapped.map(adapter => adapter.id)
  return {
    canonical,
    adapters: mapped,
    skills,
    globalSkills,
    hookPolicy,
    hooks,
    unsupportedHooks,
    mcpPolicy,
    mcpApproveReadTools: options.approveReadTools === true,
    mcp: mcpActivationEntries(adapterIds, mcpPolicy, options.approveReadTools === true),
    mcpFallback: mcpFallbackAdapters(adapterIds),
    writes: unique(['.holoself/BOOTSTRAP.md', '.holoself/runtime.json', ...mapped.map(x => x.file), ...skills.map(x => x.file)])
  }
}
function recordedHook(runtime, id) {
  return (runtime?.hookInstallations || []).find(x => x.id === id) || null
}
function applyHookChange(change) {
  if (change.action === 'unchanged') return
  if (change.after === null) {
    rmSync(change.path, { force: true })
    removeEmptyMcpDirs(change.project, change.createdDirs)
    return
  }
  atomicWrite(change.path, change.after, { mode: change.mode, exactMode: true })
}
// Hook entries to remove on deactivation: recorded installations plus any Holoself-owned entry still on disk.
function hookRemovalTargets(project, runtime, ids = null) {
  return Object.keys(HOOK_HOSTS)
    .filter(id => !ids || ids.includes(id))
    .filter(id => {
      if (recordedHook(runtime, id)) return true
      try {
        return ['installed', 'installed-trust-unverified', 'installed-untrusted', 'drifted'].includes(inspectHook(project, id).state)
      } catch {
        return false
      }
    })
    .map(id => ({ adapter: id, file: HOOK_HOSTS[id].file, ...hookRecordOptions(recordedHook(runtime, id)) }))
}
function hookRecordOptions(record) {
  return {
    createdFile: record?.createdFile === true,
    createdContainers: Array.isArray(record?.createdContainers) ? record.createdContainers : null,
    createdDirs: Array.isArray(record?.createdDirs) ? record.createdDirs.filter(dir => typeof dir === 'string') : null
  }
}
// A hook that cannot be removed safely (invalid or unsafe settings) is reported, not fatal: deactivation continues.
function hookRemovalChanges(project, targets) {
  return targets.map(target => {
    try {
      return { ...target, change: hookChange(project, target.adapter, false, target) }
    } catch (error) {
      return { ...target, change: null, message: `session-start hook left in place: ${error.message}; remove the holoself-session-start entry by hand` }
    }
  })
}
function applyHookRemovals(removals, dryRun) {
  return removals.map(({ adapter, file, change, message }) => {
    if (!change) return { adapter, file, kind: 'session-start-hook', result: 'unremovable', message }
    if (!dryRun) applyHookChange(change)
    return { adapter, file, kind: 'session-start-hook', result: change.action === 'unchanged' ? 'unchanged' : `hook-${change.action}` }
  })
}
function generatedSkillOutside(text, info) {
  const outside = normalizedSkill(text.slice(0, info.start) + text.slice(info.end))
  return [SKILL_FRONTMATTER, HISTORICAL_PUBLIC_FRONTMATTER, HISTORICAL_LINKED_PREFIX, LEGACY_SKILL.slice(0, LEGACY_SKILL.indexOf(SKILL_START))]
    .map(normalizedSkill)
    .includes(outside)
}
function nextSkillContent(old) {
  if (normalizedSkill(old) === normalizedSkill(PUBLIC_SKILL)) return old
  const info = markerInfo(old, SKILL_START, SKILL_END)
  if (info.state === 'malformed') throw new Error('malformed Holoself skill markers')
  if (info.state === 'active') return generatedSkillOutside(old, info) ? NEW_SKILL : old.slice(0, info.start) + SKILL_BLOCK.trimEnd() + old.slice(info.end)
  return old ? null : NEW_SKILL
}
function writeSkill(project, rel, dryRun = false, force = false) {
  const p = safeProjectFile(project, rel, 'skill installation write'),
    state = skillState(p)
  if (['unsafe', 'malformed'].includes(state)) throw new Error(`${p} has unsafe or malformed Holoself skill markers`)
  const old = existsSync(p) ? readFileSync(p, 'utf8') : '',
    generated = nextSkillContent(old),
    next = generated === null && force ? old.trimEnd() + '\n\n' + SKILL_BLOCK : generated
  if (next === null)
    throw new Error(`existing skill installation collision: ${p}; use --force --yes to append managed installation or choose --install-skill none`)
  if (!dryRun && next !== old) atomicWrite(p, next, { mode: 0o666 })
  return next === old ? 'unchanged' : state === 'active' ? 'updated' : old ? 'appended' : 'created'
}
function removeSkill(project, rel, dryRun = false) {
  const p = safeProjectFile(project, rel, 'skill installation removal'),
    state = skillState(p)
  if (['missing', 'inactive'].includes(state)) return 'unchanged'
  if (state !== 'active') throw new Error(`${p} has unsafe or malformed Holoself skill markers`)
  const old = readFileSync(p, 'utf8'),
    info = markerInfo(old, SKILL_START, SKILL_END),
    next = (old.slice(0, info.start) + old.slice(info.end)).trimEnd() + '\n'
  if (!dryRun) atomicWrite(p, next, { mode: 0o666 })
  return 'removed'
}
function runtimeFile(project) {
  return safeProjectFile(project, '.holoself/runtime.json', 'runtime write')
}
export function readRuntime(project) {
  try {
    return JSON.parse(readFileSync(runtimeFile(project), 'utf8'))
  } catch {
    return null
  }
}
function preflight(project, plan, options = {}) {
  const collisions = []
  for (const adapter of plan.adapters) {
    const p = safeProjectFile(project, adapter.file, 'instruction preflight'),
      state = managedMarkerState(p)
    if (['unsafe', 'malformed'].includes(state)) collisions.push(`${p}: ${state}`)
  }
  for (const skill of plan.skills) {
    const p = safeProjectFile(project, skill.file, 'skill preflight'),
      state = skillState(p)
    if (['unsafe', 'malformed'].includes(state) || (state === 'inactive' && !options.force))
      collisions.push(`${p}: ${state === 'inactive' ? 'existing unmanaged content (use --force --yes to append managed installation)' : state}`)
  }
  for (const skill of plan.globalSkills || [])
    if (!['full-public-skill-current', 'full-public-skill-compatible'].includes(skill.status)) collisions.push(`${skill.path}: global skill ${skill.status}`)
  const runtime = readRuntime(project),
    hookAfter = {}
  for (const hook of plan.hooks || []) {
    try {
      const change = hookChange(project, hook.adapter, hook.install, hookRecordOptions(recordedHook(runtime, hook.adapter)))
      hook.action = change.action
      hookAfter[hook.adapter] = { text: change.after, exists: change.after !== null }
      if (change.action !== 'unchanged' && !plan.writes.includes(hook.file)) plan.writes.push(hook.file)
    } catch (error) {
      collisions.push(error.message)
    }
  }
  for (const entry of plan.mcp || []) {
    try {
      const changes = mcpEntryChanges(project, entry, recordedMcp(runtime, entry.adapter), { claudeBase: entry.adapter === 'claude' ? hookAfter.claude : null })
      entry.action = changes.server?.action ?? 'unchanged'
      if (changes.approval) entry.approval_action = changes.approval.action
      if (changes.server && changes.server.action !== 'unchanged' && !plan.writes.includes(entry.file)) plan.writes.push(entry.file)
      if (changes.approval && changes.approval.action !== 'unchanged' && !plan.writes.includes(CLAUDE_APPROVAL_FILE)) plan.writes.push(CLAUDE_APPROVAL_FILE)
    } catch (error) {
      // The default never overrides a divergent `holoself` entry: the host is skipped and keeps the CLI fallback.
      if (error.code === 'MCP_DIVERGENT' && plan.mcpPolicy === 'auto' && entry.install) {
        Object.assign(entry, { install: false, approve_read_tools: false, approval: null, action: 'skipped' })
        entry.reason = `${error.message}; review it, then run holoself mcp configure --platform ${entry.adapter} --force-replace to replace it`
      } else collisions.push(error.message)
    }
  }
  for (const rel of options.metadataAbsent ? [] : ['.holoself/BOOTSTRAP.md', '.holoself/runtime.json']) {
    const p = safeProjectFile(project, rel, 'activation artifact')
    if (existsSync(p) && !lstatSync(p).isFile()) collisions.push(`${p}: not a regular file`)
  }
  if (collisions.length) throw new Error(`activation preflight failed: ${collisions.join('; ')}`)
  return { plan, collisions: [], writes: plan.writes }
}
export function preflightActivation(project, options = {}) {
  const plan = activationPlan(project, options)
  return preflight(project, plan, options)
}
// The Claude approval removal edits the same settings file as the hook removal, so it starts from the hook's result.
function claudeRemovalBase(runtime, hookRemovals) {
  const change = hookRemovals.find(item => item.adapter === 'claude')?.change
  return {
    claudeBase: change ? { text: change.after, exists: change.after !== null } : null,
    claudeFileCreated: recordedHook(runtime, 'claude')?.createdFile === true
  }
}
function snapshotPaths(project, rels) {
  return rels.map(rel => {
    const path = safeProjectFile(project, rel, 'transaction path')
    return { path, exists: existsSync(path), content: existsSync(path) && lstatSync(path).isFile() ? readFileSync(path) : null }
  })
}
function rollback(snapshots) {
  for (const item of snapshots.reverse()) {
    try {
      if (item.exists && item.content !== null) atomicWrite(item.path, item.content, { mode: 0o666 })
      else if (!item.exists && existsSync(item.path)) rmSync(item.path, { force: true })
    } catch {}
  }
}
export function activateProject(project, link, options = {}) {
  const plan = activationPlan(project, options)
  preflight(project, plan, options)
  if (options.dryRun)
    return {
      plan,
      results: plan.adapters.map(x => ({ ...x, result: 'planned' })),
      skillResults: plan.skills.map(x => ({ ...x, result: 'planned' })),
      hookResults: plan.hooks.filter(x => x.install || x.action !== 'unchanged').map(x => ({ ...x, result: 'planned' })),
      mcpResults: plan.mcp.map(x => ({ ...x, result: x.action === 'skipped' ? 'skipped' : 'planned' })),
      runtime: null
    }
  const previousRuntime = readRuntime(project),
    previousInstallations = previousRuntime?.skillInstallations || previousRuntime?.skillShims || [],
    previousByFile = new Map(previousInstallations.map(x => [x.file, x])),
    previousUnchangedOwned = new Map(
      plan.skills.map(x => {
        const record = previousByFile.get(x.file),
          path = safeProjectFile(project, x.file, 'skill ownership check')
        if (!record?.owned || !existsSync(path)) return [x.file, false]
        const text = readFileSync(path, 'utf8')
        if (record.contentHash) return [x.file, record.contentHash === contentHash(text)]
        const info = markerInfo(text, SKILL_START, SKILL_END)
        return [x.file, info.state === 'active' && generatedSkillOutside(text, info)]
      })
    ),
    snapshots = snapshotPaths(project, plan.writes),
    results = [],
    skillResults = [],
    hookResults = [],
    mcpResults = [],
    mcpCreatedDirs = []
  try {
    atomicWrite(safeProjectFile(project, '.holoself/BOOTSTRAP.md', 'bootstrap write'), bootstrapText(link), { mode: 0o666 })
    for (const adapter of plan.adapters) {
      const section = adapter.file === plan.canonical ? canonicalSection() : overlaySection(plan.canonical)
      results.push({ ...adapter, result: injectMarker(project, adapter.file, section, false) })
    }
    for (const skill of plan.skills) skillResults.push({ ...skill, result: writeSkill(project, skill.file, false, options.force === true) })
    const hookInstallations = []
    for (const hook of plan.hooks) {
      const previous = recordedHook(previousRuntime, hook.adapter),
        change = hookChange(project, hook.adapter, hook.install, hookRecordOptions(previous))
      if (change.action !== 'unchanged') mcpCreatedDirs.push(...(change.createdDirs || []))
      applyHookChange(change)
      if (hook.install || change.action !== 'unchanged') hookResults.push({ ...hook, action: change.action, result: change.action })
      if (hook.install) {
        const createdDirs = previous ? previous.createdDirs || [] : change.createdDirs || []
        hookInstallations.push({
          id: hook.adapter,
          file: hook.file,
          event: hook.event,
          hookId: hook.hook_id,
          command: hook.command,
          status: 'installed',
          createdFile: previous ? previous.createdFile === true : !change.existed,
          createdContainers: change.createdContainers,
          ...(createdDirs.length ? { createdDirs } : {}),
          support: hook.support,
          tested_version: hook.tested_version,
          last_verified: hook.last_verified
        })
      }
    }
    const installations = skillResults.map(x => {
      const text = readFileSync(safeProjectFile(project, x.file, 'skill runtime hash'), 'utf8'),
        owned = x.result === 'created' || previousUnchangedOwned.get(x.file) === true
      return { id: x.adapter, file: x.file, status: 'installed', kind: 'full-public-skill', owned, contentHash: owned ? contentHash(text) : null }
    })
    if (options.afterHooks) options.afterHooks()
    const mcpInstallations = []
    for (const entry of plan.mcp) {
      if (entry.action === 'skipped') {
        mcpResults.push({ ...entry, result: 'skipped' })
        continue
      }
      const previous = recordedMcp(previousRuntime, entry.adapter),
        changes = mcpEntryChanges(project, entry, previous)
      if (changes.server?.action !== 'unchanged') mcpCreatedDirs.push(...(changes.server?.createdDirs || []))
      applyMcpEntryChanges(changes)
      mcpResults.push({
        ...entry,
        action: changes.server?.action ?? 'unchanged',
        ...(changes.approval ? { approval_action: changes.approval.action } : {}),
        result: changes.server?.action ?? 'unchanged'
      })
      if (entry.install) {
        const record = mcpInstallationRecord(entry, changes, previous),
          hookDirs = hookInstallations.find(h => h.id === entry.adapter)?.createdDirs || []
        if (!record.createdDirs.length && hookDirs.length) record.createdDirs = [...hookDirs]
        mcpInstallations.push(record)
      }
    }
    if (options.afterMcp) options.afterMcp()
    const globalInstallations = (plan.globalSkills || []).map(x => ({
      id: x.id,
      file: x.file,
      status: x.status,
      kind: 'full-public-skill',
      contentHash: inspectGlobalSkillPath(x, options).contentHash,
      readOnly: inspectGlobalSkillPath(x, options).readOnly,
      verifiedAt: new Date().toISOString()
    }))
    const runtime = {
      schemaVersion: 2,
      project: basename(project),
      mode: 'live-link',
      defaultLens: link.default_lens,
      activatedAdapters: results.map(x => {
        const text = readFileSync(safeProjectFile(project, x.file, 'runtime hash'), 'utf8')
        return {
          id: x.id,
          file: x.file,
          status: 'active',
          markerHash: managedBlockHash(text),
          delivery: x.delivery,
          discovery: x.discovery,
          tested_product: x.tested_product,
          tested_version: x.tested_version,
          evidence: x.evidence,
          last_verified: x.last_verified
        }
      }),
      skillInstallPolicy: options.installSkill || 'auto',
      skillInstallations: installations,
      globalSkillInstallations: globalInstallations,
      skillShims: installations.map(({ contentHash, ...x }) => ({ ...x, status: 'active' })),
      hookPolicy: plan.hookPolicy,
      hookInstallations,
      mcpPolicy: plan.mcpPolicy,
      mcpApproveReadTools: plan.mcpApproveReadTools,
      mcpInstallations,
      fallback: '.holoself/BOOTSTRAP.md',
      instructionEvidence: instructionEvidence(link),
      lastValidated: new Date().toISOString(),
      toolVersion: VERSION
    }
    atomicWrite(runtimeFile(project), JSON.stringify(runtime, null, 2) + '\n', { mode: 0o666 })
    return { plan, results, skillResults, hookResults, mcpResults, runtime }
  } catch (error) {
    rollback(snapshots)
    removeEmptyMcpDirs(project, mcpCreatedDirs)
    throw error
  }
}
function registryInstructionFiles(project) {
  const runtime = readRuntime(project),
    tracked = new Set((runtime?.activatedAdapters || []).map(x => x.file)),
    files = uniqueInstructionFiles(project, [...tracked, ...REGISTRY.flatMap(x => x.files)])
  return files.filter(rel => {
    if (tracked.has(rel)) return true
    try {
      return !['missing', 'inactive'].includes(managedMarkerState(safeProjectFile(project, rel, 'managed marker discovery')))
    } catch {
      return true
    }
  })
}
function registrySkillFiles(project) {
  const runtime = readRuntime(project),
    files = [
      ...(runtime?.skillInstallations || runtime?.skillShims || []).map(x => x.file),
      ...REGISTRY.flatMap(x => x.skillDirs.map(dir => slash(join(dir, 'SKILL.md'))))
    ]
  return unique(files)
}
// Scoped deactivation removes only the named adapters' managed blocks and project skills and rewrites runtime.json.
// It falls through to full deactivation when nothing would remain active.
function deactivateAdapters(project, ids, options = {}) {
  const unknown = ids.filter(id => !REGISTRY.some(a => a.id === id))
  if (unknown.length) throw new Error(`unknown platform adapter: ${unknown.join(', ')}`)
  const runtime = readRuntime(project),
    active = activeAdapterIds(project, runtime),
    selected = ids.filter(id => active.includes(id)),
    remaining = active.filter(id => !ids.includes(id))
  if (!remaining.length)
    return [
      ...deactivateProject(project, { ...options, adapters: null }),
      ...ids.filter(id => !active.includes(id)).map(adapter => ({ adapter, file: null, result: 'not-active' }))
    ]
  if (selected.includes('agents'))
    throw new Error(`deactivation preflight failed: agents is required by ${remaining.join(', ')}; deactivate them too or use --adapters all`)
  const recorded = runtime?.activatedAdapters || [],
    installations = runtime?.skillInstallations || runtime?.skillShims || []
  const instructionFiles = selected.flatMap(adapter => {
    const file = recorded.find(x => x.id === adapter)?.file
    return (
      file
        ? [file]
        : uniqueInstructionFiles(project, REGISTRY.find(a => a.id === adapter).files).filter(item => {
            try {
              return managedMarkerState(safeProjectFile(project, item, 'scoped deactivation discovery')) === 'active'
            } catch {
              return false
            }
          })
    ).map(item => ({ adapter, file: item }))
  })
  const skillFiles = selected.flatMap(adapter => {
    const tracked = installations.filter(x => x.id === adapter).map(x => x.file)
    return (tracked.length ? tracked : REGISTRY.find(a => a.id === adapter).skillDirs.map(dir => slash(join(dir, 'SKILL.md')))).map(file => ({ adapter, file }))
  })
  for (const { file } of instructionFiles) {
    const state = managedMarkerState(safeProjectFile(project, file, 'deactivation preflight'))
    if (['unsafe', 'malformed'].includes(state)) throw new Error(`deactivation preflight failed: ${file}: ${state}`)
  }
  for (const { file } of skillFiles) {
    const state = skillState(safeProjectFile(project, file, 'skill deactivation preflight'))
    if (['unsafe', 'malformed'].includes(state)) throw new Error(`deactivation preflight failed: ${file}: ${state}`)
  }
  const hookRemovals = hookRemovalChanges(project, hookRemovalTargets(project, runtime, selected)),
    mcpRemovals = mcpRemovalChanges(project, runtime, selected, claudeRemovalBase(runtime, hookRemovals))
  const keptFiles = new Set([
    ...recorded.filter(x => remaining.includes(x.id)).map(x => x.file),
    ...installations.filter(x => remaining.includes(x.id)).map(x => x.file)
  ])
  const installationByFile = new Map(installations.map(x => [x.file, x])),
    snapshots = snapshotPaths(
      project,
      unique([
        ...instructionFiles.map(x => x.file),
        ...skillFiles.map(x => x.file),
        ...hookRemovals.map(x => x.file),
        ...mcpRemovalFiles(mcpRemovals),
        '.holoself/runtime.json'
      ])
    ),
    results = []
  try {
    for (const { adapter, file } of instructionFiles)
      results.push({ adapter, file, result: keptFiles.has(file) ? 'kept-shared' : removeMarker(project, file, options.dryRun) })
    for (const { adapter, file } of skillFiles) {
      if (keptFiles.has(file)) {
        results.push({ adapter, file, result: 'kept-shared' })
        continue
      }
      const path = safeProjectFile(project, file, 'skill discovery')
      if (skillState(path) !== 'active') continue
      const text = readFileSync(path, 'utf8'),
        info = markerInfo(text, SKILL_START, SKILL_END),
        tracked = installationByFile.get(file),
        unchangedOwned = tracked?.owned && tracked.contentHash && tracked.contentHash === contentHash(text)
      if (unchangedOwned || generatedSkillOutside(text, info)) {
        if (!options.dryRun) rmSync(path, { force: true })
        results.push({ adapter, file, result: 'removed' })
      } else results.push({ adapter, file, result: removeSkill(project, file, options.dryRun) })
    }
    results.push(...applyHookRemovals(hookRemovals, options.dryRun))
    results.push(...applyMcpRemovals(mcpRemovals, options.dryRun))
    if (!options.dryRun) removeEmptyMcpDirs(project, hookRemovals.flatMap(r => r.createdDirs || []))
    for (const adapter of ids.filter(id => !active.includes(id))) results.push({ adapter, file: null, result: 'not-active' })
    if (!options.dryRun && runtime) {
      const keep = x => !selected.includes(x.id)
      atomicWrite(
        runtimeFile(project),
        JSON.stringify(
          {
            ...runtime,
            activatedAdapters: recorded.filter(keep),
            ...(runtime.skillInstallations ? { skillInstallations: runtime.skillInstallations.filter(keep) } : {}),
            ...(runtime.skillShims ? { skillShims: runtime.skillShims.filter(keep) } : {}),
            ...(runtime.globalSkillInstallations ? { globalSkillInstallations: runtime.globalSkillInstallations.filter(keep) } : {}),
            ...(runtime.hookInstallations
              ? { hookInstallations: runtime.hookInstallations.filter(x => keep(x) || hookRemovals.some(r => r.adapter === x.id && !r.change)) }
              : {}),
            ...(runtime.mcpInstallations ? { mcpInstallations: runtime.mcpInstallations.filter(x => keep(x) || mcpRemovalKept(mcpRemovals).has(x.id)) } : {})
          },
          null,
          2
        ) + '\n',
        { mode: 0o666 }
      )
    }
    return results
  } catch (error) {
    if (!options.dryRun) rollback(snapshots)
    throw error
  }
}
export function deactivateProject(project, options = {}) {
  const scope =
    typeof options.adapters === 'string'
      ? options.adapters
          .split(',')
          .map(x => x.trim())
          .filter(Boolean)
      : options.adapters
  if (scope?.length && !scope.includes('all')) return deactivateAdapters(project, unique(scope), options)
  const runtime = readRuntime(project),
    installations = runtime?.skillInstallations || runtime?.skillShims || [],
    installationByFile = new Map(installations.map(x => [x.file, x])),
    instructionFiles = registryInstructionFiles(project),
    skillFiles = registrySkillFiles(project),
    results = []
  for (const file of instructionFiles) {
    const state = managedMarkerState(safeProjectFile(project, file, 'deactivation preflight'))
    if (['unsafe', 'malformed'].includes(state)) throw new Error(`deactivation preflight failed: ${file}: ${state}`)
  }
  for (const file of skillFiles) {
    const state = skillState(safeProjectFile(project, file, 'skill deactivation preflight'))
    if (['unsafe', 'malformed'].includes(state)) throw new Error(`deactivation preflight failed: ${file}: ${state}`)
  }
  const hookRemovals = hookRemovalChanges(project, hookRemovalTargets(project, runtime)),
    mcpRemovals = mcpRemovalChanges(project, runtime, null, claudeRemovalBase(runtime, hookRemovals))
  const rels = unique([...instructionFiles, ...skillFiles, ...hookRemovals.map(x => x.file), ...mcpRemovalFiles(mcpRemovals), '.holoself/runtime.json']),
    snapshots = snapshotPaths(project, rels)
  try {
    for (const file of instructionFiles) results.push({ file, result: removeMarker(project, file, options.dryRun) })
    results.push(...applyHookRemovals(hookRemovals, options.dryRun))
    results.push(...applyMcpRemovals(mcpRemovals, options.dryRun))
    if (!options.dryRun) removeEmptyMcpDirs(project, hookRemovals.flatMap(r => r.createdDirs || []))
    for (const file of skillFiles) {
      const path = safeProjectFile(project, file, 'skill discovery'),
        state = skillState(path)
      if (state === 'active') {
        const text = readFileSync(path, 'utf8'),
          info = markerInfo(text, SKILL_START, SKILL_END),
          tracked = installationByFile.get(file),
          unchangedOwned = tracked?.owned && tracked.contentHash && tracked.contentHash === contentHash(text)
        if (unchangedOwned || generatedSkillOutside(text, info)) {
          if (!options.dryRun) rmSync(path, { force: true })
          results.push({ file, result: 'removed' })
        } else results.push({ file, result: removeSkill(project, file, options.dryRun) })
      }
    }
    if (!options.dryRun && existsSync(runtimeFile(project))) rmSync(runtimeFile(project))
    return results
  } catch (error) {
    if (!options.dryRun) rollback(snapshots)
    throw error
  }
}
export function activationStatus(project, options = {}) {
  const runtime = readRuntime(project),
    bootstrap = existsSync(safeProjectFile(project, '.holoself/BOOTSTRAP.md', 'bootstrap status')),
    adapters = (runtime?.activatedAdapters || []).map(a => {
      const path = safeProjectFile(project, a.file, 'activation status'),
        marker = managedMarkerState(path),
        actualHash = marker === 'active' ? managedBlockHash(readFileSync(path, 'utf8')) : null
      return { ...a, marker, actualHash, drift: marker === 'active' && a.markerHash !== actualHash }
    })
  const discovered = registryInstructionFiles(project)
    .filter(file => !adapters.some(a => a.file === file))
    .map(file => ({ file, marker: managedMarkerState(safeProjectFile(project, file, 'activation discovery')), drift: true, status: 'untracked' }))
  adapters.push(...discovered)
  const installations = (runtime?.skillInstallations || runtime?.skillShims || []).map(item => {
    const detail = inspectGlobalSkillPath(item, { skillHome: project })
    return {
      ...item,
      ...detail,
      marker:
        detail.status === 'full-public-skill-current'
          ? detail.external
            ? detail.status
            : 'public'
          : detail.status === 'full-public-skill-compatible'
            ? 'active'
            : detail.status
    }
  })
  const globalIds = (runtime?.globalSkillInstallations || []).map(x => x.id),
    globalInstallations = runtime?.skillInstallPolicy === 'global' ? globalSkillStatus({ ...options, platforms: globalIds }).installations : []
  const projectSkillDeployments = registrySkillFiles(project)
    .map(file => ({ file, ...inspectGlobalSkillPath({ file }, { skillHome: project }) }))
    .filter(item => item.status !== 'missing')
  const projectSkillOverrideDetails =
    runtime?.skillInstallPolicy === 'global'
      ? projectSkillDeployments
          .filter(item => !(item.external && item.installed))
          .map(item => ({ ...item, remediation: item.external ? item.remediation : 'Review and relocate the local override, then rerun link doctor' }))
      : []
  const projectSkillOverrides = projectSkillOverrideDetails.map(item => item.file)
  const active = bootstrap && adapters.length > 0 && adapters.every(a => a.marker === 'active' && !a.drift)
  const hooks = sessionStartHookStatus(project, runtime)
  return {
    hooks,
    runtime,
    bootstrap,
    adapters,
    skillInstallations: installations,
    globalSkillInstallations: globalInstallations,
    projectSkillOverrides,
    projectSkillOverrideDetails,
    projectSkillDeployments,
    active
  }
}

// Per activated host: installed | installed-trust-unverified | installed-untrusted | missing | drifted | unsafe | invalid | untracked | disabled | not-installed | unsupported.
export function sessionStartHookStatus(project, runtime = readRuntime(project)) {
  return activeAdapterIds(project, runtime)
    .filter(id => id !== 'agents')
    .map(id => {
      if (!HOOK_HOSTS[id]) return { id, state: 'unsupported', reason: HOOK_NOT_INSTALLED[id] || 'No session-start hook integration for this host.' }
      const record = recordedHook(runtime, id),
        support = hookSupport(id)
      let inspected
      try {
        inspected = inspectHook(project, id)
      } catch (error) {
        inspected = { state: 'unsafe', detail: error.message }
      }
      const state = record
        ? inspected.state
        : inspected.state === 'missing'
          ? runtime?.hookPolicy === 'off'
            ? 'disabled'
            : 'not-installed'
          : 'untracked'
      return {
        id,
        file: HOOK_HOSTS[id].file,
        event: HOOK_HOSTS[id].event,
        hook_id: HOOK_ID,
        state,
        ...(inspected.detail ? { detail: inspected.detail } : {}),
        ...(state === 'installed-untrusted' && inspected.trust_step ? { trust_step: inspected.trust_step } : {}),
        support: support.support,
        tested_version: support.tested_version,
        last_verified: support.last_verified,
        ...(state === 'not-installed' && support.reason ? { reason: support.reason } : {})
      }
    })
}

export function activeAdapterIds(project, runtime) {
  if (runtime?.activatedAdapters?.length) return unique(runtime.activatedAdapters.map(x => x.id).filter(id => REGISTRY.some(a => a.id === id)))
  return REGISTRY.filter(adapter =>
    adapter.files.some(file => {
      try {
        return managedMarkerState(safeProjectFile(project, file, 'adapter migration discovery')) === 'active'
      } catch {
        return false
      }
    })
  ).map(x => x.id)
}
// Adapter set to restore on repair: the runtime record, else active managed markers, else detected hosts.
// The host fallback skips adapters whose instruction file exists without markers (written by hand); agents is always kept.
export function recordedActivation(project, runtime = readRuntime(project)) {
  const recorded = unique((runtime?.activatedAdapters || []).map(x => x.id)),
    dropped = recorded.filter(id => !REGISTRY.some(a => a.id === id)),
    known = recorded.filter(id => !dropped.includes(id))
  if (known.length) return { ids: known, source: 'recorded', dropped, skipped: [] }
  const marked = activeAdapterIds(project, null)
  if (marked.length) return { ids: unique(['agents', ...marked]), source: 'detected', dropped, skipped: [] }
  const handWritten = adapter =>
    adapter.files.some(file => {
      try {
        return managedMarkerState(safeProjectFile(project, file, 'repair host discovery')) === 'inactive'
      } catch {
        return false
      }
    })
  const hosts = detectAdapters(project).filter(adapter => adapter.detected),
    skipped = hosts.filter(adapter => adapter.id !== 'agents' && handWritten(adapter)).map(adapter => adapter.id)
  return { ids: unique(['agents', ...hosts.map(adapter => adapter.id).filter(id => !skipped.includes(id))]), source: 'detected', dropped, skipped }
}
function projectSkillCleanupPlan(project, runtime, options = {}) {
  const tracked = new Map((runtime?.skillInstallations || runtime?.skillShims || []).map(x => [x.file, x])),
    items = []
  for (const file of registrySkillFiles(project)) {
    const path = safeProjectFile(project, file, 'project skill migration'),
      state = skillState(path)
    if (state === 'missing') continue
    if (['unsafe', 'malformed', 'inactive'].includes(state)) throw new Error(`project skill cleanup collision: ${file}: ${state}`)
    const record = tracked.get(file),
      text = readFileSync(path, 'utf8'),
      hash = contentHash(text)
    if (state === 'public') {
      const owned = record?.owned && (!record.contentHash || record.contentHash === hash)
      if (!owned && !options.force) throw new Error(`project skill cleanup collision: ${file}: unowned public skill; review and use --force --yes to remove`)
      items.push({ file, path, marker: state, ownership: owned ? 'holoself-owned' : 'explicit-force', action: 'delete' })
      continue
    }
    const info = markerInfo(text, SKILL_START, SKILL_END),
      generated = generatedSkillOutside(text, info),
      owned = record?.owned && (!record.contentHash || record.contentHash === hash)
    items.push({
      file,
      path,
      marker: state,
      ownership: owned ? 'holoself-owned' : generated ? 'generated-markers' : 'managed-block',
      action: owned || generated ? 'delete' : 'remove-managed-block'
    })
  }
  return items
}
export function migrateProjectSkillsToGlobal(project, link, options = {}) {
  const oldRuntime = readRuntime(project),
    ids = activeAdapterIds(project, oldRuntime),
    activate = ids.length ? ids.join(',') : 'auto',
    activationOptions = { ...options, activate, installSkill: 'global' }
  const { plan: activation } = preflightActivation(project, activationOptions),
    cleanup = projectSkillCleanupPlan(project, oldRuntime, options)
  const migration = {
    project: slash(resolve(project)),
    from: oldRuntime?.skillInstallPolicy || 'untracked',
    to: 'global',
    global_skills: activation.globalSkills.map(x => ({ id: x.id, file: x.file, path: slash(x.path), status: x.status })),
    project_cleanup: cleanup.map(({ path, ...x }) => x),
    runtime_schema: 2
  }
  if (options.dryRun) return migration
  const rels = unique([...activation.writes, ...cleanup.map(x => x.file)]),
    snapshots = snapshotPaths(project, rels)
  try {
    activateProject(project, link, activationOptions)
    for (const item of cleanup) {
      if (item.action === 'delete') rmSync(item.path, { force: true })
      else removeSkill(project, item.file, false)
    }
    if (options.afterCleanup) options.afterCleanup()
    return { ...migration, status: 'migrated' }
  } catch (error) {
    rollback(snapshots)
    throw error
  }
}
