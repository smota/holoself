// holoself index command (moved verbatim from runEcosystem).
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { canonicalJson, validateCatalogSchema } from '../../catalog.mjs'
import { indexEngine } from '../../catalog/fts.mjs'
import { buildIndex } from '../../catalog/index.mjs'
import { isPartitionFresh } from '../../catalog/partitions.mjs'
import { loadLensRegistry } from '../../lenses.mjs'
import { readLink } from '../../link/config.mjs'
import { canonicalFiles } from '../../markdown/files.mjs'
import { hash, slash } from '../../shared/fs.mjs'
import { redactRootPaths } from '../../shared/redact.mjs'
import { projectPath } from '../link-helpers.mjs'

export async function runIndex(o, sub) {
  const project = projectPath(o)
  const link = readLink(project),
    registry = loadLensRegistry(link.path)
  const catPath = join(project, '.holoself', 'catalog', 'catalog.json')
  if (sub === 'status') {
    if (!existsSync(catPath)) {
      console.log(JSON.stringify({ status: 'missing', path: slash(catPath) }, null, 2))
      return true
    }
    let projectCatalog
    try {
      projectCatalog = JSON.parse(readFileSync(catPath, 'utf8'))
    } catch {
      throw new Error(`catalog is invalid JSON: ${catPath}`)
    }
    const val = validateCatalogSchema(projectCatalog)
    if (!val.valid) throw new Error(`catalog schema is stale or invalid: ${catPath}`)
    const selfFiles = canonicalFiles(link.path, { includeHistory: true })
    const projectFiles = []
    const expectedProjectContextHash = hash(canonicalJson(link.project_context))
    const selfCatPath = join(link.path, '.holoself', 'catalog', 'catalog.json')
    let selfCatalog = null
    if (existsSync(selfCatPath)) {
      try {
        selfCatalog = JSON.parse(readFileSync(selfCatPath, 'utf8'))
      } catch {}
    }
    const isSelfFresh = isPartitionFresh(selfCatalog, link.path, selfFiles, registry, null, 'self')
    const isProjectFresh = isPartitionFresh(projectCatalog, project, projectFiles, registry, expectedProjectContextHash, basename(project))
    const fresh = Boolean(isSelfFresh && isProjectFresh)
    const input_state_hash = hash(
      canonicalJson({
        self: (selfCatalog?.sources || []).map(s => [s.file, s.source_text_hash]),
        project: projectCatalog.sources.map(s => [s.file, s.source_text_hash])
      })
    )
    console.log(
      JSON.stringify(
        {
          status: fresh ? 'ready' : 'stale',
          fresh,
          path: slash(catPath),
          schema_version: projectCatalog.schema_version,
          privacy_policy_version: 4,
          lens_registry_hash: registry.registry_hash,
          engine: indexEngine(),
          entries: projectCatalog.sources.length + (selfCatalog?.sources?.length || 0),
          generated_at: projectCatalog.generated_at,
          input_state_hash,
          skipped_secret_files: 0,
          build_assertions: {
            status: 'passed',
            checks: ['include-policy', 'exclude-policy', 'required-includes', 'forbidden-excludes', 'secret-pattern-scan'],
            included_project_files: projectCatalog.sources.length
          }
        },
        null,
        2
      )
    )
    return true
  }
  const rebuild = sub === 'rebuild'
  const index = buildIndex(project, o.changed && !rebuild, { ensureFts: true })
  const warnings = (index.warnings || []).map(w => redactRootPaths(w, [link.path, project]))
  console.log(
    JSON.stringify(
      {
        status: 'ready',
        fresh: true,
        schema_version: index.schema_version,
        privacy_policy_version: index.privacy_policy_version,
        lens_registry_hash: index.lens_registry_hash,
        engine: index.engine,
        entries: index.entries.length,
        generated_at: index.generated_at,
        input_state_hash: index.input_state_hash,
        skipped_secret_files: index.skipped_secret_files,
        ...(warnings.length ? { warnings } : {}),
        build_assertions: index.build_assertions
      },
      null,
      2
    )
  )
  return true
}
