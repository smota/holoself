import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMAND_FLAGS } from '../src/cli/args.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const bin = join(root, 'bin', 'holoself.mjs')
const START_MARKER = '<!-- generated:start -->'
const END_MARKER = '<!-- generated:end -->'

function runBin(args, options = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    ...options
  })
  if (result.status !== 0) {
    throw new Error(`holoself ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

export function queryLiveCapabilitiesAndTools() {
  const capabilities = JSON.parse(runBin(['capabilities', '--json']))
  const tempRoot = mkdtempSync(join(tmpdir(), 'holoself-ref-'))
  const selfDir = join(tempRoot, 'self')
  const projectDir = join(tempRoot, 'project')
  try {
    mkdirSync(projectDir, { recursive: true })
    // The throwaway self is registered in a throwaway self map, never in the user's configuration directory.
    const env = { ...process.env, HOLOSELF_CONFIG_DIR: join(tempRoot, 'config') }
    runBin(['init', '--root', selfDir], { env })
    runBin(['link', 'add', '--project', projectDir, '--self', selfDir, '--lens', 'professional', '--no-activate', '--yes'], { env })
    const rpcInput =
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'docs-ref', version: '1' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
      ]
        .map(msg => JSON.stringify(msg))
        .join('\n') + '\n'
    const mcpStdout = runBin(['mcp', '--project', projectDir], { input: rpcInput, env })
    const lines = mcpStdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line))
    const listResponse = lines.find(line => line.id === 2)
    if (!listResponse?.result?.tools) {
      throw new Error('MCP tools/list did not return a tools array')
    }
    return { capabilities, tools: listResponse.result.tools }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

export function renderCliReferenceBlock(capabilities) {
  const rows = Object.entries(COMMAND_FLAGS)
    .filter(([cmd]) => cmd !== '')
    .map(([cmd, flags]) => {
      const formattedFlags = flags.length ? flags.map(flag => `\`${flag}\``).join(', ') : '_(none)_'
      return `| \`${cmd}\` | ${formattedFlags} |`
    })

  return [
    START_MARKER,
    `Generated from \`holoself capabilities --json\` (product \`${capabilities.product}\`, version \`${capabilities.version}\`, context schema \`v${capabilities.contextSchemaVersion}\`, index schema \`v${capabilities.indexSchemaVersion}\`, proposal schemas \`${capabilities.proposalSchemaVersions.map(v => `v${v}`).join(', ')}\`) and the CLI flag contract:`,
    '',
    `- Capability command groups (${capabilities.commands.length}): ${capabilities.commands.map(c => `\`${c}\``).join(', ')}`,
    `- Coaching subcommands (${capabilities.coaching.commands.length}): ${capabilities.coaching.commands.map(c => `\`coaching ${c}\``).join(', ')}`,
    `- Context features: ${capabilities.contextFeatures.map(f => `\`${f}\``).join(', ')}`,
    `- MCP tools (${capabilities.mcp.tools.length}): ${capabilities.mcp.tools.map(t => `\`${t}\``).join(', ')}`,
    '',
    '| Command | Accepted flags |',
    '|---|---|',
    ...rows,
    END_MARKER
  ].join('\n')
}

export function renderMcpToolsBlock(tools) {
  const rows = tools.map(tool => {
    const mode = tool.annotations?.readOnlyHint ? 'Read-only' : 'Project-local write'
    const props = Object.keys(tool.inputSchema?.properties || {})
    const reqSet = new Set(tool.inputSchema?.required || [])
    const required = props.filter(p => reqSet.has(p)).map(p => `\`${p}\``).join(', ') || '_(none)_'
    const optional = props.filter(p => !reqSet.has(p)).map(p => `\`${p}\``).join(', ') || '_(none)_'
    return `| \`${tool.name}\` | ${mode} | ${required} | ${optional} | ${tool.description} |`
  })

  return [
    START_MARKER,
    '| Tool | Mode | Required inputs | Optional inputs | Description |',
    '|---|---|---|---|---|',
    ...rows,
    END_MARKER
  ].join('\n')
}

export function replaceGeneratedBlock(text, block, fileLabel) {
  const start = text.indexOf(START_MARKER)
  const end = text.indexOf(END_MARKER)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${fileLabel} is missing ${START_MARKER} ... ${END_MARKER} markers`)
  }
  return text.slice(0, start) + block + text.slice(end + END_MARKER.length)
}

export function buildExpectedReferenceFiles() {
  const { capabilities, tools } = queryLiveCapabilitiesAndTools()
  const cliPath = join(root, 'docs', 'reference', 'cli.md')
  const mcpPath = join(root, 'docs', 'reference', 'mcp-tools.md')
  const cliCurrent = readFileSync(cliPath, 'utf8')
  const mcpCurrent = readFileSync(mcpPath, 'utf8')
  const cliExpected = replaceGeneratedBlock(cliCurrent, renderCliReferenceBlock(capabilities), 'docs/reference/cli.md')
  const mcpExpected = replaceGeneratedBlock(mcpCurrent, renderMcpToolsBlock(tools), 'docs/reference/mcp-tools.md')
  return {
    capabilities,
    tools,
    cliPath,
    mcpPath,
    cliCurrent,
    mcpCurrent,
    cliExpected,
    mcpExpected
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { cliPath, mcpPath, cliExpected, mcpExpected } = buildExpectedReferenceFiles()
  writeFileSync(cliPath, cliExpected, 'utf8')
  writeFileSync(mcpPath, mcpExpected, 'utf8')
  console.log('[ok] updated generated reference blocks in docs/reference/cli.md and docs/reference/mcp-tools.md')
}
