import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, readlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve, relative, dirname, basename } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { ftsSupport, indexEngine } from './catalog/fts.mjs'
import {
  applyValidateFixPlan,
  buildValidateFixPlan,
  catalogBuildWarnings,
  ecosystemValidationErrors,
  excludedCanonicalDocuments,
  excludedIncompleteMetadataNotice,
  formatValidateFixPlanText,
  policyProvenanceSummary,
  runEcosystem
} from './ecosystem.mjs'
import { seedLensDefinitions } from './lenses.mjs'
import { ensureHoloselfGitignore } from './link/config.mjs'
import { VERSION } from './version.mjs'
import { mcpPlatformSupport } from './mcp-verification.mjs'
import { buildLensMigrationPlan, buildTransformationPlan, applyTransformationPlan } from './maintenance.mjs'
import { applyCleanupPlan, buildCleanupPlan } from './cleanup.mjs'
import { parse, validateFlags } from './cli/args.mjs'
import { atomicWrite, backupExport, copyMarkdownTree, ensureDir, isEcosystemMetadata, json, nextTempCounter, pathExists } from './cli/files.mjs'
import { CONTEXT_FILES, PROFILE_FILES } from './cli/templates.mjs'
import {
  applyMigration,
  assertDestinationParents,
  assertMigrationTarget,
  migrationManifest,
  migrationPlan,
  printMigrationReport
} from './cli/data-root-migration.mjs'
import { PACKAGE_ROOT } from './shared/package-root.mjs'
export { COMMAND_FLAGS, commandKey, parseArguments, validateFlags } from './cli/args.mjs'

export { VERSION } from './version.mjs'
const EXPORT_START = '<!-- holoself-export-start -->'
const EXPORT_END = '<!-- holoself-export-end -->'
const ROOT_START = '<!-- holoself-root-start -->'
const ROOT_END = '<!-- holoself-root-end -->'
function configPath(root) {
  return join(root, 'config.json')
}
function availableContribs() {
  const catalog = join(PACKAGE_ROOT, 'contribs', 'catalog.json')
  try {
    const data = JSON.parse(readFileSync(catalog, 'utf8'))
    if (data.schemaVersion !== 1 || !Array.isArray(data.contribs)) return []
    return data.contribs
      .map(entry => entry.id)
      .filter(id => existsSync(join(PACKAGE_ROOT, 'contribs', 'default', `${id}.md`)))
      .sort()
  } catch {
    return []
  }
}
const DEFAULT_CONTRIBS = availableContribs()
function selectedContribs(o, existing) {
  const selected = o.contribs || existing || DEFAULT_CONTRIBS
  const exclude = new Set(o.exclude || [])
  const unknown = [...new Set([...selected, ...exclude])].filter(id => !availableContribs().includes(id))
  if (unknown.length) throw new Error(`unknown public contrib: ${unknown.join(', ')}`)
  return [...new Set(selected)].filter(id => !exclude.has(id)).sort()
}
function readConfig(root) {
  if (!existsSync(configPath(root))) return null
  try {
    return JSON.parse(readFileSync(configPath(root), 'utf8'))
  } catch {
    return null
  }
}
function markerError(p, start = EXPORT_START, end = EXPORT_END) {
  if (!existsSync(p)) return null
  if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isFile()) return `${basename(p)} is not a regular file`
  const text = readFileSync(p, 'utf8')
  const starts = (text.match(new RegExp(start, 'g')) || []).length
  const ends = (text.match(new RegExp(end, 'g')) || []).length
  return starts === ends && starts <= 1 ? null : `${basename(p)} has malformed Holoself markers`
}
function packet(root, packetOnly = false) {
  const files = []
  for (const d of ['profile', 'context']) {
    const dir = join(root, d)
    if (!existsSync(dir)) continue
    const walk = p => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const x = join(p, e.name)
        if (e.isDirectory()) walk(x)
        else if (e.name.endsWith('.md')) files.push(relative(root, x).replaceAll('\\', '/'))
      }
    }
    walk(dir)
  }
  files.sort()
  const body = packetOnly
    ? files.map(f => `---\n\n## ${f}\n\n${readFileSync(join(root, f), 'utf8').trim()}\n`).join('\n')
    : files.map(f => `- [${f}](${f})`).join('\n')
  const note = packetOnly
    ? 'This packet is self-contained; no project-local fallback files are required.'
    : 'It is generated from local files under this project .holoself directory.'
  return `# Holoself context packet\n\nRead this packet first. ${note}\n\n${body}\n`
}
function rootSection() {
  return readFileSync(join(PACKAGE_ROOT, 'templates', 'AGENTS.md'), 'utf8')
}
function projectSection(packetOnly = false) {
  return packetOnly
    ? `${EXPORT_START}\n## Holoself context\n\nLoad .holoself/context-packet.md first. This packet is self-contained.\nDo ` +
        `not write durable context silently: propose changes and ask approval.\n${EXPORT_END}\n`
    : `${EXPORT_START}\n## Holoself context\n\nLoad .holoself/context-packet.md first.\nIf needed, read relevant files ` +
        `under .holoself/profile/ and .holoself/context/.\nDo not write durable context silently: propose changes and ` +
        `ask approval.\n${EXPORT_END}\n`
}
function inject(target, file, dryRun, section, start = EXPORT_START, end = EXPORT_END) {
  const p = join(target, file)
  const existed = pathExists(p)
  if (existed && lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a symlink; refusing to modify`)
  if (existed && !lstatSync(p).isFile()) throw new Error(`${p} is not a file; refusing to modify`)
  const old = existed ? readFileSync(p, 'utf8') : ''
  const starts = (old.match(new RegExp(start, 'g')) || []).length
  const ends = (old.match(new RegExp(end, 'g')) || []).length
  if (starts !== ends || starts > 1) throw new Error(`${p} has malformed Holoself markers; refusing to modify`)
  const re = new RegExp(`${start}[\\s\\S]*?${end}\\n?`)
  const found = starts === 1
  const next = found ? old.replace(re, section) : (old.trimEnd() ? old.trimEnd() + '\\n\\n' : '') + section
  if (!dryRun && next !== old) atomicWrite(p, next, { mode: 0o666 })
  return next === old ? 'unchanged' : found ? 'updated' : existed ? 'appended' : 'created'
}
function isHoloselfLink(p, root) {
  if (!lstatSync(p).isSymbolicLink()) return false
  try {
    return resolve(dirname(p), readlinkSync(p)) === resolve(root)
  } catch {
    return false
  }
}
function help() {
  console.log(
    `Holoself ${VERSION}\n\nUsage: holoself <command> [options]\n\nCore commands:\n  data-root | init ` +
      `| doctor | validate [--fix [--with-policy-files] [--allow-publish-approved] [--out <plan>] | --fix --apply --digest <sha256> --yes] | migrate | export | upgrade\n  web [--root <self-root>] [--project <linked-project>] ` +
      `[--port <n>] [--no-open]  Optional local Workbench\n  link --target <dir>       Legacy live data-root ` +
      `junction\n  unlink --target <dir>     Remove legacy managed junction\n\nLinked ecosystem:\n  skill ` +
      `status|install --scope user [--platform <id>] [--skill-home <dir>]\n  lens ` +
      `list|show|validate|bind|unbind|bindings [id] [--root <self-root>]\n  link ` +
      `add|status|remove|setup|activate|deactivate|repair|doctor --project <dir> [--self <dir>]\n  link deactivate ` +
      `--project <dir> [--adapters all|<list>] [--dry-run|--yes]\n  link skill migrate-global --project <dir> ` +
      `[--skill-home <dir>] [--dry-run|--yes]
  context [--project <dir>] [--lens <lens>] [--task <text>] [--need required|helpful|not-needed] ` +
      `[--session-start] [--json] [--snapshot --restricted-host --expires-hours <n>]
  ledger [--project <dir>] ` +
      `[--since <date>] [--lens <id>] [--surface <surface>] [--limit <n>] [--json]
  analyze ` +
      `overlap|conflicts|stale|all --project <dir>\n  propose --project <dir> [--claim <text> --source-file <path>]\n` +
      `  propose --project <dir> --op replace|supersede|retire --claim-id <id> --evidence <text> ` +
      `--source-file <path> [--claim <text>|--reason <text>]\n` +
      `  proposals list|audit --project <dir>\n  proposals show|approve|reject|defer|supersede <id> --project <dir>\n` +
      `  index [status|rebuild] --project <dir> [--changed]\n  search <query> --project <dir>\n  ` +
      `instructions render|audit --project <dir> [--json]\n  knowledge migrate-lenses [--output <plan>] | --apply ` +
      `<plan> --digest <sha256> --yes\n  knowledge transform --replacements <json> [--plan-kind ` +
      `section-replacement|instruction-replacement] [--output <plan>]\n  knowledge cleanup [--output <plan>] | ` +
      `--apply <plan> --digest <sha256> --yes\n\nData root: HOLOSELF_HOME or --data-dir <dir> (argument overrides ` +
      `environment).\nActivation: --activate auto|all|<list> --platform <id> --instructions <file> --install-skill ` +
      `auto|project|global|none --no-activate --hooks|--no-hooks --mcp|--no-mcp [--approve-read-tools].\nProject filters: --project-include/--project-exclude and ` +
      (`--project-assert-include/--project-assert-exclude <globs>.
Efficiency: context supports --budget small|standard|deep|unbounded, --manifest, repeatable --source, and ` +
        `--temporal current|historical|superseded|all.\nInstruction consolidation: instructions render|audit --project ` +
        `<dir>.\nSafety confirmations: --yes. Packet adapters: --adapter ` +
        `pi|claude|codex|generic|obsidian|restricted-host.\nMCP: mcp [--project <linked-project>] | mcp ` +
        `configure|status --project <dir> [--platform codex|agy|claude | --all-detected] [--force-replace].\n`)
  )
}
async function confirm(o, message) {
  if (o.yes) return true
  if (!input.isTTY || !output.isTTY) throw new Error(`${message} Re-run with --yes to confirm.`)
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${message} Type "yes" to continue: `)
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}
export async function run(argv, options = {}) {
  const o = parse(argv)
  if (process.env.NODE_TEST_CONTEXT && options?.afterConfigure) o.afterConfigure = options.afterConfigure
  validateFlags(o)
  if (o.version) {
    console.log(o.json ? JSON.stringify({ schemaVersion: 1, product: 'holoself', version: VERSION }) : `Holoself ${VERSION}`)
    return
  }
  if (o.command === 'capabilities') {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          product: 'holoself',
          version: VERSION,
          interface: 'local-cli',
          contextSchemaVersion: 1,
          commands: ['doctor', 'context', 'ledger', 'search', 'propose', 'proposals', 'instructions', 'knowledge', 'link', 'skill', 'mcp', 'coaching'],
          coaching: {
            storage: 'self-root/coaching/sessions',
            commands: ['start', 'note', 'action', 'choose', 'review', 'material', 'resume'],
            externalTextOnly: true
          },
          contextFeatures: ['need-gate', 'budgets', 'manifest', 'source-handles', 'lifecycle', 'receipts', 'task-contrib-routing'],
          proposalSchemaVersions: [1, 2],
          indexSchemaVersion: 5,
          index: {
            // selected: the engine this process ranks with (HOLOSELF_INDEX_ENGINE=json forces deterministic-json).
            engine: { selected: indexEngine(), available: ftsSupport() ? ['fts5', 'deterministic-json'] : ['deterministic-json'] }
          },
          mcp: {
            transport: 'stdio',
            projectBound: true,
            linkAuthority: true,
            tools: [
              'holoself_status',
              'holoself_context',
              'holoself_context_manifest',
              'holoself_context_get',
              'holoself_search',
              'holoself_proposal_create',
              'holoself_proposal_preview'
            ],
            platforms: mcpPlatformSupport()
          },
          globalSkillSupported: true
        },
        null,
        2
      )
    )
    return
  }
  if (!o.command || (o.help && o.command !== 'coaching')) {
    help()
    console.log(
      'Coaching: coaching start --root <self-root> --question <text>; coaching note|action|choose|review|material ' +
        '<session-id> --root <self-root> --expected-revision <n> [options]; coaching resume [session-id] --root ' +
        '<self-root>. Use coaching --help for details.'
    )
    return
  }
  const root = o.root
  if (o.command === 'coaching') {
    if (o.help) {
      console.log(
        'Coaching commands:\n  start --root <self-root> --question <text>\n  note <id> --root <self-root> ' +
          '--expected-revision <n> --kind user_report|hypothesis|intention --text <text>\n  action <id> --root ' +
          '<self-root> --expected-revision <n> --text <text>\n  choose <id> --root <self-root> --expected-revision <n> ' +
          '--action-sequence <n>\n  review <id> --root <self-root> --expected-revision <n> --outcome ' +
          'done|partial|not_done --text <text>\n  material <id> --root <self-root> --expected-revision <n> ' +
          '--material-status imported|partial|failed --source-label <label> --producer <tool-or-person> [--material-text ' +
          '<already-extracted-text>] [--limitations <text>]\n  resume [id] --root <self-root>'
      )
      return
    }
    if (!o.rootExplicit || o.project || o.self || o.target) throw new Error('coaching requires explicit --root <self-root> and no linked-project selector')
    const coaching = await import('./coaching.mjs'),
      command = o.args[0],
      id = o.args[1]
    let result
    if (command === 'start') result = coaching.start(root, o.question)
    else if (command === 'note') result = coaching.note(root, id, o.expectedRevision, o.coachingKind, o.coachingText)
    else if (command === 'action') result = coaching.action(root, id, o.expectedRevision, o.coachingText)
    else if (command === 'choose') result = coaching.choose(root, id, o.expectedRevision, o.actionSequence)
    else if (command === 'review') result = coaching.review(root, id, o.expectedRevision, o.coachingOutcome, o.coachingText)
    else if (command === 'material')
      result = coaching.material(root, id, o.expectedRevision, {
        text: o.materialText,
        status: o.materialStatus,
        sourceLabel: o.sourceLabel,
        producer: o.producer,
        limitations: o.limitations
      })
    else if (command === 'resume') result = coaching.resume(root, id)
    else throw new Error('coaching requires start, note, action, choose, review, material, or resume')
    if (readConfig(root)?.evidence) console.error('[note] existing evidence binding detected; coaching leaves it untouched and does not read or migrate it')
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (o.command === 'web') {
    const { startWebServer } = await import('./web-server.mjs')
    const app = await startWebServer({ project: o.project || process.cwd(), root: o.rootExplicit ? root : undefined, port: o.port ?? 0 })
    console.log(`Holoself Workbench: ${app.url}\nData root: ${app.root}${app.project ? `\nLinked project: ${app.project}` : ''}`)
    if (!o.noOpen) {
      const { spawn } = await import('node:child_process')
      const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const args = process.platform === 'win32' ? ['/c', 'start', '', app.url] : [app.url]
      spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    }
    return
  }
  if (o.command === 'mcp') {
    const action = o.args[0]
    if (!action) {
      const { startMcpServer } = await import('./mcp-server.mjs')
      await startMcpServer({ project: o.project, requireClaudeProject: o.claudeProjectDir })
      return
    }
    if (!o.project) throw new Error(`mcp ${action} requires --project <linked-project>`)
    const { applyMcpConfiguration, mcpConfigurationPlan, mcpConfigurationStatus } = await import('./mcp-config.mjs')
    if (action === 'status') {
      console.log(JSON.stringify(mcpConfigurationStatus(o.project, { platforms: o.platforms || [] }), null, 2))
      return
    }
    if (action !== 'configure') throw new Error('mcp requires no subcommand, status, or configure')
    if (o.allDetected && o.platforms?.length) throw new Error('--all-detected cannot be combined with --platform')
    const options = { platforms: o.platforms || [], allDetected: o.allDetected === true, forceReplace: o.forceReplace === true },
      plan = mcpConfigurationPlan(o.project, options),
      publicPlan = { ...plan, _changes: undefined }
    console.log(JSON.stringify({ configuration_plan: publicPlan }, null, 2))
    if (o.dryRun) return
    if (!plan.changes.length) {
      console.log('No MCP clients detected for this project; nothing to configure.')
      return
    }
    const replacing = plan.changes.filter(change => change.action === 'replace').map(change => change.relative)
    if (replacing.length && !o.yes && !(input.isTTY && output.isTTY))
      throw new Error(`--force-replace overwrites the existing holoself MCP server in ${replacing.join(', ')}; re-run with --yes to confirm.`)
    const question =
      `Configure local STDIO MCP files for ${plan.changes.map(change => change.platform).join(', ')} in ${o.project}` +
      `${replacing.length ? `, replacing the existing holoself server in ${replacing.join(', ')}` : ''}?`
    if (!(await confirm(o, question))) return
    console.log(JSON.stringify(applyMcpConfiguration(o.project, { ...options, expectedPlanHash: plan.plan_sha256 }), null, 2))
    return
  }
  if (o.command === 'data-root') {
    console.log(root)
    return
  }
  if (o.command === 'knowledge') {
    if (o.args[0] === 'transform' || o.args[0] === 'migrate-lenses') {
      const action = o.args[0]
      if (o.apply) {
        if (!o.yes) throw new Error('knowledge transformation --apply requires --yes')
        const plan = JSON.parse(readFileSync(resolve(o.apply), 'utf8')),
          result = applyTransformationPlan(root, plan, {
            expectedDigest: o.digest,
            validate: () => {
              const errors = ecosystemValidationErrors(root)
              if (errors.length) throw new Error(`transformation validation failed: ${errors.join('; ')}`)
            }
          })
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (action === 'transform' && !o.replacements) throw new Error('knowledge transform requires --replacements <JSON path>')
      const plan =
        action === 'migrate-lenses'
          ? buildLensMigrationPlan(root)
          : buildTransformationPlan(root, JSON.parse(readFileSync(resolve(o.replacements), 'utf8')), { kind: o.planKind || 'section-replacement' })
      if (o.output) atomicWrite(o.output, JSON.stringify(plan, null, 2) + '\n', { mode: 0o666 })
      console.log(JSON.stringify(plan, null, 2))
      return
    }
    if (o.args[0] !== 'cleanup') throw new Error('knowledge requires cleanup, transform, or migrate-lenses')
    if (o.apply) {
      if (!o.yes) throw new Error('knowledge cleanup --apply requires --yes')
      const plan = JSON.parse(readFileSync(resolve(o.apply), 'utf8')),
        result = applyCleanupPlan(root, plan, { expectedDigest: o.digest })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    const plan = buildCleanupPlan(root)
    if (o.output) {
      atomicWrite(o.output, JSON.stringify(plan, null, 2) + '\n', { mode: 0o666 })
      console.log(
        JSON.stringify({ status: 'planned', plan_path: o.output, digest: plan.digest, operations: plan.operations, review_only: plan.review_only }, null, 2)
      )
    } else console.log(JSON.stringify(plan, null, 2))
    return
  }
  if (await runEcosystem(o)) return
  if (o.command === 'init') {
    seedLensDefinitions(root)
    ensureDir(root)
    for (const name of ['context', 'topics', 'reference', 'me', 'exports', 'history']) ensureDir(join(root, name))
    for (const state of ['pending', 'approved', 'rejected', 'deferred', 'superseded']) ensureDir(join(root, 'proposals', state))
    ensureDir(join(root, 'contribs', 'local'))
    ensureDir(join(root, 'profile'))
    ensureHoloselfGitignore(root)
    ensureDir(join(root, '.holoself', 'runtime'))
    const cursorKeyPath = join(root, '.holoself', 'runtime', '.cursor.key')
    if (!existsSync(cursorKeyPath))
      try {
        writeFileSync(cursorKeyPath, randomBytes(32), { mode: 0o600 })
      } catch {}
    const ledgerKeyPath = join(root, '.holoself', 'runtime', 'ledger.key')
    if (!existsSync(ledgerKeyPath))
      try {
        writeFileSync(ledgerKeyPath, randomBytes(32), { mode: 0o600 })
      } catch {}
    if (!existsSync(join(root, 'topics', '.current'))) atomicWrite(join(root, 'topics', '.current'), '', { mode: 0o666 })
    if (!existsSync(join(root, 'reference', 'README.md')))
      atomicWrite(
        join(root, 'reference', 'README.md'),
        '# Private reference\n\nKeep private reference material here. It is never published as a public contrib.\n',
        { mode: 0o666 }
      )
    if (!existsSync(join(root, 'me', 'contribs.md')))
      atomicWrite(join(root, 'me', 'contribs.md'), '# Local self-model extensions\n\nList private contrib paths here when needed.\n', { mode: 0o666 })
    for (const [name, body] of Object.entries(PROFILE_FILES)) {
      const p = join(root, 'profile', name)
      if (!existsSync(p)) atomicWrite(p, body, { mode: 0o666 })
    }
    for (const [name, body] of Object.entries(CONTEXT_FILES)) {
      const p = join(root, 'context', name)
      if (!existsSync(p)) atomicWrite(p, body, { mode: 0o666 })
    }
    // Keep data-root guidance beside private data. Bounded injection preserves user text.
    inject(root, 'AGENTS.md', false, rootSection(), ROOT_START, ROOT_END)
    const old = readConfig(root)
    const contribs = selectedContribs(o, old?.selectedContribs)
    json(configPath(root), { schemaVersion: 1, product: 'holoself', selectedContribs: contribs, createdAt: old?.createdAt || new Date().toISOString() })
    console.log(`[ok] initialized ${root}`)
    console.log(`Contribs: ${contribs.join(', ') || '(none)'}`)
    return
  }
  if (o.command === 'doctor') {
    const checks = [
      ['node', Number(process.versions.node.split('.')[0]) >= 22],
      ['data root', existsSync(root)],
      ['config', existsSync(configPath(root))],
      ['profile', existsSync(join(root, 'profile'))],
      ['context', existsSync(join(root, 'context'))]
    ]
    checks.forEach(([n, ok]) => console.log(`${ok ? '[ok]' : '[!!]'} ${n}`))
    const warnings = checks.every(([, ok]) => ok) ? catalogBuildWarnings(root) : []
    for (const w of warnings) console.log(`[warn] ${w}`)
    if (checks.every(([, ok]) => ok)) {
      const excludedCount = excludedCanonicalDocuments(root).length
      if (excludedCount > 0) console.log(excludedIncompleteMetadataNotice(excludedCount))
    }
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1
    return
  }
  if (o.command === 'validate') {
    if (!o.fix && (o.apply || o.output || o.digest || o.withPolicyFiles || o.allowPublishApproved)) {
      throw new Error('validate repair options (--apply, --out, --digest, --with-policy-files, --allow-publish-approved) require --fix')
    }
    if (o.fix) {
      if (!existsSync(root)) throw new Error('data root does not exist')
      if (o.apply) {
        if (!o.digest) throw new Error('validate --fix --apply requires --digest <sha256>')
        if (!(await confirm(o, `Apply validate --fix plan (${o.digest}) to ${root}?`))) {
          console.log('Cancelled.')
          return
        }
        const explicitPlan = typeof o.apply === 'string' ? JSON.parse(readFileSync(resolve(o.apply), 'utf8')) : null
        const result = applyValidateFixPlan(root, explicitPlan, {
          expectedDigest: o.digest,
          withPolicyFiles: Boolean(o.withPolicyFiles),
          allowPublishApproved: Boolean(o.allowPublishApproved)
        })
        if (o.json) console.log(JSON.stringify(result, null, 2))
        else
          console.log(
            `[ok] applied validate --fix plan (${result.operations.length} operation(s), mode=${result.mode}, digest=${result.plan_digest})\nReceipt: ${result.receipt_path}`
          )
        return
      }
      const plan = buildValidateFixPlan(root, {
        withPolicyFiles: Boolean(o.withPolicyFiles),
        allowPublishApproved: Boolean(o.allowPublishApproved)
      })
      if (o.output) atomicWrite(o.output, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, exactMode: true })
      if (o.json) console.log(JSON.stringify(plan, null, 2))
      else console.log(formatValidateFixPlanText(plan, { outputPath: o.output || null }))
      return
    }
    const errors = []
    if (!existsSync(root)) errors.push('data root does not exist')
    const c = readConfig(root)
    if (c) {
      if (c.schemaVersion !== 1) errors.push('unsupported config schema')
      if (c.product !== 'holoself') errors.push('config product must be holoself')
      if (!Array.isArray(c.selectedContribs)) errors.push('selectedContribs must be an array')
      else for (const id of c.selectedContribs) if (!availableContribs().includes(id)) errors.push(`unknown selected contrib: ${id}`)
      if (c.ledger !== undefined) {
        if (!c.ledger || Array.isArray(c.ledger) || typeof c.ledger !== 'object') errors.push('config ledger must be an object')
        else {
          for (const key of Object.keys(c.ledger)) if (!['enabled', 'record_task_text'].includes(key)) errors.push(`unknown config.ledger field: ${key}`)
          if (c.ledger.enabled !== undefined && typeof c.ledger.enabled !== 'boolean') errors.push('config.ledger.enabled must be a boolean')
          if (c.ledger.record_task_text !== undefined && typeof c.ledger.record_task_text !== 'boolean')
            errors.push('config.ledger.record_task_text must be a boolean')
        }
      }
    } else errors.push(existsSync(configPath(root)) ? 'config.json is invalid JSON' : 'config.json missing')
    for (const name of Object.keys(PROFILE_FILES)) if (!existsSync(join(root, 'profile', name))) errors.push(`missing profile/${name}`)
    for (const name of Object.keys(CONTEXT_FILES)) if (!existsSync(join(root, 'context', name))) errors.push(`missing context/${name}`)
    const rootAgentsError = markerError(join(root, 'AGENTS.md'), ROOT_START, ROOT_END)
    if (rootAgentsError) errors.push(rootAgentsError)
    for (const file of ['CLAUDE.md', 'CODEX.md']) {
      const error = markerError(join(root, file))
      if (error) errors.push(error)
    }
    const warnings = existsSync(root) ? catalogBuildWarnings(root, o.project) : []
    for (const w of warnings) console.log(`[warn] ${w}`)
    const excludedCount = existsSync(root) ? excludedCanonicalDocuments(root).length : 0
    if (excludedCount > 0) console.log(excludedIncompleteMetadataNotice(excludedCount))
    errors.push(...ecosystemValidationErrors(root, o.project))
    for (const e of [...new Set(errors)]) console.error(`[!!] ${e}`)
    if (errors.length) {
      process.exitCode = 1
    } else {
      for (const line of policyProvenanceSummary(root)) console.log(line)
      console.log(`[ok] ${root} is valid`)
    }
    return
  }
  if (o.command === 'migrate') {
    if (!o.from) throw new Error('migrate requires --from <PersonalOS directory>')
    const source = existsSync(join(o.from, 'personal')) ? join(o.from, 'personal') : o.from
    if (!existsSync(source)) throw new Error(`source not found: ${source}`)
    assertMigrationTarget(source, root)
    const { report } = migrationPlan(source, root, o.from, o.force)
    report.dryRun = Boolean(o.dryRun)
    if (!(await confirm(o, `${o.dryRun ? 'Preview' : 'Copy'} personal data from ${source} to ${root}?`))) {
      console.log('Cancelled.')
      return
    }
    const manifestPath = join(root, 'migration-manifest.json')
    if (!o.dryRun) {
      ensureDir(root)
      for (const mapping of report.destinationMappings) assertDestinationParents(root, mapping.destination)
      applyMigration(report, root)
      if (source !== o.from && existsSync(join(o.from, 'topics'))) ensureDir(join(root, 'topics'))
      const c = readConfig(root)
      if (c) json(configPath(root), c)
      atomicWrite(manifestPath, JSON.stringify(migrationManifest(report), null, 2) + '\n', { mode: 0o666 })
    }
    printMigrationReport(report, o.dryRun ? null : manifestPath)
    return
  }
  if (o.command === 'export') {
    if (!o.target) throw new Error('export requires --target <project>')
    if (!existsSync(root)) throw new Error('data root missing; run init first')
    const out = join(o.target, '.holoself')
    let backup = null
    if (isEcosystemMetadata(out)) throw new Error(`${out} contains linked-ecosystem metadata; refusing legacy export overwrite`)
    if (!o.dryRun) {
      ensureDir(o.target)
      const stage = join(o.target, `.holoself-tmp-${process.pid}-${nextTempCounter()}`)
      try {
        ensureDir(stage)
        copyMarkdownTree(join(root, 'profile'), join(stage, 'profile'))
        copyMarkdownTree(join(root, 'context'), join(stage, 'context'))
        atomicWrite(join(stage, 'context-packet.md'), packet(root, o.packetOnly), { mode: 0o666 })
        atomicWrite(join(stage, 'README.md'), '# Holoself project context\n\nThis folder is generated locally. Do not commit it unless reviewed.\n', {
          mode: 0o666
        })
        backup = backupExport(out, o.target)
        renameSync(stage, out)
      } finally {
        if (pathExists(stage)) rmSync(stage, { recursive: true, force: true })
      }
    }
    console.log(`${o.dryRun ? '[dry-run] ' : ''}[ok] exported packet to ${out}${backup ? ` (backup: ${backup})` : ''}`)
    if (o.rootSetup) {
      if (!(await confirm(o, 'Modify project instruction files with a bounded Holoself section? This changes project files.'))) return
      for (const f of ['AGENTS.md', 'CLAUDE.md', 'CODEX.md']) console.log(` - ${f}: ${inject(o.target, f, o.dryRun, projectSection(o.packetOnly))}`)
    }
    return
  }
  if (o.command === 'link') {
    if (!o.target) throw new Error('link requires --target <project>')
    if (!existsSync(root)) throw new Error('data root missing; run init first')
    // Validate every instruction file before changing the link, so malformed or
    // unsafe project files cannot leave a partially-applied root setup.
    if (o.rootSetup) for (const f of ['AGENTS.md', 'CLAUDE.md', 'CODEX.md']) inject(o.target, f, true, projectSection())
    if (!o.dryRun) ensureDir(o.target)
    const p = join(o.target, '.holoself')
    if (pathExists(p)) {
      if (!isHoloselfLink(p, root)) throw new Error(`${p} exists and is not a Holoself link; refusing to replace`)
      if (!o.force) throw new Error(`${p} exists; use --force only to replace it`)
      if (!(await confirm(o, `WARNING: replace existing Holoself link ${p}?`))) return
    } else if (!(await confirm(o, `WARNING: create link ${p} -> ${root}. This exposes private context to project tools.`))) return
    if (!o.dryRun) {
      if (pathExists(p)) unlinkSync(p)
      symlinkSync(root, p, process.platform === 'win32' ? 'junction' : 'dir')
    }
    console.log(`${o.dryRun ? '[dry-run] ' : '[ok] '}linked ${p} -> ${root}`)
    if (o.rootSetup) {
      if (!(await confirm(o, 'Modify project instruction files with a bounded Holoself section? This changes project files.'))) return
      for (const f of ['AGENTS.md', 'CLAUDE.md', 'CODEX.md']) console.log(` - ${f}: ${inject(o.target, f, o.dryRun, projectSection())}`)
    }
    return
  }
  if (o.command === 'unlink') {
    if (!o.target) throw new Error('unlink requires --target <project>')
    const p = join(o.target, '.holoself')
    if (!pathExists(p)) {
      console.log('[ok] no link found')
      return
    }
    if (!isHoloselfLink(p, root)) throw new Error(`${p} is not a Holoself link; refusing to remove`)
    if (!(await confirm(o, `WARNING: remove Holoself link ${p}?`))) return
    if (!o.dryRun) unlinkSync(p)
    console.log(`${o.dryRun ? '[dry-run] ' : ''}[ok] unlinked ${p}`)
    return
  }
  if (o.command === 'upgrade') {
    const c = readConfig(root)
    if (!c) throw new Error('config.json missing; run init first')
    const ids = selectedContribs(o, c.selectedContribs)
    if (!o.dryRun) {
      c.selectedContribs = ids
      json(configPath(root), c)
    }
    console.log(`${o.dryRun ? '[dry-run] ' : ''}[ok] refreshed public contrib availability; product files remain package-owned`)
    return
  }
  throw new Error(`unknown command: ${o.command}`)
}
