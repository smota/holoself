// Opt-in pre-approval of the read-only Holoself MCP tools (`--approve-read-tools`), per host. Never the default and
// never holoself_proposal_create. Holoself records exactly which entries it added and removes only those.
//   claude: project `.claude/settings.local.json` permissions.allow (per-machine file, same surgery as the hook)
//   codex:  per-tool `approval_mode = "approve"` tables inside the Holoself-managed block of `.codex/config.toml`
//   agy:    documented only; AGY 1.5.0 reads permissions from the user-global settings file or per-session --settings
import { READ_ONLY_TOOLS } from '../mcp-config.mjs'
import { fileModeOr } from '../shared/fs.mjs'
import { parseHookSettings, readHookSettings } from './hooks.mjs'
import { safeProjectFile } from './registry.mjs'

export const CLAUDE_APPROVAL_FILE = '.claude/settings.local.json'
export const claudeReadToolRules = () => READ_ONLY_TOOLS.map(tool => `mcp__holoself__${tool}`)
export const agyReadToolSettings = () => ({ permissions: { allow: READ_ONLY_TOOLS.map(tool => `mcp(holoself/${tool})`) } })

export function readApprovalMechanism(id) {
  if (id === 'claude') return { mechanism: 'project-settings', file: CLAUDE_APPROVAL_FILE, key: 'permissions.allow', entries: claudeReadToolRules() }
  if (id === 'codex') return { mechanism: 'managed-block', file: '.codex/config.toml', key: 'mcp_servers.holoself.tools.<tool>.approval_mode', entries: [...READ_ONLY_TOOLS] }
  return {
    mechanism: 'documented-only',
    file: null,
    reason:
      'AGY 1.5.0 reads permissions only from ~/.gemini/antigravity-cli/settings.json or per-session --settings; Holoself does not write user-global settings.',
    example: `agy --settings '${JSON.stringify(agyReadToolSettings())}'`
  }
}

// Next content of the Claude settings file. `base` ({ text, exists }) lets a caller chain this edit after another edit
// of the same file (the session-start hook) inside one transaction; otherwise the file is read from disk.
// install=true adds missing read-tool rules; install=false removes only the rules in `added`.
export function claudeApprovalChange(project, install, { added = [], createdFile = false, createdContainers = null, base = null } = {}) {
  const path = safeProjectFile(project, CLAUDE_APPROVAL_FILE, 'MCP approval settings'),
    read = base ? (base.text === null ? parseHookSettings('', false) : parseHookSettings(base.text, base.exists !== false)) : readHookSettings(path)
  if (read.unsafe) throw new Error(`${CLAUDE_APPROVAL_FILE}: unsafe approval settings (not a regular file)`)
  if (read.invalid) throw new Error(`${CLAUDE_APPROVAL_FILE}: invalid approval settings (${read.invalid})`)
  const permissions = read.config.permissions
  if (permissions !== undefined && (!permissions || Array.isArray(permissions) || typeof permissions !== 'object'))
    throw new Error(`${CLAUDE_APPROVAL_FILE}: permissions must be an object`)
  const allow = permissions?.allow
  if (allow !== undefined && !Array.isArray(allow)) throw new Error(`${CLAUDE_APPROVAL_FILE}: permissions.allow must be an array`)
  const before = read.text,
    current = allow || [],
    rules = claudeReadToolRules(),
    shape = { path, file: CLAUDE_APPROVAL_FILE, before, existed: read.exists, mode: fileModeOr(path, 0o600) }
  if (install) {
    const missing = rules.filter(rule => !current.includes(rule)),
      kept = added.filter(rule => rules.includes(rule) && current.includes(rule)),
      created = createdContainers ?? [...(permissions === undefined ? ['permissions'] : []), ...(allow === undefined ? ['allow'] : [])]
    if (!missing.length) return { ...shape, after: before, action: 'unchanged', added: kept, createdContainers: created }
    const next = { ...read.config, permissions: { ...(permissions || {}), allow: [...current, ...missing] } }
    return {
      ...shape,
      after: JSON.stringify(next, null, 2) + '\n',
      action: read.exists ? 'update' : 'create',
      added: [...new Set([...kept, ...missing])],
      createdContainers: created
    }
  }
  const created = createdContainers ?? [],
    owned = added.filter(rule => rules.includes(rule) && current.includes(rule))
  if (!owned.length) return { ...shape, after: before, action: 'unchanged', added: [], createdContainers: created }
  const nextAllow = current.filter(rule => !owned.includes(rule)),
    nextPermissions = { ...permissions, allow: nextAllow }
  if (!nextAllow.length && created.includes('allow')) delete nextPermissions.allow
  const next = { ...read.config, permissions: nextPermissions }
  if (!Object.keys(nextPermissions).length && created.includes('permissions')) delete next.permissions
  const remove = createdFile && !Object.keys(next).length
  return { ...shape, after: remove ? null : JSON.stringify(next, null, 2) + '\n', action: remove ? 'delete' : 'remove', added: [], createdContainers: created }
}
