import { WORK_KINDS } from './work-altitude.mjs'

// One projection for a work record on GitHub. The body marker is the kind. The title prefix and
// the kind label must name that same kind. `Part of #n` is the only parent. `**Epic:**` may repeat
// that number and must not name another. A record with no kind is legacy and must not wear this
// projection.
//
// A not-yet-admitted part is a breakdown note: the capability title, the kind:capability label, one
// `Part of`, and no work marker. An admitted capability may name the one note it replaces with a
// `Replaces #<note>` line. That line is the only replacement authority. It sets no parent, and the
// note is never edited. A goal's current parts are its admitted records plus the notes nothing
// replaces.

const MARKER = /^<!-- agentflow-work:(\{.*\}) -->$/m
const KIND_LINE = /^\*\*Kind:\*\*\s*(\S+)\s*$/m
// A whole line, so prose that mentions a parent is not a claim.
const PART_OF = /^Part of #(\d+)[ \t]*$/gim
const EPIC = /\*\*Epic:\*\*\s*#(\d+)\b/g
// A whole line, so prose that mentions a replaced issue is not a claim.
const REPLACES = /^Replaces #(\d+)[ \t]*$/gim

export function kindLabel(kind) {
  return `kind:${kind}`
}

export function projectedTitle(kind, title) {
  const text = String(title ?? '').trim()
  const own = `${kind}:`
  if (text === own || text.startsWith(`${own} `)) return text
  const other = WORK_KINDS.find((item) => text === `${item}:` || text.startsWith(`${item}: `))
  if (other) throw new Error(`The title says ${other}, not ${kind}`)
  return `${own} ${text}`
}

function unique(values) {
  return [...new Set(values)]
}

export function parseWorkMarker(body = '') {
  const match = String(body).match(MARKER)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    return { kind: parsed.kind ?? null }
  } catch {
    return { kind: null, malformed: true }
  }
}

function proseKind(body = '') {
  return String(body).match(KIND_LINE)?.[1] ?? null
}

function parentNumbers(body = '') {
  return unique([...String(body).matchAll(PART_OF)].map((match) => match[1]))
}

function epicNumbers(body = '') {
  return unique([...String(body).matchAll(EPIC)].map((match) => match[1]))
}

function replacedNumbers(body = '') {
  return unique([...String(body).matchAll(REPLACES)].map((match) => match[1]))
}

// The body without its replacement line and the line breaks that set it apart. A replacement does
// not move what a person agreed. Every other byte is kept, so no existing subject moves.
const REPLACES_BLOCK = /(?:\r?\n)*^Replaces #\d+[ \t]*$/gim

export function withoutReplaces(body = '') {
  return String(body).replace(REPLACES_BLOCK, '')
}

export function withoutPartsLedger(body = '') {
  const lines = String(body).split(/\r?\n/)
  const startIdx = lines.findIndex((l) =>
    /^##\s+(?:Child Work & History|Parts Ledger)\s*$/i.test(l.trim()),
  )
  if (startIdx === -1) return String(body)

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIdx = i
      break
    }
  }

  const before = lines.slice(0, startIdx)
  const after = lines.slice(endIdx)
  return [...before, ...after].join('\n')
}

function labelNames(labels = []) {
  return labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
}

function kindLabels(labels = []) {
  return labelNames(labels).filter((label) => WORK_KINDS.some((kind) => label === kindLabel(kind)))
}

function titleKind(title = '') {
  return WORK_KINDS.find((kind) => title === `${kind}:` || String(title).startsWith(`${kind}: `))
}

// What a record is: a goal, a capability, a spec, a not-yet-admitted note, or legacy.
export function workShape({ title = '', body = '', labels = [] } = {}) {
  const marker = parseWorkMarker(body)
  if (marker) return WORK_KINDS.includes(marker.kind) ? marker.kind : 'invalid'
  const named = proseKind(body)
  const worn = kindLabels(labels)
  if (
    (named === null || named === 'capability') &&
    titleKind(title) === 'capability' &&
    worn.length === 1 &&
    worn[0] === kindLabel('capability')
  )
    return 'note'
  return named ? 'invalid' : 'legacy'
}

function parentFindings(body, kind, requirePartOf) {
  const parents = parentNumbers(body)
  const epics = epicNumbers(body)
  if (kind === 'goal') {
    return parents.length || epics.length ? ['a goal has no parent'] : []
  }
  if (parents.length > 1 || (requirePartOf && parents.length !== 1)) {
    return kind === 'note'
      ? ['a not-yet-admitted part needs one Part of #<parent>']
      : ['a capability or a spec needs one Part of #<parent>']
  }
  if (epics.length && parents.length !== 1) {
    return ['**Epic:** cannot name a parent without Part of #']
  }
  if (parents.length === 1 && epics.some((number) => number !== parents[0])) {
    return [`**Epic:** must repeat Part of #${parents[0]} and no other parent`]
  }
  return []
}

// Findings for one issue. An empty list means the projection agrees, or the issue is legacy.
// `number`, when known, lets a record that replaces itself be refused without the record set.
export function workProjectionFindings(
  { number = null, title = '', body = '', labels = [] } = {},
  options = {},
) {
  const requirePartOf = options.requirePartOf !== false
  const findings = []
  const marker = parseWorkMarker(body)
  const named = proseKind(body)
  const worn = kindLabels(labels)
  const replaces = replacedNumbers(body)

  if (!marker && workShape({ title, body, labels }) === 'note') {
    findings.push(...parentFindings(body, 'note', true))
    if (replaces.length) findings.push('only an admitted capability can name Replaces #<note>')
    return findings
  }
  if (!marker && !named) {
    const legacyTitle = titleKind(title)
    if (legacyTitle)
      findings.push(`a record with no kind cannot use the title prefix ${legacyTitle}:`)
    if (worn.length) findings.push(`a record with no kind cannot wear ${worn.join(', ')}`)
    if (replaces.length) findings.push('only an admitted capability can name Replaces #<note>')
    return findings
  }
  if (marker?.malformed) findings.push('the work marker is not valid JSON')
  if (!marker) findings.push('the body names a kind but has no work marker')
  const kind = marker?.kind ?? null
  if (marker && !WORK_KINDS.includes(kind))
    findings.push(`the work marker kind is ${kind ?? 'missing'}`)
  if (named && kind && named !== kind) findings.push(`**Kind:** says ${named}, not ${kind}`)
  if (!WORK_KINDS.includes(kind)) return findings

  if (titleKind(title) !== kind) {
    findings.push(`the title must start with ${kind}:`)
  }
  const expected = kindLabel(kind)
  if (!worn.includes(expected) || worn.length !== 1) {
    findings.push(`the issue must wear ${expected} and no other kind label`)
  }
  findings.push(...parentFindings(body, kind, requirePartOf))

  if (replaces.length && kind !== 'capability') {
    findings.push(`a ${kind} cannot replace a record; only an admitted capability can`)
  } else if (replaces.length > 1) {
    findings.push('a capability replaces at most one note')
  } else if (replaces.length && number !== null && replaces[0] === String(number)) {
    findings.push('a record cannot replace itself')
  }
  return findings
}

const NOT_A_NOTE = {
  goal: 'a goal',
  spec: 'a spec',
  capability: 'an admitted capability',
}

// Which note each admitted capability replaces, over one set of records. Each record carries its
// issue number. The lower number keeps a contested note, so the result does not depend on the
// order a medium lists its records in.
function resolveReplacements(records = []) {
  const byNumber = new Map()
  for (const record of records) {
    if (record?.number !== undefined && record?.number !== null)
      byNumber.set(String(record.number), record)
  }
  const replacers = [...byNumber.entries()]
    .filter(([, record]) => workShape(record) === 'capability')
    .map(([number, record]) => ({ number, record, replaces: replacedNumbers(record.body) }))
    .filter((item) => item.replaces.length)
    .sort((a, b) => Number(a.number) - Number(b.number))

  const replacedBy = new Map()
  const findings = []
  const refuse = (number, message) => findings.push({ number: Number(number), message })
  for (const { number, record, replaces } of replacers) {
    if (replaces.length > 1) {
      refuse(number, 'a capability replaces at most one note')
      continue
    }
    const [note] = replaces
    if (note === number) {
      refuse(number, 'a record cannot replace itself')
      continue
    }
    const target = byNumber.get(note)
    if (!target) {
      refuse(number, `Replaces #${note}, which is not in the record set`)
      continue
    }
    const shape = workShape(target)
    if (shape !== 'note') {
      refuse(number, `cannot replace #${note}, ${NOT_A_NOTE[shape] ?? 'which is not a part'}`)
      continue
    }
    const [own] = parentNumbers(record.body)
    const [theirs] = parentNumbers(target.body)
    if (own !== theirs) {
      refuse(number, `cannot replace #${note}, which is part of #${theirs}, not #${own}`)
      continue
    }
    if (replacedBy.has(note)) {
      refuse(number, `#${note} is already replaced by #${replacedBy.get(note)}`)
      continue
    }
    replacedBy.set(note, number)
  }
  return { byNumber, replacedBy, findings }
}

// Findings for a set of records: a double, cross-parent, or invalid replacement. Each finding
// names the record that makes the claim.
export function replacementFindings(records) {
  return resolveReplacements(records).findings
}

// The record that replaces a note, or null. The note itself is read unchanged.
export function replacementOf(records, number) {
  const by = resolveReplacements(records).replacedBy.get(String(number))
  return by ? Number(by) : null
}

// The current parts of a parent: each admitted child once, and each note nothing replaces, marked
// as not yet admitted. A replaced note is listed under `replaced` with its replacement.
export function currentParts(records, parent) {
  const { byNumber, replacedBy } = resolveReplacements(records)
  const current = []
  const replaced = []
  for (const [number, record] of byNumber) {
    const parents = parentNumbers(record.body)
    if (parents.length !== 1 || parents[0] !== String(parent)) continue
    const shape = workShape(record)
    if (shape === 'note' && replacedBy.has(number)) {
      replaced.push({ number: Number(number), by: Number(replacedBy.get(number)) })
    } else if (shape === 'note' || shape === 'capability' || shape === 'spec') {
      current.push({
        number: Number(number),
        title: record.title,
        kind: shape === 'note' ? 'capability' : shape,
        admitted: shape !== 'note',
      })
    }
  }
  const byOrder = (a, b) => a.number - b.number
  return { current: current.sort(byOrder), replaced: replaced.sort(byOrder) }
}

export function assertWorkProjection(issue, options) {
  const findings = workProjectionFindings(issue, options)
  if (findings.length) throw new Error(findings.join('; '))
}

function extractPrReference(record) {
  if (!record) return null
  const texts = [record.body ?? '']
  if (Array.isArray(record.comments)) {
    for (const c of record.comments) {
      texts.push(typeof c === 'string' ? c : (c?.body ?? ''))
    }
  }
  for (const text of texts) {
    const match = text.match(/(?:by PR #|via PR #|Merged in #|PR #)(\d+)/i)
    if (match) return Number(match[1])
  }
  return null
}

function extractCommitReference(record) {
  if (!record) return null
  const texts = [record.body ?? '']
  if (Array.isArray(record.comments)) {
    for (const c of record.comments) {
      texts.push(typeof c === 'string' ? c : (c?.body ?? ''))
    }
  }
  for (const text of texts) {
    const match = text.match(/Merge commit:\s*`?([0-9a-f]{7,40})`?/i)
    if (match) return match[1].slice(0, 7)
  }
  return null
}

/**
 * Calculates aggregated completion stats for a goal across its child parts.
 *
 * @param {Array<Object>} records - Full set of issue records.
 * @param {number|string} goalNumber - The goal issue number.
 * @returns {Object} Child completion status object:
 *   - total: number of current parts
 *   - admitted: number of admitted parts
 *   - unadmittedNotes: number of breakdown notes not yet admitted
 *   - delivered: number of delivered parts
 *   - open: number of open / undelivered parts
 *   - readyForClosure: boolean (true if total > 0, unadmittedNotes === 0, open === 0)
 *   - statusMessage: human-readable status summary
 *   - parts: array of resolved part details
 */
export function goalChildCompletionStatus(records = [], goalNumber) {
  const partsInfo = currentParts(records, goalNumber)
  const byNumber = new Map()
  for (const r of records) {
    if (r?.number !== undefined && r?.number !== null) {
      byNumber.set(String(r.number), r)
    }
  }

  const parts = []
  let deliveredCount = 0
  let admittedCount = 0
  let unadmittedCount = 0

  for (const part of partsInfo.current) {
    const record = byNumber.get(String(part.number))
    const admitted = Boolean(part.admitted)
    if (admitted) admittedCount++
    else unadmittedCount++

    const stateStr = String(record?.state ?? '').toLowerCase()
    const labels = labelNames(record?.labels ?? [])
    const isClosed = stateStr === 'closed'
    const hasDeliveredLabel =
      labels.includes('state:delivered') || labels.some((l) => l.startsWith('integrated:'))
    const isDelivered = isClosed || hasDeliveredLabel

    if (isDelivered) deliveredCount++

    const deliveryPr =
      record?.deliveryPr ??
      record?.mergedPr ??
      record?.pull_request?.number ??
      extractPrReference(record) ??
      null
    const commit = record?.mergeCommit ?? record?.commit ?? extractCommitReference(record) ?? null
    const date = record?.closed_at
      ? String(record.closed_at).slice(0, 10)
      : record?.deliveredAt
        ? String(record.deliveredAt).slice(0, 10)
        : null

    const replacedEntry = partsInfo.replaced.find((rp) => String(rp.by) === String(part.number))
    const replacement = replacedEntry ? `#${replacedEntry.number}` : null

    parts.push({
      number: part.number,
      kind: part.kind,
      title: part.title,
      admitted,
      delivered: isDelivered,
      state: isDelivered ? 'delivered' : admitted ? 'open' : 'unadmitted',
      replacement,
      deliveryPr,
      commit,
      date,
    })
  }

  const total = parts.length
  const openCount = total - deliveredCount
  const readyForClosure = total > 0 && unadmittedCount === 0 && openCount === 0

  let statusMessage = ''
  if (total === 0) {
    statusMessage = 'No child parts defined'
  } else if (readyForClosure) {
    statusMessage = 'All child capabilities delivered — ready for person review/closure'
  } else {
    statusMessage = `${deliveredCount} of ${total} child parts delivered (${openCount} remaining)`
  }

  return {
    goalNumber: Number(goalNumber),
    total,
    admitted: admittedCount,
    unadmittedNotes: unadmittedCount,
    delivered: deliveredCount,
    open: openCount,
    readyForClosure,
    statusMessage,
    parts,
    replacedNotes: partsInfo.replaced,
  }
}

/**
 * Renders the markdown content for ## Child Work & History (or ## Parts Ledger).
 *
 * @param {Array<Object>} records - Full set of issue records.
 * @param {number|string} goalNumber - The goal issue number.
 * @param {Object} [options]
 * @returns {string} Markdown text for the section.
 */
export function renderGoalPartsLedger(records = [], goalNumber, options = {}) {
  const status = goalChildCompletionStatus(records, goalNumber)
  const lines = []

  lines.push(`> **Status:** ${status.statusMessage}`)
  if (status.total > 0) {
    const pct = Math.round((status.delivered / status.total) * 100)
    lines.push(`> **Progress:** ${status.delivered}/${status.total} delivered (${pct}%)`)
  }
  lines.push('')

  lines.push('| Part | Kind | Title | Status | Replacement | Delivery PR | Commit | Date |')
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |')

  if (status.parts.length === 0) {
    lines.push('| — | — | No parts defined | — | — | — | — | — |')
  } else {
    for (const p of status.parts) {
      const partCol = `#${p.number}`
      const kindCol = p.kind
      const titleCol = String(p.title ?? '').replace(/\|/g, '\\|')
      const statusCol = p.delivered ? 'Delivered' : p.admitted ? 'In Progress' : 'Not yet admitted'
      const repCol = p.replacement ? `Replaces ${p.replacement}` : '—'
      const prCol = p.deliveryPr ? `#${p.deliveryPr}` : '—'
      const commitCol = p.commit ? `\`${p.commit}\`` : '—'
      const dateCol = p.date ?? '—'

      lines.push(
        `| ${partCol} | ${kindCol} | ${titleCol} | ${statusCol} | ${repCol} | ${prCol} | ${commitCol} | ${dateCol} |`,
      )
    }
  }

  return lines.join('\n')
}

export function parseGoalPartsLedger(body = '') {
  const allLines = String(body).split(/\r?\n/)
  const startIdx = allLines.findIndex((l) =>
    /^##\s+(?:Child Work & History|Parts Ledger)\s*$/i.test(l.trim()),
  )
  if (startIdx === -1) return null

  let endIdx = allLines.length
  for (let i = startIdx + 1; i < allLines.length; i++) {
    if (allLines[i].startsWith('## ')) {
      endIdx = i
      break
    }
  }

  const content = allLines
    .slice(startIdx + 1, endIdx)
    .join('\n')
    .trim()
  const statusMatch = content.match(/>\s*\*\*Status:\*\*\s*(.+)$/m)
  const progressMatch = content.match(/>\s*\*\*Progress:\*\*\s*(.+)$/m)
  const statusMessage = statusMatch ? statusMatch[1].trim() : ''
  const progress = progressMatch ? progressMatch[1].trim() : ''
  const readyForClosure = /ready for (?:person )?review\/closure/i.test(statusMessage)

  const rows = []
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || trimmed.startsWith('| :---') || trimmed.startsWith('| Part')) {
      continue
    }
    const cols = trimmed
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cols.length >= 4) {
      const partMatch = cols[0].match(/#(\d+)/)
      if (partMatch) {
        rows.push({
          partNumber: Number(partMatch[1]),
          part: cols[0],
          kind: cols[1],
          title: cols[2],
          status: cols[3],
          replacement: cols[4] || '—',
          deliveryPr: cols[5] || '—',
          commit: cols[6] || '—',
          date: cols[7] || '—',
        })
      }
    }
  }

  return {
    raw: content,
    statusMessage,
    progress,
    readyForClosure,
    rows,
  }
}

export function goalLedgerFindings(goalRecord = {}, records = []) {
  const findings = []
  const parsed = parseGoalPartsLedger(goalRecord.body)
  if (!parsed) {
    return findings
  }

  const expectedStatus = goalChildCompletionStatus(records, goalRecord.number)

  if (expectedStatus.total > 0 && parsed.rows.length === 0) {
    findings.push('goal parts ledger table is empty or malformed')
    return findings
  }

  const parsedNumbers = new Set(parsed.rows.map((r) => r.partNumber))
  const expectedNumbers = new Set(expectedStatus.parts.map((p) => p.number))

  for (const num of expectedNumbers) {
    if (!parsedNumbers.has(num)) {
      findings.push(`goal parts ledger is missing part #${num}`)
    }
  }

  for (const num of parsedNumbers) {
    if (!expectedNumbers.has(num)) {
      findings.push(`goal parts ledger contains unexpected part #${num}`)
    }
  }

  for (const row of parsed.rows) {
    const expectedPart = expectedStatus.parts.find((p) => p.number === row.partNumber)
    if (!expectedPart) continue

    const rowDelivered = row.status.toLowerCase() === 'delivered'
    if (expectedPart.delivered && !rowDelivered) {
      findings.push(
        `goal parts ledger status desynchronized for part #${row.partNumber}: record is delivered but ledger says ${row.status}`,
      )
    } else if (!expectedPart.delivered && rowDelivered) {
      findings.push(
        `goal parts ledger status desynchronized for part #${row.partNumber}: record is not delivered but ledger says Delivered`,
      )
    }
  }

  if (expectedStatus.readyForClosure && !parsed.readyForClosure) {
    findings.push('goal parts ledger does not reflect ready-for-closure milestone')
  } else if (!expectedStatus.readyForClosure && parsed.readyForClosure) {
    findings.push('goal parts ledger prematurely claims ready-for-closure')
  }

  return findings
}
