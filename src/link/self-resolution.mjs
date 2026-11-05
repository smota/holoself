// The single resolver from a project's link.yaml self reference to a self root on this machine
// (docs/decisions/portable-links.md, section 4). Every reader of link.yaml goes through resolveLinkedSelf.
//
// A legacy link (only `self_context.path`) resolves exactly as before: the path relative to the project, unverified.
// A link with `self_context.self_id` accepts a candidate only when it is a canonical self whose config.json carries the
// same self_id, trying in order: an explicit --self/--root (a mismatch is refused), HOLOSELF_HOME (a mismatch is
// skipped), the per-machine self map, then a legacy `path` if present. Nothing matching fails closed with SELF_NOT_FOUND.
import { resolve } from 'node:path'
import { isCanonicalSelf, isProjectKey, isSelfId, selfIdOf, selfMapEntry } from './machine.mjs'
import { safeRealpath } from '../shared/fs.mjs'

const resolutionError = (message, code) => Object.assign(new Error(message), { code })

// The self reference carried by a parsed link.yaml: { selfId, legacyPath, projectKey } (absent values are null).
export function linkSelfReference(parsed) {
  const selfContext = parsed?.self_context && typeof parsed.self_context === 'object' ? parsed.self_context : {}
  return {
    selfId: isSelfId(selfContext.self_id) ? selfContext.self_id : null,
    legacyPath: typeof selfContext.path === 'string' && selfContext.path.trim() ? selfContext.path : null,
    projectKey: isProjectKey(parsed?.project_key) ? parsed.project_key : null
  }
}

// mapDiagnostics explain an unusable self map (malformed, unsafe, stale entry); they carry no paths. Hook mode prints no
// error text at all, so they only reach the CLI and path-redacted MCP errors.
export function selfNotFoundError(selfId, mapDiagnostics = []) {
  return resolutionError(
    `self ${selfId} has no checkout registered on this machine; run 'holoself machine register --root <dir>' or 'holoself link setup'` +
      (mapDiagnostics.length ? ` (${mapDiagnostics.join('; ')})` : ''),
    'SELF_NOT_FOUND'
  )
}

// Returns { path, source, diagnostics } where source is explicit | env | map | legacy-path.
export function resolveLinkedSelf({ project, selfId = null, legacyPath = null, explicitSelf = null, env = process.env }) {
  if (!selfId) {
    if (!legacyPath) throw resolutionError('link configuration has neither self_context.self_id nor self_context.path', 'LINK_INVALID')
    return { path: resolve(project, legacyPath), source: 'legacy-path', diagnostics: [] }
  }
  const diagnostics = [],
    matches = candidate => isCanonicalSelf(candidate) && selfIdOf(candidate) === selfId
  if (explicitSelf) {
    const candidate = resolve(explicitSelf)
    if (!matches(candidate)) throw resolutionError('supplied self root does not match canonical link root', 'SELF_ROOT_NOT_CANONICAL')
    return { path: safeRealpath(candidate), source: 'explicit', diagnostics }
  }
  const home = typeof env.HOLOSELF_HOME === 'string' && env.HOLOSELF_HOME.trim() ? resolve(env.HOLOSELF_HOME) : null
  if (home && matches(home)) return { path: safeRealpath(home), source: 'env', diagnostics }
  if (home) diagnostics.push('HOLOSELF_HOME is not the self this link names; skipped')
  const mapped = selfMapEntry(selfId, env),
    mapDiagnostics = [...mapped.diagnostics]
  if (mapped.entry && !matches(mapped.entry.path)) mapDiagnostics.push('the self map entry is stale: its path is missing or its config.json carries another id')
  diagnostics.push(...mapDiagnostics)
  if (mapped.entry && !mapDiagnostics.length) return { path: safeRealpath(mapped.entry.path), source: 'map', diagnostics }
  if (legacyPath) {
    const candidate = resolve(project, legacyPath)
    if (matches(candidate)) return { path: safeRealpath(candidate), source: 'legacy-path', diagnostics }
  }
  throw Object.assign(selfNotFoundError(selfId, mapDiagnostics), { diagnostics })
}
