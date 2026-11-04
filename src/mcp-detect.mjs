// Detects which MCP-capable clients are installed or used for a project, without running them: a client is detected
// when its executable is on PATH (same lookup as the harness detector, including Windows PATHEXT) or the project
// already carries its configuration (directory, instruction file or MCP file). Nothing is spawned or written.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { safeProjectFile } from './adapters/registry.mjs'
import { executablesOnPath } from './harnesses.mjs'

export const MCP_CLIENTS = Object.freeze({
  codex: { name: 'Codex', executables: ['codex'], evidence: ['.codex', 'CODEX.md', 'codex.md'] },
  agy: { name: 'AGY', executables: ['agy'], evidence: ['.agents/mcp_config.json', '.agy', 'AGY.md'] },
  claude: { name: 'Claude Code', executables: ['claude'], evidence: ['.claude', '.mcp.json', 'CLAUDE.md'] }
})

function projectEvidence(project, rels) {
  return rels.filter(rel => {
    try {
      return existsSync(safeProjectFile(project, rel, 'MCP client detection'))
    } catch {
      return false
    }
  })
}
export function detectMcpClients(projectInput, { env = process.env, platform = process.platform } = {}) {
  const project = resolve(projectInput)
  return Object.entries(MCP_CLIENTS).map(([id, client]) => {
    const executable = client.executables.flatMap(name => executablesOnPath(name, env, platform))[0] || null,
      evidence = projectEvidence(project, client.evidence),
      detectedBy = [...(executable ? ['path'] : []), ...(evidence.length ? ['project'] : [])]
    return { platform: id, name: client.name, detected: detectedBy.length > 0, detected_by: detectedBy, executable, project_evidence: evidence }
  })
}
