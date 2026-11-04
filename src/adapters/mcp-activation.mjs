// MCP server configuration as part of link activation. Default rule (`auto`): configure the project-local MCP entry
// for every activated host whose native MCP support is `verified` in docs/reference/platform-verification.json;
// every other host keeps the BOOTSTRAP + CLI fallback. `on` configures every activated MCP-capable host, `off` none.
// runtime.json records the policy and each installation so repair restores and deactivation removes exactly them.
import { mcpPlatformSupport } from '../mcp-verification.mjs'
import { MCP_CONFIG_FILES, MCP_PLATFORMS, mcpServerChange, writeMcpChange } from '../mcp-config.mjs'
import { CLAUDE_APPROVAL_FILE, claudeApprovalChange, readApprovalMechanism } from './mcp-approvals.mjs'

export const MCP_POLICIES = ['auto', 'on', 'off']
export const MCP_FALLBACK_REASON = 'No verified Holoself MCP integration for this host; it uses .holoself/BOOTSTRAP.md and the holoself CLI.'

export function mcpActivationEntries(adapterIds, policy, approveReadTools, supportList = mcpPlatformSupport()) {
  const support = Object.fromEntries(supportList.map(item => [item.platform, item]))
  return adapterIds
    .filter(id => MCP_PLATFORMS.includes(id))
    .map(id => {
      const record = support[id] || { support: 'configured', tested_version: null, last_verified: null },
        install = policy === 'on' || (policy === 'auto' && record.support === 'verified')
      return {
        adapter: id,
        file: MCP_CONFIG_FILES[id],
        support: record.support,
        tested_version: record.tested_version,
        last_verified: record.last_verified,
        install,
        approve_read_tools: install && approveReadTools === true,
        approval: install && approveReadTools === true ? readApprovalMechanism(id) : null,
        action: 'pending'
      }
    })
}
export function mcpFallbackAdapters(adapterIds) {
  return adapterIds.filter(id => id !== 'agents' && !MCP_PLATFORMS.includes(id)).map(adapter => ({ adapter, delivery: 'bootstrap-cli', reason: MCP_FALLBACK_REASON }))
}
function removalOptions(record) {
  return {
    createdFile: record.createdFile === true,
    createdContainers: record.createdContainers ?? null,
    createdDirs: Array.isArray(record.createdDirs) ? record.createdDirs.filter(dir => typeof dir === 'string') : []
  }
}
export function recordedMcp(runtime, id) {
  return (runtime?.mcpInstallations || []).find(item => item?.id === id) || null
}

// Server and (Claude) approval changes for one plan entry. A host that is no longer installed is cleaned up only when
// runtime.json records a Holoself installation for it. `claudeBase` chains the settings edit after the hook edit.
export function mcpEntryChanges(project, entry, record, { claudeBase = null } = {}) {
  const server = entry.install
    ? mcpServerChange(project, entry.adapter, {
        approveReadTools: entry.adapter === 'codex' && entry.approve_read_tools,
        createdContainers: record?.createdContainers ?? null
      })
    : record
      ? mcpServerChange(project, entry.adapter, { install: false, ...removalOptions(record) })
      : null
  let approval = null
  if (entry.adapter === 'claude') {
    const previous = record?.approval || null
    if (entry.approve_read_tools)
      approval = claudeApprovalChange(project, true, { added: previous?.added || [], createdContainers: previous?.createdContainers ?? null, base: claudeBase })
    else if (previous?.added?.length)
      approval = claudeApprovalChange(project, false, {
        added: previous.added,
        createdFile: previous.createdFile === true,
        createdContainers: previous.createdContainers ?? [],
        base: claudeBase
      })
  }
  return { server, approval }
}
export function applyMcpEntryChanges(changes) {
  if (changes.server) writeMcpChange(changes.server)
  if (changes.approval) writeMcpChange(changes.approval)
}
export function mcpInstallationRecord(entry, changes, previous) {
  const approval = !entry.approve_read_tools
    ? null
    : entry.adapter === 'claude'
      ? {
          mechanism: 'project-settings',
          file: CLAUDE_APPROVAL_FILE,
          added: changes.approval.added,
          createdFile: previous?.approval ? previous.approval.createdFile === true : !changes.approval.existed,
          createdContainers: changes.approval.createdContainers
        }
      : { mechanism: entry.approval.mechanism, file: entry.approval.file }
  return {
    id: entry.adapter,
    file: entry.file,
    status: 'configured',
    createdFile: previous ? previous.createdFile === true : !changes.server.existed,
    createdContainers: changes.server.createdContainers ?? null,
    createdDirs: previous ? previous.createdDirs || [] : changes.server.createdDirs || [],
    approval,
    support: entry.support,
    tested_version: entry.tested_version,
    last_verified: entry.last_verified
  }
}

// Removal of recorded installations (deactivation). Entries that cannot be removed safely are reported, not fatal.
export function mcpRemovalChanges(project, runtime, ids = null, { claudeBase = null, claudeFileCreated = false } = {}) {
  return (runtime?.mcpInstallations || [])
    .filter(record => record && MCP_PLATFORMS.includes(record.id) && (!ids || ids.includes(record.id)))
    .map(record => {
      const removal = { adapter: record.id, file: MCP_CONFIG_FILES[record.id], server: null, approval: null, messages: [] }
      try {
        removal.server = mcpServerChange(project, record.id, { install: false, ...removalOptions(record) })
      } catch (error) {
        removal.messages.push(`MCP server entry left in place: ${error.message}`)
      }
      if (record.id === 'claude' && record.approval?.added?.length)
        try {
          removal.approval = claudeApprovalChange(project, false, {
            added: record.approval.added,
            createdFile: record.approval.createdFile === true || claudeFileCreated,
            createdContainers: record.approval.createdContainers ?? [],
            base: claudeBase
          })
        } catch (error) {
          removal.approvalMessage = `MCP read-tool approvals left in place: ${error.message}; remove the mcp__holoself__ entries by hand`
        }
      return removal
    })
}
export function mcpRemovalFiles(removals) {
  return removals.flatMap(item => [...(item.server ? [item.file] : []), ...(item.approval ? [CLAUDE_APPROVAL_FILE] : [])])
}
export function applyMcpRemovals(removals, dryRun) {
  return removals.flatMap(({ adapter, file, server, approval, messages, approvalMessage }) => {
    if (!dryRun) applyMcpEntryChanges({ server, approval })
    const rows = []
    rows.push(
      server
        ? { adapter, file, kind: 'mcp-server', result: server.action === 'unchanged' ? 'unchanged' : `mcp-${server.action}` }
        : { adapter, file, kind: 'mcp-server', result: 'unremovable', message: messages.join('; ') }
    )
    if (approvalMessage) rows.push({ adapter, file: CLAUDE_APPROVAL_FILE, kind: 'mcp-read-approval', result: 'unremovable', message: approvalMessage })
    if (approval) rows.push({ adapter, file: CLAUDE_APPROVAL_FILE, kind: 'mcp-read-approval', result: approval.action === 'unchanged' ? 'unchanged' : `approval-${approval.action}` })
    return rows
  })
}
export function mcpRemovalKept(removals) {
  return new Set(removals.filter(item => !item.server || item.approvalMessage).map(item => item.adapter))
}
