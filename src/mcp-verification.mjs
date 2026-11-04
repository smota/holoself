// MCP platform support levels derived only from the recorded native verification matrix
// (docs/reference/platform-verification.json, produced by `npm run smoke:mcp`). A platform is `verified`
// only when the matrix records server discovery, a passing call for every Holoself MCP tool, an unchanged
// canonical self root, and a pending project-local proposal. Anything else stays `configured`.
import { readFileSync } from 'node:fs'

export const MCP_VERIFICATION_PLATFORMS = ['claude', 'codex', 'agy']
export const MCP_VERIFICATION_TOOLS = [
  'holoself_status',
  'holoself_context',
  'holoself_context_manifest',
  'holoself_context_get',
  'holoself_search',
  'holoself_proposal_create',
  'holoself_proposal_preview'
]
const MATRIX_URL = new URL('../docs/reference/platform-verification.json', import.meta.url)

export function loadVerificationMatrix(url = MATRIX_URL) {
  try {
    const matrix = JSON.parse(readFileSync(url, 'utf8'))
    return matrix && Array.isArray(matrix.platforms) ? matrix : { platforms: [] }
  } catch {
    return { platforms: [] }
  }
}

function recordedResult(value) {
  return typeof value === 'string' ? value : value?.result
}

export function mcpPlatformSupport(matrix = loadVerificationMatrix(), { platforms = MCP_VERIFICATION_PLATFORMS, tools = MCP_VERIFICATION_TOOLS } = {}) {
  return platforms.map(platform => {
    const entry = (matrix?.platforms || []).find(item => item?.platform === platform)
    const unverified = reason => ({ platform, support: 'configured', tested_version: null, last_verified: null, approval_setting: null, evidence: reason })
    if (!entry) return unverified('No native verification recorded in docs/reference/platform-verification.json.')
    const results = Object.fromEntries(tools.map(tool => [tool, recordedResult(entry.tools?.[tool]) || 'not-run']))
    const notPassing = tools.filter(tool => results[tool] !== 'pass')
    const problems = []
    if (typeof entry.host_version !== 'string' || !entry.host_version.trim()) problems.push('no host version')
    if (typeof entry.verified_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.verified_at)) problems.push('no verification date')
    if (entry.discovery !== 'verified') problems.push('discovery not verified')
    if (entry.no_canonical_write !== true) problems.push('canonical no-write not proven')
    if (entry.pending_proposal_created !== true) problems.push('pending proposal not observed')
    if (notPassing.length) problems.push(`tools not passing: ${notPassing.map(tool => `${tool}=${results[tool]}`).join(', ')}`)
    if (problems.length) return unverified(`Recorded native run is incomplete: ${problems.join('; ')}.`)
    return {
      platform,
      support: 'verified',
      tested_version: entry.host_version,
      last_verified: entry.verified_at,
      approval_setting: entry.approval_setting || null,
      evidence: 'All Holoself MCP tools passed a recorded native smoke run with server-side audit, canonical hash check, and pending proposal check.'
    }
  })
}
