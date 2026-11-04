// Self-root and project validation: catalog build warnings and ecosystem validation errors.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { loadLensRegistry, resolveLens } from '../lenses.mjs'
import { readLink } from '../link/config.mjs'
import { canonicalFiles, markdownFiles, projectMarkdownFiles } from '../markdown/files.mjs'
import { CLAIM_MARKER_RE, claimMarkerProblems, normalize, parseClaimBlocks } from '../markdown/claim-blocks.mjs'
import { canonicalClaims } from '../markdown/text.mjs'
import { canonicalPath, samePath } from '../path-guard.mjs'
import { discoverPolicyFiles, resolveDocumentPolicy } from '../policy/policy-defaults.mjs'
import { canonicalPrivacyMetadataErrors, frontmatter } from '../policy/privacy-fields.mjs'
import { readProposal } from '../proposals/store.mjs'
import { slash } from '../shared/fs.mjs'
import { redactRootPaths } from '../shared/redact.mjs'
import { buildCatalogSource } from './source.mjs'

export function catalogBuildWarnings(root, project = null) {
  const warnings = []
  let rootRegistry = null
  if (existsSync(root)) {
    try {
      rootRegistry = loadLensRegistry(root)
    } catch {}
  }
  const scanFiles = (base, files, sourceKind, registry, tolerant) => {
    for (const file of files) {
      const rel = slash(relative(base, file))
      let built
      try {
        built = buildCatalogSource(file, sourceKind, base, registry, tolerant)
      } catch (err) {
        built = { unreadable: true, error: `${rel}: unreadable (${err.message})` }
      }
      if (built?.error) warnings.push(redactRootPaths(built.error, [base, root, project]))
    }
  }
  if (existsSync(root) && rootRegistry) {
    for (const p of discoverPolicyFiles(root, rootRegistry)) {
      if (!p.valid && p.error) warnings.push(redactRootPaths(p.error, [root, project]))
    }
    scanFiles(root, canonicalFiles(root, { includeHistory: true }), 'canonical', rootRegistry, false)
  }
  if (project && existsSync(project) && !samePath(canonicalPath(project), canonicalPath(root))) {
    try {
      const link = readLink(project, { tolerant: true }),
        registry = rootRegistry || loadLensRegistry(link.path)
      scanFiles(project, projectMarkdownFiles(project, link), 'project', registry, true)
    } catch {}
  }
  return [...new Set(warnings)]
}
export function ecosystemValidationErrors(root, project = null) {
  const errors = []
  let rootRegistry = null
  if (existsSync(root)) {
    try {
      rootRegistry = loadLensRegistry(root)
    } catch (error) {
      errors.push(error.message)
    }
  }
  const checkMarkdown = (base, registry = rootRegistry) => {
    for (const path of markdownFiles(base)) {
      const text = readFileSync(path, 'utf8'),
        rel = slash(relative(base, path))
      let metadata = {}
      try {
        metadata = frontmatter(text, { registry }).metadata
      } catch (error) {
        errors.push(`${error.message}: ${rel}`)
      }
      const isCanonicalPolicyDir = /^(?:profile|context|topics|history|reference)\//.test(rel)
      const resolved = isCanonicalPolicyDir ? resolveDocumentPolicy(path, base, metadata, registry) : null
      if (resolved?.policyErrors?.length) {
        for (const pErr of resolved.policyErrors) {
          const redacted = redactRootPaths(pErr, [base, root, project])
          if (!errors.includes(redacted)) errors.push(redacted)
        }
      }
      const effectiveMetadata = resolved ? resolved.effectiveMetadata : metadata
      const canonicalContent = /^(?:profile|context|topics)\//.test(rel)
      if (canonicalContent) for (const error of canonicalPrivacyMetadataErrors(effectiveMetadata, registry)) errors.push(`${error}: ${rel}`)
      if (effectiveMetadata.visibility && !VISIBILITIES.includes(effectiveMetadata.visibility))
        errors.push(`invalid visibility ${effectiveMetadata.visibility}: ${rel}`)
      if (metadata.field_visibility !== undefined && (typeof metadata.field_visibility !== 'object' || Array.isArray(metadata.field_visibility)))
        errors.push(`field_visibility must be a mapping: ${rel}`)
      else
        for (const value of Object.values(metadata.field_visibility || {}))
          if (!VISIBILITIES.includes(value)) errors.push(`invalid field visibility ${value}: ${rel}`)
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)/g))
        if (!/^(?:https?:|mailto:)/.test(match[1]) && !existsSync(resolve(dirname(path), match[1]))) errors.push(`broken reference ${match[1]}: ${rel}`)
      if (CLAIM_MARKER_RE.test(text)) {
        const claimIds = new Set()
        for (const problem of claimMarkerProblems(text)) errors.push(`${problem}: ${rel}`)
        for (const block of parseClaimBlocks(text, rel)) {
          if (block.attrs.id && claimIds.has(block.attrs.id)) errors.push(`duplicate claim id ${block.attrs.id}: ${rel}`)
          if (block.attrs.id) claimIds.add(block.attrs.id)
        }
      }
      const generated = metadata.generated_from
      if (Array.isArray(generated)) {
        for (const source of generated) {
          const sourcePath = resolve(base, source)
          if (!existsSync(sourcePath)) errors.push(`broken generated source ${source}: ${rel}`)
          else if (statSync(sourcePath).mtimeMs > statSync(path).mtimeMs) errors.push(`stale generated view: ${rel}`)
        }
      }
    }
    const claimsPath = join(base, 'context', 'claims.md')
    if (existsSync(claimsPath)) {
      const seen = new Set()
      for (const claim of canonicalClaims(readFileSync(claimsPath, 'utf8'))) {
        const key = normalize(claim)
        if (seen.has(key)) errors.push(`duplicate canonical claim: ${claim}`)
        seen.add(key)
      }
    }
  }
  if (existsSync(root) && rootRegistry) {
    for (const p of discoverPolicyFiles(root, rootRegistry)) {
      if (!p.valid && p.error) errors.push(redactRootPaths(p.error, [root, project]))
    }
    checkMarkdown(root)
  }
  const proposalRoots = [join(root, 'proposals')]
  if (project) {
    try {
      const link = readLink(project)
      if (!existsSync(link.path)) errors.push(`broken self path: ${link.path}`)
      else if (!existsSync(join(link.path, 'profile')) || !existsSync(join(link.path, 'context')))
        errors.push(`self path lacks profile/context layout: ${link.path}`)
      if (link.access !== 'read') errors.push('link access must be read')
      if (link.proposals !== 'enabled' && link.proposals !== 'disabled') errors.push(`invalid proposals mode: ${link.proposals}`)
      if (link.index !== 'local') errors.push(`link index must be local: ${link.index}`)
      const registry = loadLensRegistry(link.path)
      try {
        resolveLens(registry, link.default_lens)
      } catch {
        errors.push(`invalid default lens: ${link.default_lens}`)
      }
      for (const lens of link.secondary_lenses || [])
        try {
          resolveLens(registry, lens)
        } catch {
          errors.push(`invalid secondary lens: ${lens}`)
        }
    } catch (error) {
      errors.push(error.message)
    }
    proposalRoots.push(join(project, '.holoself', 'proposals'))
  }
  for (const base of proposalRoots) {
    if (!existsSync(base)) continue
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.yaml')) {
          try {
            readProposal(path)
          } catch (error) {
            errors.push(`${slash(relative(base, path))}: ${error.message}`)
          }
        }
      }
    }
    walk(base)
  }
  return errors
}
export function policyProvenanceSummary(root) {
  if (!root || !existsSync(root)) return []
  let registry = null
  try {
    registry = loadLensRegistry(root)
  } catch {
    return []
  }
  const policies = discoverPolicyFiles(root, registry)
  if (policies.length === 0) return []
  const lines = []
  for (const path of markdownFiles(root)) {
    const rel = slash(relative(root, path))
    if (!/^(?:profile|context|topics|history|reference)\//.test(rel)) continue
    let metadata = {}
    try {
      metadata = frontmatter(readFileSync(path, 'utf8'), { registry }).metadata
    } catch {
      continue
    }
    const resolved = resolveDocumentPolicy(path, root, metadata, registry)
    const entries = Object.entries(resolved.policySources || {})
    if (entries.some(([field, src]) => src.startsWith('policy:') || field === 'policy_skipped')) {
      const formatted = entries.map(([field, src]) => `${field}=${src}`).join(', ')
      lines.push(`[policy] ${rel}: ${formatted}`)
    }
  }
  return lines
}
