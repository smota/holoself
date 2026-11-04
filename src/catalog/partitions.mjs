// Catalog partitions (self, project, contrib, federated) and their freshness checks.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  CATALOG_SCHEMA_VERSION,
  atomicWriteFile,
  canonicalJson,
  canonicalSort,
  getStatTuple,
  purgeLegacyIndex,
  readSourceWithStat,
  slugHeading,
  sourceRef,
  validateCatalogSchema
} from '../catalog.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { canonicalFiles, globRegex, matchesAny } from '../markdown/files.mjs'
import { sections } from '../markdown/text.mjs'
import { SECRET_RE } from '../policy/secrets.mjs'
import { ensureDir, hash, slash } from '../shared/fs.mjs'
import { PACKAGE_ROOT } from '../shared/package-root.mjs'
import { buildCatalogSource, catalogFilePath, catalogRoot } from './source.mjs'

export function isPartitionFresh(catalog, rootDir, files, registry, expectedContextHash, spaceId) {
  if (!catalog) return false
  if (catalog.schema_version !== CATALOG_SCHEMA_VERSION) return false
  if (catalog.lens_registry_hash !== registry.registry_hash) return false
  if (spaceId === 'self') {
    if (catalog.project_context_hash !== null) return false
  } else {
    if (catalog.project_context_hash !== expectedContextHash) return false
  }
  const known = new Map()
  for (const s of catalog.sources || []) known.set(s.file, s)
  for (const s of catalog.ignored_sources || []) known.set(s.file, s)

  if (files.length !== known.size) return false

  for (const file of files) {
    const rel = slash(relative(rootDir, file))
    const expected = known.get(rel)
    if (!expected) return false
    let st
    try {
      st = getStatTuple(file)
    } catch {
      return false
    }
    if (expected.size !== st.size || expected.mtime_ns !== st.mtime_ns || expected.ino !== st.ino || expected.dev !== st.dev) return false
  }
  return true
}
export function ensureCatalogPartition(spaceId, rootDir, files, registry, options = {}) {
  const catPath = catalogFilePath(rootDir)
  let existingCatalog = null
  if (!options.rebuild && existsSync(catPath)) {
    try {
      const parsed = JSON.parse(readFileSync(catPath, 'utf8'))
      const val = validateCatalogSchema(parsed)
      if (val.valid && parsed.space_id === spaceId && parsed.lens_registry_hash === registry.registry_hash) {
        if (spaceId === 'self' && parsed.project_context_hash === null) {
          existingCatalog = parsed
        } else if (spaceId !== 'self' && parsed.project_context_hash === options.expectedProjectContextHash) {
          existingCatalog = parsed
        }
      }
    } catch {}
  }

  const isFresh = !options.rebuild && isPartitionFresh(existingCatalog, rootDir, files, registry, options.expectedProjectContextHash, spaceId)
  if (isFresh) {
    const persistentWarnings = (existingCatalog?.ignored_sources || [])
      .filter(s => s.reason && s.reason !== 'secret' && s.reason !== 'unsupported visibility')
      .map(s => s.reason)
    return { catalog: existingCatalog, fresh: true, skippedSecrets: 0, warnings: persistentWarnings, catalog_reads: 0 }
  }

  const existingByFile = new Map(existingCatalog ? existingCatalog.sources.map(s => [s.file, s]) : [])
  const existingIgnoredByFile = new Map(existingCatalog?.ignored_sources ? existingCatalog.ignored_sources.map(s => [s.file, s]) : [])

  const sources = [],
    ignored_sources = [],
    warnings = []
  let skippedSecrets = 0,
    catalogReads = 0
  const sourceKind = spaceId === 'self' ? 'canonical' : 'project'
  const isProject = spaceId !== 'self'

  for (const file of files) {
    const rel = slash(relative(rootDir, file))
    const sOld = existingByFile.get(rel)
    if (!options.rebuild && sOld) {
      let st = null
      try {
        st = getStatTuple(file)
      } catch {}
      if (st && sOld.size === st.size && sOld.mtime_ns === st.mtime_ns && sOld.ino === st.ino && sOld.dev === st.dev) {
        sources.push(sOld)
        continue
      }
    }
    const sIgnoredOld = existingIgnoredByFile.get(rel)
    if (!options.rebuild && sIgnoredOld) {
      let st = null
      try {
        st = getStatTuple(file)
      } catch {}
      if (st && sIgnoredOld.size === st.size && sIgnoredOld.mtime_ns === st.mtime_ns && sIgnoredOld.ino === st.ino && sIgnoredOld.dev === st.dev) {
        ignored_sources.push(sIgnoredOld)
        continue
      }
    }
    catalogReads++
    let built
    try {
      built = buildCatalogSource(file, sourceKind, rootDir, registry, isProject)
    } catch (err) {
      built = { unreadable: true, error: `${rel}: unreadable (${err.message})` }
    }
    if (built?.unreadable) {
      warnings.push(built.error)
      // Per plan §6.1.5.3.4: "sem gravar mtime falso no catálogo"
      // Write zeroed stat tuple so it will not match on subsequent runs and will be re-attempted
      ignored_sources.push({ file: rel, size: 0, modified_ms: 0, mtime_ns: '0', ino: '0', dev: '0', reason: built.error })
      continue
    }
    if (!built) {
      let st = null
      try {
        st = getStatTuple(file)
      } catch {}
      ignored_sources.push({
        file: rel,
        size: st ? st.size : 0,
        modified_ms: st ? st.modified_ms : 0,
        mtime_ns: st ? st.mtime_ns : '0',
        ino: st ? st.ino : '0',
        dev: st ? st.dev : '0',
        reason: st ? 'unsupported visibility' : 'unreadable: stat failure'
      })
      continue
    }
    if (built.secret) {
      skippedSecrets++
      let st = null
      try {
        st = getStatTuple(file)
      } catch {}
      ignored_sources.push({
        file: rel,
        size: st ? st.size : 0,
        modified_ms: st ? st.modified_ms : 0,
        mtime_ns: st ? st.mtime_ns : '0',
        ino: st ? st.ino : '0',
        dev: st ? st.dev : '0',
        reason: 'secret'
      })
      continue
    }
    if (built.error) {
      warnings.push(built.error)
      let st = null
      try {
        st = getStatTuple(file)
      } catch {}
      ignored_sources.push({
        file: rel,
        size: st ? st.size : 0,
        modified_ms: st ? st.modified_ms : 0,
        mtime_ns: st ? st.mtime_ns : '0',
        ino: st ? st.ino : '0',
        dev: st ? st.dev : '0',
        reason: built.error
      })
      continue
    }
    if (built.warnings) warnings.push(...built.warnings)
    if (built.record) sources.push(built.record)
  }

  sources.sort((a, b) => canonicalSort(a.file, b.file))
  ignored_sources.sort((a, b) => canonicalSort(a.file, b.file))

  if (isProject && options.link?.project_context) {
    const link = options.link,
      projectPaths = sources.map(s => s.file),
      assertionErrors = []
    for (const s of sources) {
      if (!matchesAny(s.file, link.project_context.include)) assertionErrors.push(`${s.file}: outside include policy`)
      if (matchesAny(s.file, link.project_context.exclude)) assertionErrors.push(`${s.file}: matched exclude policy`)
    }
    for (const pattern of link.project_context.assert_exclude || []) {
      if (projectPaths.some(file => globRegex(pattern).test(file))) assertionErrors.push(`assert_exclude matched indexed file: ${pattern}`)
    }
    for (const s of sources) {
      for (const sec of s.sections || []) {
        if (SECRET_RE.test(sec.snippet)) assertionErrors.push(`${s.source_kind}:${s.file}: secret-like content survived index build`)
      }
    }
    if (assertionErrors.length) throw new Error(`index post-build assertions failed: ${assertionErrors.join('; ')}`)
  }

  const catalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    space_id: spaceId,
    lens_registry_hash: registry.registry_hash,
    project_context_hash: spaceId === 'self' ? null : options.expectedProjectContextHash || null,
    generated_at: new Date().toISOString(),
    sources,
    ignored_sources
  }

  const val = validateCatalogSchema(catalog)
  if (!val.valid) throw new Error(`catalog schema validation failed: ${val.errors.join('; ')}`)

  ensureDir(catalogRoot(rootDir))
  atomicWriteFile(catPath, JSON.stringify(catalog, null, 2) + '\n')
  return { catalog, fresh: false, skippedSecrets, warnings, catalog_reads: catalogReads }
}
let CONTRIB_CATALOG_CACHE = null
export function ensureContribPartition(packageRoot, registry, selfRoot = null) {
  const catPath = selfRoot ? join(catalogRoot(selfRoot), 'contrib.json') : null
  if (CONTRIB_CATALOG_CACHE && CONTRIB_CATALOG_CACHE.lens_registry_hash === registry.registry_hash) {
    if (catPath) {
      let needWrite = !existsSync(catPath)
      if (!needWrite) {
        try {
          const onDisk = JSON.parse(readFileSync(catPath, 'utf8'))
          if (onDisk.lens_registry_hash !== registry.registry_hash) needWrite = true
        } catch {
          needWrite = true
        }
      }
      if (needWrite) {
        try {
          ensureDir(dirname(catPath))
          atomicWriteFile(catPath, JSON.stringify(CONTRIB_CATALOG_CACHE, null, 2) + '\n')
        } catch {}
      }
    }
    return { ...CONTRIB_CATALOG_CACHE, catalog: CONTRIB_CATALOG_CACHE, fresh: true, catalog_reads: 0 }
  }
  let metaCatalog
  try {
    metaCatalog = JSON.parse(readFileSync(join(packageRoot, 'contribs', 'catalog.json'), 'utf8'))
  } catch {
    const emptyCat = {
      schema_version: CATALOG_SCHEMA_VERSION,
      space_id: 'contrib',
      lens_registry_hash: registry.registry_hash,
      project_context_hash: null,
      generated_at: new Date().toISOString(),
      sources: []
    }
    return { ...emptyCat, catalog: emptyCat, fresh: true, catalog_reads: 0 }
  }

  if (catPath && existsSync(catPath)) {
    try {
      const onDisk = JSON.parse(readFileSync(catPath, 'utf8'))
      const val = validateCatalogSchema(onDisk)
      if (val.valid && onDisk.space_id === 'contrib' && onDisk.lens_registry_hash === registry.registry_hash) {
        const known = new Map(onDisk.sources.map(s => [s.file, s]))
        let isFresh = true
        const validEntries = []
        for (const entry of metaCatalog.contribs || []) {
          const rel = `contribs/${entry.path}`
          const filePath = join(packageRoot, 'contribs', entry.path)
          if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile()) continue
          validEntries.push(rel)
          const sOld = known.get(rel)
          if (!sOld) {
            isFresh = false
            break
          }
          let st
          try {
            st = getStatTuple(filePath)
          } catch {
            isFresh = false
            break
          }
          if (sOld.size !== st.size || sOld.mtime_ns !== st.mtime_ns || sOld.ino !== st.ino || sOld.dev !== st.dev) {
            isFresh = false
            break
          }
        }
        if (isFresh && onDisk.sources.length === validEntries.length) {
          CONTRIB_CATALOG_CACHE = onDisk
          return { ...onDisk, catalog: onDisk, fresh: true, catalog_reads: 0 }
        }
      }
    } catch {}
  }

  let catalogReads = 0
  const sources = []
  for (const entry of metaCatalog.contribs || []) {
    const filePath = join(packageRoot, 'contribs', entry.path)
    if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile()) continue
    catalogReads++
    const sourceRead = readSourceWithStat(filePath)
    if (!sourceRead) continue
    const { text, stat } = sourceRead
    const sourceTextHash = hash(text)
    const rel = `contribs/${entry.path}`,
      sRef = sourceRef('contrib', rel, sourceTextHash, null)
    const declaredLenses = ['general', 'professional', 'technical', 'leadership', 'public-voice', 'interview', 'private'],
      sensitivity = entry.sensitivity || 'none'
    const policy = {
      access_lenses: declaredLenses,
      disclosure: 'internal-only',
      sensitivity,
      document_role: 'policy',
      publication_allowed: false,
      task_include: [],
      task_exclude: [],
      visibility: 'linked-projects',
      read_scope: 'shared',
      field_visibility: {},
      knowledge_status: 'current',
      temporal_scope: 'timeless',
      valid_until_epoch_ms: null,
      contrib: { id: entry.id, title: entry.title, domain: entry.domain, type: entry.type }
    }
    const rawSections = sections(text),
      seenSlugs = new Map()
    const catalogSections = rawSections.map(sec => {
      const baseSlug = slugHeading(sec.heading)
      const count = (seenSlugs.get(baseSlug) || 0) + 1
      seenSlugs.set(baseSlug, count)
      const section_id = count === 1 ? baseSlug : `${baseSlug}-${count}`
      const snippet = (sec.content.length > 360 ? sec.content.slice(0, 357) + '...' : sec.content).trim()
      return { section_id, heading: sec.heading, visibility: 'linked-projects', disclosure: 'internal-only', claim: false, snippet }
    })
    sources.push({
      source_kind: 'contrib',
      source_ref: sRef,
      file: rel,
      size: stat.size,
      modified_ms: stat.modified_ms,
      mtime_ns: stat.mtime_ns,
      ino: stat.ino,
      dev: stat.dev,
      source_text_hash: sourceTextHash,
      frontmatter: policy,
      sections: catalogSections,
      claims: [],
      tags: [],
      links: [],
      estimated_tokens: Math.ceil(text.length / 4)
    })
  }
  sources.sort((a, b) => canonicalSort(a.file, b.file))
  const catalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    space_id: 'contrib',
    lens_registry_hash: registry.registry_hash,
    project_context_hash: null,
    generated_at: new Date().toISOString(),
    sources
  }
  const val = validateCatalogSchema(catalog)
  if (!val.valid) throw new Error(`contrib catalog schema validation failed: ${val.errors.join('; ')}`)
  if (catPath) {
    try {
      ensureDir(dirname(catPath))
      atomicWriteFile(catPath, JSON.stringify(catalog, null, 2) + '\n')
    } catch {}
  }
  CONTRIB_CATALOG_CACHE = catalog
  return { ...catalog, catalog: catalog, fresh: false, catalog_reads: catalogReads }
}
export function ensureCatalog(selfRoot, projectDir, link, registry, options = {}) {
  if (projectDir) {
    try {
      purgeLegacyIndex(projectDir)
    } catch (err) {
      if (err.code === 'LEGACY_INDEX_PURGE_FAILED') throw err
    }
  }
  const selfFiles = canonicalFiles(selfRoot, { includeHistory: true })
  const selfResult = ensureCatalogPartition('self', selfRoot, selfFiles, registry, options)

  let projectResult = null
  if (projectDir && existsSync(projectDir) && resolve(projectDir) !== resolve(selfRoot)) {
    const projectFiles = [] // Domain indexing belongs to the domain project.
    const expectedProjectContextHash = link?.project_context ? hash(canonicalJson(link.project_context)) : null
    projectResult = ensureCatalogPartition(canonicalSpaceId(projectDir), projectDir, projectFiles, registry, {
      ...options,
      link,
      expectedProjectContextHash
    })
  }
  const contribResult = ensureContribPartition(PACKAGE_ROOT, registry, selfRoot)

  const federated = []
  const unreachable_spaces = []
  let fedSkippedSecrets = 0,
    fedCatalogReads = 0
  let allFresh = selfResult.fresh && (!projectResult || projectResult.fresh) && Boolean(contribResult.fresh)
  const fedWarnings = []

  return {
    self: selfResult.catalog,
    project: projectResult ? projectResult.catalog : null,
    contrib: contribResult.catalog || contribResult,
    federated,
    unreachable_spaces: [...new Set(unreachable_spaces)].sort(),
    fresh: allFresh,
    skippedSecrets: selfResult.skippedSecrets + (projectResult?.skippedSecrets || 0) + fedSkippedSecrets,
    warnings: [...selfResult.warnings, ...(projectResult?.warnings || []), ...fedWarnings],
    catalog_reads: selfResult.catalog_reads + (projectResult?.catalog_reads || 0) + (contribResult?.catalog_reads || 0) + fedCatalogReads
  }
}
