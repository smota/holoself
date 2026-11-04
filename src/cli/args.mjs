// Command-line argument parsing and the per-command flag contracts.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function defaultRoot() {
  return process.env.HOLOSELF_HOME || join(homedir(), '.holoself')
}
export function requiredValue(args, i, flag) {
  const value = args[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}
// Contracts describe meaningful options, including aliases, before any command executes.
export const ROOT_FLAGS = ['--root', '--data-root', '--data-dir']
export const PROJECT_FLAGS = ['--project', '--target']
export const CONFIRM_FLAGS = ['--yes', '--confirm']
export const ACTIVATION_FLAGS = [
  '--activate',
  '--platform',
  '--instructions',
  '--install-skill',
  '--skill-home',
  '--no-activate',
  '--hooks',
  '--no-hooks',
  '--mcp',
  '--no-mcp',
  '--approve-read-tools',
  '--no-approve-read-tools',
  '--force',
  '--dry-run',
  ...CONFIRM_FLAGS
]
export const CONTEXT_FLAGS = [
  ...ROOT_FLAGS,
  '--project',
  '--target',
  '--self',
  '--lens',
  '--task',
  '--need',
  '--self-only',
  '--budget',
  '--source',
  '--session-start',
  '--hook',
  '--hook-format',
  '--temporal',
  '--include-history',
  '--manifest',
  '--cursor',
  '--no-cache',
  '--federated',
  '--spaces',
  '--adapter',
  '--restricted-host',
  '--expires-hours',
  '--format',
  '--json',
  '--output',
  '--snapshot',
  ...CONFIRM_FLAGS
]
export const JSON_FLAGS = ['--json'] // Explicit compatibility for commands whose output is always JSON.
export const COMMAND_FLAGS = {
  '': [],
  capabilities: JSON_FLAGS,
  'data-root': ROOT_FLAGS,
  init: [...ROOT_FLAGS, '--contribs', '--exclude-contrib'],
  doctor: ROOT_FLAGS,
  validate: [
    ...ROOT_FLAGS,
    '--project',
    '--fix',
    '--out',
    '--output',
    '--with-policy-files',
    '--allow-publish-approved',
    '--dry-run',
    '--apply',
    '--digest',
    '--preview-hash',
    ...CONFIRM_FLAGS,
    ...JSON_FLAGS
  ],
  migrate: [...ROOT_FLAGS, '--from', '--force', '--dry-run', ...CONFIRM_FLAGS],
  export: [...ROOT_FLAGS, '--target', '--packet-only', '--root-setup', '--dry-run', ...CONFIRM_FLAGS],
  link: [...ROOT_FLAGS, '--target', '--root-setup', '--force', '--dry-run', ...CONFIRM_FLAGS],
  unlink: [...ROOT_FLAGS, '--target', '--dry-run', ...CONFIRM_FLAGS],
  upgrade: [...ROOT_FLAGS, '--contribs', '--exclude-contrib', '--dry-run'],
  web: [...ROOT_FLAGS, '--project', '--port', '--no-open'],
  mcp: ['--project', '--claude-project-dir'],
  'mcp status': ['--project', '--platform', ...JSON_FLAGS],
  'mcp configure': ['--project', '--platform', '--all-detected', '--force-replace', '--dry-run', ...CONFIRM_FLAGS, ...JSON_FLAGS],
  coaching: [],
  'coaching start': [...ROOT_FLAGS, '--question', ...JSON_FLAGS],
  'coaching note': [...ROOT_FLAGS, '--expected-revision', '--kind', '--text', ...JSON_FLAGS],
  'coaching action': [...ROOT_FLAGS, '--expected-revision', '--text', ...JSON_FLAGS],
  'coaching choose': [...ROOT_FLAGS, '--expected-revision', '--action-sequence', ...JSON_FLAGS],
  'coaching review': [...ROOT_FLAGS, '--expected-revision', '--outcome', '--text', ...JSON_FLAGS],
  'coaching material': [
    ...ROOT_FLAGS,
    '--expected-revision',
    '--material-text',
    '--material-status',
    '--source-label',
    '--producer',
    '--limitations',
    ...JSON_FLAGS
  ],
  'coaching resume': [...ROOT_FLAGS, ...JSON_FLAGS],
  'knowledge transform': [
    ...ROOT_FLAGS,
    '--replacements',
    '--plan-kind',
    '--output',
    '--dry-run',
    '--apply',
    '--digest',
    '--preview-hash',
    ...CONFIRM_FLAGS,
    ...JSON_FLAGS
  ],
  'knowledge migrate-lenses': [...ROOT_FLAGS, '--output', '--dry-run', '--apply', '--digest', '--preview-hash', ...CONFIRM_FLAGS, ...JSON_FLAGS],
  'knowledge cleanup': [...ROOT_FLAGS, '--output', '--dry-run', '--apply', '--digest', '--preview-hash', ...CONFIRM_FLAGS, ...JSON_FLAGS],
  instructions: [...PROJECT_FLAGS, ...JSON_FLAGS],
  'instructions audit': [...PROJECT_FLAGS, ...JSON_FLAGS],
  'instructions render': [...PROJECT_FLAGS, '--adapter', '--harvest', '--focus', '--json'],
  'skill status': ['--scope', '--platform', '--skill-home', ...JSON_FLAGS],
  'skill install': ['--scope', '--platform', '--skill-home', '--force', '--dry-run', ...CONFIRM_FLAGS, ...JSON_FLAGS],
  ...Object.fromEntries(['list', 'show', 'validate', 'bindings'].map(sub => ['lens ' + sub, [...ROOT_FLAGS, ...JSON_FLAGS]])),
  'lens bind': [...ROOT_FLAGS, '--project', '--lens', '--secondary-lenses', '--binding-hash', '--dry-run', ...CONFIRM_FLAGS, ...JSON_FLAGS],
  'lens unbind': [...ROOT_FLAGS, '--project', '--binding-hash', '--dry-run', ...CONFIRM_FLAGS, ...JSON_FLAGS],
  ...Object.fromEntries(
    ['add', 'setup'].map(sub => [
      'link ' + sub,
      [
        ...PROJECT_FLAGS,
        '--self',
        '--lens',
        '--secondary-lenses',
        '--project-include',
        '--project-exclude',
        '--project-assert-include',
        '--project-assert-exclude',
        ...ACTIVATION_FLAGS
      ]
    ])
  ),
  'link activate': [...PROJECT_FLAGS, ...ACTIVATION_FLAGS],
  'link repair': [...PROJECT_FLAGS, ...ACTIVATION_FLAGS, '--lens', '--secondary-lenses'],
  'link deactivate': [...PROJECT_FLAGS, '--adapters', '--dry-run', ...CONFIRM_FLAGS],
  'link status': [...PROJECT_FLAGS, '--skill-home', ...JSON_FLAGS],
  'link doctor': [...PROJECT_FLAGS, '--skill-home', ...CONTEXT_FLAGS.filter(flag => !['--output', '--yes', '--confirm'].includes(flag))],
  'link remove': [...PROJECT_FLAGS, ...ROOT_FLAGS, '--self', '--force', '--dry-run', ...CONFIRM_FLAGS],
  'link approve': [...PROJECT_FLAGS, ...ROOT_FLAGS, '--self', '--revoke', '--lenses'],
  'link backfill': [...PROJECT_FLAGS, ...ROOT_FLAGS, '--self', '--all', '--lenses'],
  'link prune': [...ROOT_FLAGS, '--self'],
  'link skill migrate-global': [...PROJECT_FLAGS, '--platform', '--instructions', '--skill-home', '--force', '--dry-run', ...CONFIRM_FLAGS],
  'migrate policy': [...ROOT_FLAGS, '--self', '--apply', '--revert', '--confirm-narrowing', '--allow-partial', '--include-linked', '--dry-run', ...JSON_FLAGS],
  context: CONTEXT_FLAGS,
  ...Object.fromEntries(['overlap', 'conflicts', 'stale', 'all'].map(sub => ['analyze ' + sub, [...PROJECT_FLAGS, ...JSON_FLAGS]])),
  propose: [
    ...PROJECT_FLAGS,
    '--claim',
    '--op',
    '--claim-id',
    '--reason',
    '--source-file',
    '--target-file',
    '--proposal-type',
    '--type',
    '--evidence',
    '--confidence',
    '--visibility',
    ...JSON_FLAGS
  ],
  ...Object.fromEntries(['list', 'audit'].map(sub => ['proposals ' + sub, [...PROJECT_FLAGS, ...JSON_FLAGS]])),
  'proposals show': PROJECT_FLAGS,
  'proposals approve': [...PROJECT_FLAGS, '--json', '--digest', '--preview-hash', ...CONFIRM_FLAGS],
  ...Object.fromEntries(['reject', 'defer', 'supersede'].map(sub => ['proposals ' + sub, [...PROJECT_FLAGS, ...CONFIRM_FLAGS]])),
  index: [...PROJECT_FLAGS, '--changed', ...JSON_FLAGS],
  'index status': [...PROJECT_FLAGS, ...JSON_FLAGS],
  'index rebuild': [...PROJECT_FLAGS, ...JSON_FLAGS],
  ledger: [...PROJECT_FLAGS, ...ROOT_FLAGS, '--self', '--since', '--lens', '--surface', '--limit', ...JSON_FLAGS],
  search: [...PROJECT_FLAGS, '--lens', '--temporal', '--federated', '--spaces', ...JSON_FLAGS]
}
export function commandKey(o) {
  if (o.command === 'link' && o.args[0] === 'skill') return ['link', ...o.args.slice(0, 2)].join(' ')
  if (['link', 'migrate', 'mcp', 'coaching', 'knowledge', 'instructions', 'skill', 'lens', 'analyze', 'proposals', 'index'].includes(o.command) && o.args[0])
    return `${o.command} ${o.args[0]}`
  return o.command || ''
}
export function validateFlags(o) {
  const key = commandKey(o),
    allowed = COMMAND_FLAGS[key]
  if (!allowed && !o.help && !o.version) throw new Error(`unknown command: ${key}`)
  for (const flag of o._flags) {
    const universal = ['--help', '-h', '--version', '-v'].includes(flag) || (o.version && flag === '--json')
    if (!universal && !allowed?.includes(flag)) {
      const error = new Error(`option ${flag} is not supported by '${key || 'holoself'}'; see holoself --help`)
      error.code = 'OPTION_NOT_SUPPORTED'
      throw error
    }
  }
  if (o.dryRun && (o.command === 'knowledge' || o.command === 'validate' || key === 'migrate policy') && (o.apply || o.revert || o.output))
    throw new Error('--dry-run cannot be combined with --apply, --revert or --output')
  if (o.need !== undefined && !['required', 'helpful', 'not-needed'].includes(o.need)) {
    const error = new Error(`invalid context need: ${o.need}; expected required, helpful, or not-needed`)
    error.code = 'INVALID_ARGUMENT'
    throw error
  }
  if (o.hookFormat !== undefined && !['text', 'agy-json'].includes(o.hookFormat)) {
    const error = new Error(`invalid hook format: ${o.hookFormat}; expected text or agy-json`)
    error.code = o.hook ? 'HOOK_OPTION_REFUSED' : 'INVALID_ARGUMENT'
    throw error
  }
  if (o.focus !== undefined && !o.harvest) {
    const error = new Error('--focus requires --harvest')
    error.code = 'INVALID_ARGUMENT'
    throw error
  }
  if (o.harvest && o.adapter) {
    const error = new Error('--adapter cannot be combined with --harvest')
    error.code = 'INVALID_ARGUMENT'
    throw error
  }
  return o
}
export function parseArguments(args) {
  return validateFlags(parse(args))
}
export function parse(args) {
  const o = { rootSetup: false, _flags: [] }
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('-')) o._flags.push(a)
    if (a === '--adapters') o.adapters = requiredValue(args, i++, a)
    else if (a === '--root' || a === '--data-root' || a === '--data-dir') {
      o.root = resolve(requiredValue(args, i++, a))
      o.rootExplicit = true
    } else if (a === '--target') o.target = resolve(requiredValue(args, i++, a))
    else if (a === '--project') {
      const raw = requiredValue(args, i++, a)
      o.projectRaw = raw
      o.project = resolve(raw)
    } else if (a === '--self') o.self = resolve(requiredValue(args, i++, a))
    else if (a === '--from') o.from = resolve(requiredValue(args, i++, a))
    else if (a === '--lens') o.lens = requiredValue(args, i++, a)
    else if (a === '--lenses')
      o.lenses = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    else if (a === '--secondary-lenses')
      o.secondaryLenses = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    else if (a === '--task') o.task = requiredValue(args, i++, a)
    else if (a === '--need') o.need = requiredValue(args, i++, a)
    else if (a === '--question') o.question = requiredValue(args, i++, a)
    else if (a === '--text') o.coachingText = requiredValue(args, i++, a)
    else if (a === '--plan-kind') o.planKind = requiredValue(args, i++, a)
    else if (a === '--kind') o.coachingKind = requiredValue(args, i++, a)
    else if (a === '--outcome') o.coachingOutcome = requiredValue(args, i++, a)
    else if (a === '--expected-revision') o.expectedRevision = Number(requiredValue(args, i++, a))
    else if (a === '--action-sequence') o.actionSequence = Number(requiredValue(args, i++, a))
    else if (a === '--material-text') o.materialText = requiredValue(args, i++, a)
    else if (a === '--material-status') o.materialStatus = requiredValue(args, i++, a)
    else if (a === '--source-label') o.sourceLabel = requiredValue(args, i++, a)
    else if (a === '--producer') o.producer = requiredValue(args, i++, a)
    else if (a === '--limitations') o.limitations = requiredValue(args, i++, a)
    else if (a === '--material-file')
      throw new Error(
        'Document import is unsupported. Have an external tool extract the text, then use coaching material --material-text with source provenance.'
      )
    else if (a === '--budget') o.budget = requiredValue(args, i++, a)
    else if (a === '--since') o.since = requiredValue(args, i++, a)
    else if (a === '--surface') o.surface = requiredValue(args, i++, a)
    else if (a === '--limit') o.limit = requiredValue(args, i++, a)
    else if (a === '--temporal') o.temporal = requiredValue(args, i++, a)
    else if (a === '--cursor') o.cursor = requiredValue(args, i++, a)
    else if (a === '--source') {
      o.sources = o.sources || []
      o.sources.push(requiredValue(args, i++, a))
    } else if (a === '--manifest') o.manifest = true
    else if (a === '--session-start') o.sessionStart = true
    else if (a === '--hook') o.hook = requiredValue(args, i++, a)
    else if (a === '--hook-format') o.hookFormat = requiredValue(args, i++, a)
    else if (a === '--hooks' || a === '--no-hooks') {
      const value = a === '--hooks' ? 'on' : 'off'
      if (o.hooks && o.hooks !== value) throw new Error('--hooks and --no-hooks cannot be combined')
      o.hooks = value
    }
    else if (a === '--mcp' || a === '--no-mcp') {
      const value = a === '--mcp' ? 'on' : 'off'
      if (o.mcp && o.mcp !== value) throw new Error('--mcp and --no-mcp cannot be combined')
      o.mcp = value
    } else if (a === '--approve-read-tools' || a === '--no-approve-read-tools') {
      const value = a === '--approve-read-tools'
      if (o.approveReadTools !== undefined && o.approveReadTools !== value) throw new Error('--approve-read-tools and --no-approve-read-tools cannot be combined')
      o.approveReadTools = value
    } else if (a === '--all-detected') o.allDetected = true
    else if (a === '--force-replace') o.forceReplace = true
    else if (a === '--include-history') o.includeHistory = true
    else if (a === '--no-cache') o.noCache = true
    else if (a === '--format') o.format = requiredValue(args, i++, a)
    else if (a === '--output' || a === '--out') o.output = resolve(requiredValue(args, i++, a))
    else if (a === '--binding-hash') o.bindingHash = requiredValue(args, i++, a)
    else if (a === '--replacements') o.replacements = requiredValue(args, i++, a)
    else if (a === '--plan') o.plan = requiredValue(args, i++, a)
    else if (a === '--apply') {
      if (args.includes('validate') && (!args[i + 1] || args[i + 1].startsWith('-'))) o.apply = true
      else o.apply = requiredValue(args, i++, a)
    }
    else if (a === '--revert') o.revert = requiredValue(args, i++, a)
    else if (a === '--digest' || a === '--preview-hash') o.digest = requiredValue(args, i++, a)
    else if (a === '--adapter') o.adapter = requiredValue(args, i++, a)
    else if (a === '--harvest') o.harvest = true
    else if (a === '--focus') o.focus = requiredValue(args, i++, a)
    else if (a === '--activate') o.activate = requiredValue(args, i++, a)
    else if (a === '--platform') {
      o.platforms = o.platforms || []
      o.platforms.push(requiredValue(args, i++, a))
    } else if (a === '--instructions') o.instructions = requiredValue(args, i++, a)
    else if (a === '--install-skill') o.installSkill = requiredValue(args, i++, a)
    else if (a === '--skill-home') o.skillHome = resolve(requiredValue(args, i++, a))
    else if (a === '--scope') o.scope = requiredValue(args, i++, a)
    else if (a === '--project-include') {
      o.projectContext = o.projectContext || {}
      o.projectContext.include = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    } else if (a === '--project-exclude') {
      o.projectContext = o.projectContext || {}
      o.projectContext.exclude = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    } else if (a === '--project-assert-include') {
      o.projectContext = o.projectContext || {}
      o.projectContext.assert_include = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    } else if (a === '--project-assert-exclude') {
      o.projectContext = o.projectContext || {}
      o.projectContext.assert_exclude = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    } else if (a === '--expires-hours') {
      const value = Number(requiredValue(args, i++, a))
      if (!Number.isFinite(value) || value <= 0 || value > 720) throw new Error('--expires-hours must be a number greater than 0 and at most 720')
      o.expiresHours = value
    } else if (a === '--port') {
      const value = Number(requiredValue(args, i++, a))
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('--port must be between 0 and 65535')
      o.port = value
    } else if (a === '--restricted-host') o.restrictedHost = true
    else if (a === '--claude-project-dir') o.claudeProjectDir = true
    else if (a === '--claim') o.claim = requiredValue(args, i++, a)
    else if (a === '--op') {
      const value = requiredValue(args, i++, a),
        ops = { append: 'append_claim', replace: 'replace_claim', supersede: 'supersede_claim', retire: 'retire_claim' }
      if (!ops[value] && !Object.values(ops).includes(value)) throw new Error('--op must be append, replace, supersede, or retire')
      o.operation = ops[value] || value
    } else if (a === '--claim-id') o.claimId = requiredValue(args, i++, a)
    else if (a === '--reason') o.reason = requiredValue(args, i++, a)
    else if (a === '--evidence') o.evidence = requiredValue(args, i++, a)
    else if (a === '--target-file') o.targetFile = requiredValue(args, i++, a)
    else if (a === '--proposal-type' || a === '--type') o.proposalType = requiredValue(args, i++, a)
    else if (a === '--confidence') o.confidence = requiredValue(args, i++, a)
    else if (a === '--visibility') o.visibility = requiredValue(args, i++, a)
    else if (a === '--source-file') {
      o.sourceFiles = o.sourceFiles || []
      o.sourceFiles.push(requiredValue(args, i++, a))
    } else if (a === '--contribs')
      o.contribs = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    else if (a === '--exclude-contrib')
      o.exclude = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    else if (a === '--yes' || a === '--confirm') o.yes = true
    else if (a === '--no-activate') o.noActivate = true
    else if (a === '--no-open') o.noOpen = true
    else if (a === '--root-setup') o.rootSetup = true
    else if (a === '--force') o.force = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--all') o.all = true
    else if (a === '--revoke') o.revoke = true
    else if (a === '--confirm-narrowing') o.confirmNarrowing = true
    else if (a === '--allow-partial') o.allowPartial = true
    else if (a === '--include-linked') o.includeLinked = true
    else if (a === '--fix') o.fix = true
    else if (a === '--with-policy-files') o.withPolicyFiles = true
    else if (a === '--allow-publish-approved') o.allowPublishApproved = true
    else if (a === '--packet-only') o.packetOnly = true
    else if (a === '--self-only') o.selfOnly = true
    else if (a === '--snapshot') o.snapshot = true
    else if (a === '--json') o.json = true
    else if (a === '--changed') o.changed = true
    else if (a === '--federated') o.federated = true
    else if (a === '--spaces')
      o.spaces = requiredValue(args, i++, a)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
    else if (a === '--help' || a === '-h') o.help = true
    else if (a === '--version' || a === '-v') o.version = true
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`)
    else positional.push(a)
  }
  o.root = o.root || defaultRoot()
  o.command = positional[0]
  o.args = positional.slice(1)
  return o
}
