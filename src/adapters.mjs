import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { VERSION } from './version.mjs'
import { LINK_START, LINK_END, auditInstructions, bootstrapText, canonicalSection, instructionEvidence, overlaySection } from './instructions.mjs'
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
export { globalSkillStatus, installGlobalSkills } from './adapters/global-skills.mjs'
export { injectMarker, managedMarkerState, removeMarker } from './adapters/markers.mjs'
export { detectAdapters, safeProjectFile } from './adapters/registry.mjs'

export { LINK_START, LINK_END, auditInstructions, bootstrapText }
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
  return {
    canonical,
    adapters: mapped,
    skills,
    globalSkills,
    writes: unique(['.holoself/BOOTSTRAP.md', '.holoself/runtime.json', ...mapped.map(x => x.file), ...skills.map(x => x.file)])
  }
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
    skillResults = []
  try {
    atomicWrite(safeProjectFile(project, '.holoself/BOOTSTRAP.md', 'bootstrap write'), bootstrapText(link), { mode: 0o666 })
    for (const adapter of plan.adapters) {
      const section = adapter.file === plan.canonical ? canonicalSection() : overlaySection(plan.canonical)
      results.push({ ...adapter, result: injectMarker(project, adapter.file, section, false) })
    }
    for (const skill of plan.skills) skillResults.push({ ...skill, result: writeSkill(project, skill.file, false, options.force === true) })
    const installations = skillResults.map(x => {
      const text = readFileSync(safeProjectFile(project, x.file, 'skill runtime hash'), 'utf8'),
        owned = x.result === 'created' || previousUnchangedOwned.get(x.file) === true
      return { id: x.adapter, file: x.file, status: 'installed', kind: 'full-public-skill', owned, contentHash: owned ? contentHash(text) : null }
    })
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
      fallback: '.holoself/BOOTSTRAP.md',
      instructionEvidence: instructionEvidence(link),
      lastValidated: new Date().toISOString(),
      toolVersion: VERSION
    }
    atomicWrite(runtimeFile(project), JSON.stringify(runtime, null, 2) + '\n', { mode: 0o666 })
    return { plan, results, skillResults, runtime }
  } catch (error) {
    rollback(snapshots)
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
  const keptFiles = new Set([
    ...recorded.filter(x => remaining.includes(x.id)).map(x => x.file),
    ...installations.filter(x => remaining.includes(x.id)).map(x => x.file)
  ])
  const installationByFile = new Map(installations.map(x => [x.file, x])),
    snapshots = snapshotPaths(project, unique([...instructionFiles.map(x => x.file), ...skillFiles.map(x => x.file), '.holoself/runtime.json'])),
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
            ...(runtime.globalSkillInstallations ? { globalSkillInstallations: runtime.globalSkillInstallations.filter(keep) } : {})
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
  const rels = unique([...instructionFiles, ...skillFiles, '.holoself/runtime.json']),
    snapshots = snapshotPaths(project, rels)
  try {
    for (const file of instructionFiles) results.push({ file, result: removeMarker(project, file, options.dryRun) })
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
  return {
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
