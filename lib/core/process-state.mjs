// The visible process state is a projection of the phase record plus one integration fact.
// It is not a second state machine: no state is stored, and every medium reads it the same way.

export const PROCESS_STATES = Object.freeze([
  { id: 'backlog', name: 'Backlog', label: 'state:backlog' },
  { id: 'readiness', name: 'Readiness', label: 'state:readiness' },
  { id: 'wip', name: 'WIP', label: 'state:wip' },
  { id: 'delivered', name: 'Delivered', label: 'state:delivered' },
])

export const PROCESS_STATE_IDS = Object.freeze(PROCESS_STATES.map((state) => state.id))
export const PROCESS_STATE_LABELS = Object.freeze(PROCESS_STATES.map((state) => state.label))
export const STATE_LABEL_PREFIX = 'state:'

// Progress markers from before the projection. The product reads none of them as a state and
// writes none of them.
export const RETIRED_STATUS_LABELS = Object.freeze([
  'status:in-progress',
  'status:backlog',
  'status:v1-ready',
  'status:superseded',
])

const FIXED = PROCESS_STATES.map((state) => state.name).join(', ')

export function processStateSpec(id) {
  return PROCESS_STATES.find((state) => state.id === id) ?? null
}

function latestApplied(transitions) {
  const applied = transitions.filter((item) => item.status === 'pass' || item.status === 'skipped')
  return applied.length ? applied[applied.length - 1] : null
}

function returnTarget(transition) {
  if (transition.status !== 'skipped') return null
  const named = String(transition.reason ?? '').match(/return to phase (\d+)/i)?.[1]
  return named === undefined ? null : Number(named)
}

/**
 * Projects one process state from the phase record and the integration fact.
 * The integration fact wins. A closed item without it has no state and returns null.
 */
export function projectProcessState({ transitions = [], integration = null, closed = false } = {}) {
  if (integration) return 'delivered'
  if (closed) return null
  const latest = latestApplied(transitions)
  if (!latest) return 'backlog'
  const back = returnTarget(latest)
  if (back === 0 || back === 1) return 'backlog'
  if (latest.phase === 0) return 'backlog'
  if (latest.phase === 1) return latest.status === 'pass' && back === null ? 'readiness' : 'backlog'
  return 'wip'
}

/**
 * Groups items into the four states, in fixed order. Each item carries the projection inputs.
 * Items without a state are left off the board and counted, with their close reason.
 */
export function buildBoard(items = []) {
  const groups = PROCESS_STATES.map((state) => ({ ...state, items: [] }))
  const excluded = []
  for (const item of items) {
    const state = projectProcessState(item)
    const entry = { id: item.id, title: item.title ?? '', uri: item.uri ?? null }
    if (state === null) {
      excluded.push({ ...entry, state: null, closeReason: item.closeReason ?? null })
      continue
    }
    groups.find((group) => group.id === state).items.push(entry)
  }
  return { groups, excludedCount: excluded.length, excluded }
}

export function renderBoard(board) {
  const lines = []
  for (const group of board.groups) {
    lines.push(`${group.name} (${group.items.length})`)
    for (const item of group.items) lines.push(`  ${item.id}  ${item.title}`)
  }
  lines.push(`Not on the board: ${board.excludedCount} closed without an integration fact`)
  return lines.join('\n')
}

/**
 * Checks a declared process-state vocabulary. Packs and profiles may omit it. When they declare
 * one, it must be exactly the four fixed states.
 */
export function validateProcessStateVocabulary(declared, { field = 'processStates' } = {}) {
  if (declared === undefined) return { ok: true, errors: [] }
  const values = Array.isArray(declared) ? declared : [declared]
  const normalized = values.map((value) =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^state:/, ''),
  )
  const same =
    normalized.length === PROCESS_STATE_IDS.length &&
    new Set(normalized).size === normalized.length &&
    normalized.every((value) => PROCESS_STATE_IDS.includes(value))
  if (same) return { ok: true, errors: [] }
  return {
    ok: false,
    errors: [`${field} cannot add or rename a process state; the fixed states are ${FIXED}`],
  }
}

/** Rejects any `state:` label that is not one of the four fixed state labels. */
export function validateStateLabels(labels = [], { field = 'labels' } = {}) {
  const unknown = labels.filter(
    (label) =>
      typeof label === 'string' &&
      label.startsWith(STATE_LABEL_PREFIX) &&
      !PROCESS_STATE_LABELS.includes(label),
  )
  if (!unknown.length) return { ok: true, errors: [] }
  return {
    ok: false,
    errors: [
      `${field} declares ${unknown.join(', ')}; a process state cannot be added or renamed, the fixed states are ${FIXED}`,
    ],
  }
}
