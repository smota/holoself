// The readiness report every onboarding and refinement step prints, including a step that stops.
// It states three separate facts: project readiness, runtime readiness, and governed-change
// readiness. Governed-change readiness is never true here: adopting or refining a project is not a
// product change. When anything blocks, it names exactly one recommended next action, and that
// action is a step in the public docs. Every other blocker is still listed.

const ADOPTION_PAGE = 'docs/get-started.md'
const REFINEMENT_PAGE = 'docs/assisted-configuration.md'

// Ordered by precedence: the first blocker present is the recommended next action.
const STEPS = [
  ['interrupted', 'Recover the interrupted apply', `${ADOPTION_PAGE}#recover-an-interrupted-apply`],
  [
    'undo-drifted',
    'Files changed after the apply; restore them or keep them, then undo again',
    `${ADOPTION_PAGE}#undo`,
  ],
  ['stale-preview', 'Preview again, then confirm the new preview', `${ADOPTION_PAGE}#preview`],
  ['declined', 'Review the preview, then confirm it', `${ADOPTION_PAGE}#confirm-and-apply`],
  ['legacy-lock', 'Decide whether to migrate the legacy lock', `${ADOPTION_PAGE}#a-legacy-lock`],
  [
    'unknown-lock',
    'Decide whether to recover the unknown lock',
    `${ADOPTION_PAGE}#an-unknown-or-malformed-lock`,
  ],
  [
    'invalid-config',
    'Repair agent-workflow.config.json, then preview again',
    `${ADOPTION_PAGE}#an-invalid-configuration-file`,
  ],
  [
    'conflict',
    'Choose preserve or replace for each conflicting file',
    `${ADOPTION_PAGE}#a-file-both-agentflow-and-the-project-changed`,
  ],
  [
    'not-adopted',
    'Adopt the project or bring the installation forward first',
    `${ADOPTION_PAGE}#preview`,
  ],
  ['pending-update', 'Bring the installation forward first', `${ADOPTION_PAGE}#preview`],
  ['no-changes', 'Name the setting to change', `${REFINEMENT_PAGE}#preview-a-change`],
  [
    'deferred-update',
    'Take the deferred update when you are ready',
    `${ADOPTION_PAGE}#defer-a-framework-update`,
  ],
  ['plan-error', 'Inspect the project and read its diagnostics', `${ADOPTION_PAGE}#inspect`],
  ['pending-writes', 'Confirm the preview to apply it', `${ADOPTION_PAGE}#confirm-and-apply`],
  ['not-installed', 'Preview the adoption, then confirm it', `${ADOPTION_PAGE}#preview`],
  ['no-check', 'Add a check the project can run', `${REFINEMENT_PAGE}#add-a-check`],
  [
    'runtime-not-ready',
    'Have the runtime provide what is missing, then verify again',
    `${ADOPTION_PAGE}#check-the-runtime`,
  ],
]

// A refinement previews and confirms on its own page.
const REFINEMENT_STEPS = {
  'stale-preview': `${REFINEMENT_PAGE}#preview-a-change`,
  declined: `${REFINEMENT_PAGE}#confirm-and-apply`,
  'pending-writes': `${REFINEMENT_PAGE}#confirm-and-apply`,
}

const FIRST_CHANGE = {
  id: 'first-change',
  step: 'Start the first governed change',
  doc: `${ADOPTION_PAGE}#start-the-first-governed-change`,
}

// Every step a report can recommend, and the undo and recover routes, for checking the docs.
export const REPORT_STEPS = Object.freeze([
  ...STEPS.map(([id, step, doc]) => ({ id, step, doc })),
  ...Object.entries(REFINEMENT_STEPS).map(([id, doc]) => ({ id: `${id}-refinement`, doc })),
  FIRST_CHANGE,
  { id: 'undo', step: 'Undo an adoption', doc: `${ADOPTION_PAGE}#undo` },
  { id: 'undo-refinement', step: 'Undo a refinement', doc: `${REFINEMENT_PAGE}#undo` },
])

const GOVERNED_CHANGE = Object.freeze({
  ready: false,
  reason:
    'Adoption and refinement are not a product change. A governed change needs an issue contract and verification evidence from a run.',
})

const WRITES = ['create', 'update', 'seed']

// Plan blockers are prose for people; the report also gives each one a stable id.
function blockerId(message) {
  if (/journal/i.test(message)) return 'interrupted'
  if (/legacy/i.test(message)) return 'legacy-lock'
  if (/lockfile format is unknown/i.test(message)) return 'unknown-lock'
  if (/config file is invalid/i.test(message)) return 'invalid-config'
  if (/conflict/i.test(message)) return 'conflict'
  if (/deferred/i.test(message)) return 'deferred-update'
  if (/^Refinement needs an adopted project/.test(message)) return 'not-adopted'
  if (/^Refinement changes only/.test(message)) return 'pending-update'
  if (/^Refinement needs at least one/.test(message)) return 'no-changes'
  return 'plan-error'
}

function hasCheck(config) {
  if (!config || typeof config !== 'object') return false
  const commands = Array.isArray(config.ciCommands) && config.ciCommands.length > 0
  const checks = config.delivery?.checks && Object.keys(config.delivery.checks).length > 0
  return Boolean(commands || checks)
}

// The configuration the project will have: what this plan writes, or what is on disk.
function effectiveConfig(inventory, projectPlan) {
  const write = projectPlan?.actions?.find(
    (item) =>
      item.target === 'agent-workflow.config.json' &&
      WRITES.includes(item.action) &&
      item.contentBase64,
  )
  if (write) return JSON.parse(Buffer.from(write.contentBase64, 'base64').toString('utf8'))
  return inventory?.config?.status === 'valid' ? inventory.config.value : null
}

function runtimeStatus(runtime) {
  if (!runtime) return { status: 'not-checked', unknowns: 0, errors: [] }
  return {
    status: runtime.runtimeReady ? 'ready' : 'not-ready',
    unknowns: Array.isArray(runtime.unknowns) ? runtime.unknowns.length : 0,
    errors: Array.isArray(runtime.errors) ? runtime.errors : [],
  }
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}

export function stopReasonFor(error, stage) {
  const message = error?.message ?? String(error)
  if (stage === 'undo' && /drift/i.test(message)) return 'undo-drifted'
  if (/confirmation/i.test(message)) return 'declined'
  if (/drift|stale|replan/i.test(message)) return 'stale-preview'
  if (/journal|recover|durable/i.test(message)) return 'interrupted'
  if (/legacy|lockfile/i.test(message)) return 'refused-lock'
  if (/blocker|missing choices|blocked/i.test(message)) return 'blocked'
  return 'error'
}

export function buildReadinessReport({
  journey = 'adoption',
  stage,
  targetDir,
  inventory = null,
  runtime = null,
  projectPlan = null,
  choices = {},
  planBlockers = [],
  stop = null,
  confirmed = null,
  receipt = null,
  recoveryToken = null,
} = {}) {
  const blockers = []
  const add = (id, message) => {
    if (!blockers.some((item) => item.id === id && item.message === message))
      blockers.push({ id, message })
  }

  // A plan with blockers is a journey that stopped before any write.
  if (!stop && stage === 'plan' && planBlockers.length) {
    const ids = planBlockers.map(blockerId)
    const reason = ids.includes('deferred-update')
      ? 'deferred-update'
      : ids.some((id) => ['legacy-lock', 'unknown-lock'].includes(id))
        ? 'refused-lock'
        : 'blocked'
    stop = { reason, detail: planBlockers[0] }
  }

  if (inventory?.pendingJournal) add('interrupted', 'An earlier apply did not finish')
  for (const message of planBlockers) add(blockerId(message), message)
  if (stop) {
    const lock = /unknown|malformed|unrecognized/i.test(stop.detail ?? '')
      ? 'unknown-lock'
      : 'legacy-lock'
    const mapped = { 'refused-lock': lock, blocked: null, error: 'plan-error' }
    const id = Object.hasOwn(mapped, stop.reason) ? mapped[stop.reason] : stop.reason
    if (id && !(blockers.some((item) => item.id === id) && planBlockers.length))
      add(id, stop.detail)
  }

  const actions = Array.isArray(projectPlan?.actions) ? projectPlan.actions : []
  const pendingWrites = actions.filter(
    (item) =>
      WRITES.includes(item.action) &&
      (item.ownership !== 'project' || item.action === 'create' || item.action === 'update'),
  )
  const installed = Boolean(
    inventory?.lock?.format === 'v2' &&
    !inventory?.pendingJournal &&
    projectPlan &&
    !projectPlan.blocked &&
    pendingWrites.length === 0 &&
    !['conflicting', 'unknown', 'legacy'].includes(inventory?.classification),
  )
  // Before a preview exists, the step is to preview; after one, it is to confirm it.
  if (!installed && pendingWrites.length && !blockers.length)
    add(
      stage === 'plan' ? 'pending-writes' : 'not-installed',
      `${pendingWrites.length} file(s) wait for a confirmed apply`,
    )
  const config = effectiveConfig(inventory, projectPlan)
  const checked = hasCheck(config)
  if (config && !checked)
    add('no-check', 'No test command or check is configured, so no change can be verified')

  const runtimeState = runtimeStatus(runtime)
  if (runtimeState.status === 'not-ready')
    add('runtime-not-ready', 'The runtime reported missing, outdated, or unknown components')

  const order = STEPS.map(([id]) => id)
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length)
  const first = [...blockers].sort((a, b) => rank(a.id) - rank(b.id))[0]
  const step = first ? STEPS.find(([id]) => id === first.id) : null
  const target = targetDir ? quote(targetDir) : '<project>'
  const doc = step && journey === 'refinement' ? (REFINEMENT_STEPS[step[0]] ?? step[2]) : step?.[2]
  let nextAction = step ? { id: step[0], step: step[1], doc } : { ...FIRST_CHANGE }
  if (nextAction.id === 'interrupted' && recoveryToken)
    nextAction = {
      ...nextAction,
      command: `agentflow-sdlc onboarding recover --target ${target} --confirm ${recoveryToken}`,
    }

  const receiptPath = receipt?.receiptPath ?? receipt?.externalReceiptDestination ?? null
  const undo =
    receipt?.receiptToken && receiptPath
      ? {
          command: `agentflow-sdlc onboarding undo --target ${target} --receipt ${quote(receiptPath)} --confirm ${receipt.receiptToken}`,
          doc: `${journey === 'refinement' ? REFINEMENT_PAGE : ADOPTION_PAGE}#undo`,
        }
      : null

  return {
    version: 1,
    journey,
    stage,
    outcome: stop ? 'stopped' : 'completed',
    stop: stop ? { reason: stop.reason, detail: stop.detail } : null,
    project: { ready: installed && checked, installed, checkConfigured: checked },
    runtime: runtimeState,
    governedChange: { ...GOVERNED_CHANGE },
    choices: {
      confirmed,
      migrateLegacy: Boolean(choices?.migrateLegacy),
      recoverUnknown: Boolean(choices?.recoverUnknown),
      resolutions: { ...(choices?.resolutions ?? {}) },
      config: Object.keys(choices?.config ?? {}).sort(),
      deferUpdate: Boolean(choices?.deferUpdate),
      harness: choices?.harness !== false,
      runtime: runtime ? 'checked' : 'deferred',
    },
    blockers,
    nextAction,
    undo,
    recover: recoveryToken
      ? {
          command: `agentflow-sdlc onboarding recover --target ${target} --confirm ${recoveryToken}`,
          doc: `${ADOPTION_PAGE}#recover-an-interrupted-apply`,
        }
      : null,
  }
}
