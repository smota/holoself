import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSeatId, readSeatLease } from './seat-lease.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const VALID_SITUATIONS = Object.freeze(['fresh', 'handover', 'post-compaction', 'reviewer'])

export const OUTCOME_ENUM = Object.freeze([
  'delivered',
  'no_change',
  'feasible_work_remains_same_worker',
  'concrete_blocker',
  'unknown_outcome',
  'repeated_failure',
])

export const QUEUE_ACTION_ENUM = Object.freeze(['close', 'handoff', 'keep_open'])
export const DOMAIN_STATUS_ENUM = Object.freeze(['in_progress', 'slice_complete', 'goal_complete'])

export function resolveSeatPathBoundaries(seat) {
  if (seat.startsWith('pm.')) {
    return {
      allow: ['.agentflow/**', 'goals/**'],
      deny: ['src/**', 'lib/**', 'tests/**'],
      defaultDeny: true,
    }
  }
  if (seat.startsWith('steer.')) {
    return {
      allow: [],
      deny: ['**'],
      defaultDeny: true,
      readOnly: true,
      canDeclareGoalComplete: true,
    }
  }
  if (seat.startsWith('dev.build')) {
    return {
      allow: ['src/**', 'lib/**', 'scripts/**', 'bin/**', 'schemas/**', 'adapters/**'],
      deny: ['tests/oracles/**', 'tests/**/oracles/**'],
      defaultDeny: false,
      requiresPhase3OraclePin: true,
    }
  }
  if (seat === 'dev.test-eng') {
    return {
      allow: ['tests/**', 'lib/__tests__/**', 'scripts/__tests__/**', 'guidance/**'],
      deny: ['src/**'],
      defaultDeny: true,
    }
  }
  if (seat === 'dev.qa') {
    return {
      allow: ['tests/**', '.agent-runs/**'],
      deny: ['src/**', 'tests/oracles/**'],
      defaultDeny: true,
    }
  }
  if (seat.startsWith('rev.')) {
    return {
      allow: [],
      deny: ['**'],
      defaultDeny: true,
      readOnly: true,
    }
  }
  if (seat.startsWith('orch.')) {
    return {
      allow: ['.agentflow/**', 'docs/**', 'specs/**'],
      deny: ['src/**'],
      defaultDeny: true,
    }
  }
  return {
    allow: ['**'],
    deny: ['tests/oracles/**', 'tests/**/oracles/**'],
    defaultDeny: false,
  }
}

export function slugifyHeading(headingText) {
  return String(headingText)
    .trim()
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function extractMarkdownH2Pointers(relPath, content) {
  const pointers = []
  const digests = {}
  const lines = String(content).split(/\r?\n/)
  let inFence = false
  let currentSlug = null
  let currentLines = []

  const flush = () => {
    if (!currentSlug) return
    const ref = `${relPath}#${currentSlug}`
    pointers.push(ref)
    digests[ref] = createHash('sha256').update(currentLines.join('\n')).digest('hex').slice(0, 12)
  }

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence
    }
    if (!inFence && /^##\s+(.+)$/.test(line)) {
      flush()
      const match = line.match(/^##\s+(.+)$/)
      currentSlug = slugifyHeading(match[1])
      currentLines = [line]
    } else if (currentSlug) {
      currentLines.push(line)
    }
  }
  flush()
  return { pointers, digests }
}

function unquoteYamlScalar(raw) {
  const trimmed = String(raw ?? '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseWorldManifestYaml(rawYaml) {
  const lines = String(rawYaml ?? '').split(/\r?\n/)
  const manifest = {
    schema: 'openrig.context-pack/v1',
    name: 'agentflow-world',
    taxonomy: 'world',
    description: '',
    atoms: [],
  }

  let currentAtom = null
  let activeListKey = null
  let inProbe = false
  let inExpectedPatterns = false

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const topMatch = rawLine.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (topMatch) {
      const [, key, val] = topMatch
      if (key === 'atoms') {
        currentAtom = null
        activeListKey = null
        inProbe = false
        inExpectedPatterns = false
        continue
      }
      manifest[key] = unquoteYamlScalar(val)
      continue
    }

    const atomStart = rawLine.match(/^\s{2}-\s+([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (atomStart) {
      if (currentAtom) manifest.atoms.push(currentAtom)
      currentAtom = {
        regions: [],
        situations: [],
        probe: { prompt: '', expect: '', expectedPatterns: [] },
      }
      const [, firstKey, firstVal] = atomStart
      currentAtom[firstKey] = unquoteYamlScalar(firstVal)
      activeListKey = null
      inProbe = false
      inExpectedPatterns = false
      continue
    }

    if (!currentAtom) continue

    const propMatch = rawLine.match(/^\s{4}([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (propMatch) {
      const [, key, rawVal] = propMatch
      const val = rawVal.trim()
      activeListKey = null
      inExpectedPatterns = false

      if (key === 'probe') {
        inProbe = true
        currentAtom.probe = { prompt: '', expect: '', expectedPatterns: [] }
        continue
      }
      inProbe = false

      if (val === '') {
        currentAtom[key] = []
        activeListKey = key
        continue
      }

      if (val.startsWith('[') && val.endsWith(']')) {
        const inner = val.slice(1, -1).trim()
        currentAtom[key] = inner
          ? inner.split(',').map((item) => unquoteYamlScalar(item.trim()))
          : []
        continue
      }

      if (key === 'order' && /^\d+$/.test(val)) {
        currentAtom[key] = Number(val)
      } else if (key === 'profile_only' && (val === 'true' || val === 'false')) {
        currentAtom[key] = val === 'true'
      } else {
        currentAtom[key] = unquoteYamlScalar(val)
      }
      continue
    }

    if (activeListKey && /^\s{6}-\s*(.+)$/.test(rawLine)) {
      const itemVal = unquoteYamlScalar(rawLine.match(/^\s{6}-\s*(.+)$/)[1])
      if (!Array.isArray(currentAtom[activeListKey])) currentAtom[activeListKey] = []
      currentAtom[activeListKey].push(itemVal)
      continue
    }

    if (inProbe) {
      const probeProp = rawLine.match(/^\s{6}([a-zA-Z0-9_-]+):\s*(.*)$/)
      if (probeProp) {
        const [, pKey, pRawVal] = probeProp
        const pVal = pRawVal.trim()
        if (pKey === 'expectedPatterns') {
          if (pVal.startsWith('[') && pVal.endsWith(']')) {
            const inner = pVal.slice(1, -1).trim()
            currentAtom.probe.expectedPatterns = inner
              ? inner.split(',').map((item) => unquoteYamlScalar(item.trim()))
              : []
            inExpectedPatterns = false
          } else {
            currentAtom.probe.expectedPatterns = []
            inExpectedPatterns = true
          }
        } else {
          inExpectedPatterns = false
          currentAtom.probe[pKey] = unquoteYamlScalar(pVal)
        }
        continue
      }
      if (inExpectedPatterns && /^\s{8}-\s*(.+)$/.test(rawLine)) {
        currentAtom.probe.expectedPatterns.push(
          unquoteYamlScalar(rawLine.match(/^\s{8}-\s*(.+)$/)[1]),
        )
        continue
      }
    }
  }
  if (currentAtom) manifest.atoms.push(currentAtom)
  return manifest
}

function normalizeAtom(atom) {
  const address = atom.address || atom.source || ''
  const regions =
    Array.isArray(atom.regions) && atom.regions.length > 0
      ? atom.regions
      : atom.region
        ? [atom.region]
        : []
  const region = regions[0] || ''
  const situations = Array.isArray(atom.situations) ? atom.situations : []
  const purpose = atom.purpose || 'depth'
  const priority = atom.priority || 'core'
  const order = typeof atom.order === 'number' ? atom.order : null
  const summary = atom.summary || atom.probe?.expect || `${purpose} (${regions.join(', ')})`
  return {
    id: atom.id,
    address,
    source: address,
    regions,
    region,
    situations,
    purpose,
    priority,
    order,
    summary,
    probe: atom.probe || { prompt: '', expect: '', expectedPatterns: [] },
  }
}

function loadL1WorldManifest() {
  // Always load L1 from the packaged framework root to prevent targetDir spoofing of L1 law
  const canonicalPath = join(packageRoot, 'adapters/openrig/agentflow-world/manifest.yaml')
  if (existsSync(canonicalPath)) {
    return {
      manifestPath: canonicalPath,
      manifest: parseWorldManifestYaml(readFileSync(canonicalPath, 'utf8')),
    }
  }
  return {
    manifestPath: null,
    manifest: {
      schema: 'openrig.context-pack/v1',
      name: 'agentflow-world',
      taxonomy: 'world',
      description: 'Fallback L1 AgentFlow world pack',
      atoms: [],
    },
  }
}

function composeL1Layer(_targetDir, { seat, situation }) {
  const { manifestPath, manifest } = loadL1WorldManifest()
  const effectiveSituation = situation === 'reviewer' ? 'fresh' : situation
  const normalizedAtoms = manifest.atoms.map(normalizeAtom)
  const matchingAtoms = normalizedAtoms.filter(
    (atom) => atom.situations.length === 0 || atom.situations.includes(effectiveSituation),
  )
  const pathBoundaries = resolveSeatPathBoundaries(seat)
  const pointers = matchingAtoms.map((atom) => atom.address).filter(Boolean)

  if (situation === 'post-compaction') {
    return {
      packName: manifest.name,
      manifestPath,
      mode: 'pointers-only',
      pointers: [...new Set(['AGENTS.md#path-ownership-boundaries', ...pointers])],
      atoms: matchingAtoms.map((atom) => ({
        id: atom.id,
        address: atom.address,
        source: atom.address,
        regions: atom.regions,
        region: atom.region,
      })),
      seatContract: {
        seat,
        pointer: 'AGENTS.md#path-ownership-boundaries',
        outcomes: [...OUTCOME_ENUM],
      },
    }
  }

  return {
    packName: manifest.name,
    manifestPath,
    mode: 'compact-contract',
    pointers,
    atoms: matchingAtoms.map((atom) => ({
      id: atom.id,
      address: atom.address,
      source: atom.address,
      regions: atom.regions,
      region: atom.region,
      purpose: atom.purpose,
      priority: atom.priority,
      order: atom.order,
      summary: atom.summary,
      probe: atom.probe,
    })),
    seatContract: {
      seat,
      pathBoundaries,
      outcomes: [...OUTCOME_ENUM],
      primitives: {
        outcome: [...OUTCOME_ENUM],
        queueAction: [...QUEUE_ACTION_ENUM],
        domainStatus: [...DOMAIN_STATUS_ENUM],
      },
      hotPotatoRule:
        'Active work ends by dispatching a transition envelope (`agentflow-sdlc dispatch`), never by going idle. Only `steer.lead` or `human` may set `domainStatus=goal_complete`.',
      ...(situation === 'reviewer'
        ? {
            reviewerIsolation: {
              blindToBuilderReasoning: true,
              verifyAgainst: ['SPEC.md', 'acceptance-criteria', 'deterministic-tests'],
            },
          }
        : {}),
    },
  }
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function composeL2Layer(targetDir, { seat, situation }) {
  const root = resolve(targetDir)
  const warnings = []
  const domainFiles = [
    '.agentflow/world/manifest.yaml',
    'AGENTS.md',
    '.agentflow/PRODUCT.md',
    'docs/stack-conventions.md',
    'sdlc.config.json',
    'agent-workflow.config.json',
  ]

  const discoveredFiles = []
  const pointers = []
  const sectionDigests = {}

  for (const relPath of domainFiles) {
    const absPath = join(root, relPath)
    if (!existsSync(absPath)) continue
    discoveredFiles.push(relPath)
    if (relPath.endsWith('.md')) {
      const content = readFileSync(absPath, 'utf8')
      const extracted = extractMarkdownH2Pointers(relPath, content)
      pointers.push(...extracted.pointers)
      Object.assign(sectionDigests, extracted.digests)
    } else if (relPath.endsWith('.yaml')) {
      const parsed = parseWorldManifestYaml(readFileSync(absPath, 'utf8'))
      for (const atom of parsed.atoms) {
        const addr = atom.address || atom.source
        if (addr) pointers.push(addr)
      }
    }
  }

  const sdlcConfig = readJsonSafe(join(root, 'sdlc.config.json')) || {}
  const workflowConfig = readJsonSafe(join(root, 'agent-workflow.config.json')) || {}

  const posture =
    sdlcConfig.posture || workflowConfig.posture || sdlcConfig.review?.posture || 'standard'

  const pathAllowsSelfReview =
    typeof sdlcConfig.paths?.[posture]?.allowsSelfReview === 'boolean'
      ? sdlcConfig.paths[posture].allowsSelfReview
      : typeof sdlcConfig.paths?.standard?.allowsSelfReview === 'boolean'
        ? sdlcConfig.paths.standard.allowsSelfReview
        : undefined

  const rawAllowsSelfReview =
    typeof sdlcConfig.allowsSelfReview === 'boolean'
      ? sdlcConfig.allowsSelfReview
      : typeof workflowConfig.allowsSelfReview === 'boolean'
        ? workflowConfig.allowsSelfReview
        : typeof workflowConfig.review?.allowsSelfReview === 'boolean'
          ? workflowConfig.review.allowsSelfReview
          : typeof pathAllowsSelfReview === 'boolean'
            ? pathAllowsSelfReview
            : posture !== 'high-assurance'

  let effectiveAllowsSelfReview = rawAllowsSelfReview
  if (posture === 'high-assurance' && rawAllowsSelfReview === true) {
    warnings.push(
      'L2 precedence violation blocked: high-assurance posture cannot enable allowsSelfReview (narrowed to false per L1 AGENTS.md#review-and-safety).',
    )
    effectiveAllowsSelfReview = false
  }

  const seatBoundaries = resolveSeatPathBoundaries(seat)
  const l2SeatOverride =
    sdlcConfig.seatOverrides?.[seat] ||
    workflowConfig.seatOverrides?.[seat] ||
    sdlcConfig.pathBoundaries?.[seat] ||
    workflowConfig.pathBoundaries?.[seat] ||
    null

  if (l2SeatOverride) {
    if (
      seat.startsWith('dev.build') &&
      (l2SeatOverride.requiresPhase3OraclePin === false ||
        (Array.isArray(l2SeatOverride.allow) &&
          l2SeatOverride.allow.some((p) => p.includes('oracles'))))
    ) {
      warnings.push(
        `L2 precedence violation blocked: project config cannot widen L1 oracle custody boundary for ${seat}.`,
      )
    }
    if (
      seatBoundaries.readOnly &&
      Array.isArray(l2SeatOverride.allow) &&
      l2SeatOverride.allow.length > 0
    ) {
      warnings.push(
        `L2 precedence violation blocked: project config cannot grant write paths to read-only seat ${seat}.`,
      )
    }
    if (!seat.startsWith('steer.') && l2SeatOverride.canDeclareGoalComplete === true) {
      warnings.push(
        `L2 precedence violation blocked: project config cannot grant goal_complete authority to ${seat}.`,
      )
    }
  }

  const ciCommands =
    sdlcConfig.ciCommands ||
    workflowConfig.ciCommands ||
    (workflowConfig.testCommand ? [workflowConfig.testCommand] : [])

  if (situation === 'post-compaction') {
    return {
      layer: {
        mode: 'pointers-only',
        files: discoveredFiles,
        pointers: [...new Set(pointers)],
        effectivePolicy: {
          posture,
          allowsSelfReview: effectiveAllowsSelfReview,
          ciCommands,
        },
      },
      warnings,
    }
  }

  return {
    layer: {
      mode: 'resolved-domain',
      files: discoveredFiles,
      pointers: [...new Set(pointers)],
      sectionDigests,
      effectivePolicy: {
        posture,
        allowsSelfReview: effectiveAllowsSelfReview,
        ciCommands,
      },
      precedenceInvariant: 'L2 narrows L1; safety boundary widening is rejected.',
    },
    warnings,
  }
}

function detectGitBranch(targetDir) {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: resolve(targetDir),
    encoding: 'utf8',
  })
  if (result.status !== 0 || !result.stdout) return null
  return result.stdout.trim() || null
}

function sanitizeInlineSummary(text, maxLength = 200) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
    .slice(0, maxLength)
}

function readOpenInboxEnvelopes(targetDir, seat) {
  const inboxDir = join(resolve(targetDir), '.agentflow', 'inbox', seat)
  if (!existsSync(inboxDir)) return []
  const files = readdirSync(inboxDir)
    .filter((f) => f.endsWith('.json'))
    .sort()

  const rawRecords = []
  const closedIds = new Set()
  const closedSlices = new Set()

  for (const file of files) {
    const parsed = readJsonSafe(join(inboxDir, file))
    if (!parsed) continue
    const envId = parsed.id || file.slice(0, -'.json'.length)
    if (parsed.queueAction === 'close') {
      closedIds.add(envId)
      const targetCloseId = parsed.closesEnvelopeId || parsed.result?.closesEnvelopeId || null
      if (targetCloseId) closedIds.add(targetCloseId)
      if (parsed.sliceId) closedSlices.add(parsed.sliceId)
      continue
    }
    rawRecords.push({ file, envId, parsed })
  }

  const envelopes = []
  for (const { envId, parsed } of rawRecords) {
    if (closedIds.has(envId)) continue
    if (parsed.sliceId && closedSlices.has(parsed.sliceId)) continue
    envelopes.push({
      id: envId,
      from: parsed.from ?? parsed.fromRole ?? null,
      to: parsed.to ?? parsed.toRole ?? seat,
      outcome: parsed.outcome ?? parsed.decision ?? null,
      decision: parsed.decision ?? null,
      queueAction: parsed.queueAction ?? 'handoff',
      domainStatus: parsed.domainStatus ?? 'in_progress',
      summary: sanitizeInlineSummary(parsed.summary ?? parsed.subject ?? ''),
      sliceId: parsed.sliceId ?? null,
      issueRef: parsed.issueRef ?? null,
      timestamp: parsed.timestamp ?? null,
    })
  }
  return envelopes
}

function composeL3Layer(targetDir, { seat, sliceId, issueRef, worktree, now }) {
  const root = resolve(targetDir)
  const branch = detectGitBranch(root)
  const lease = readSeatLease(root, seat, { now })
  const inbox = readOpenInboxEnvelopes(root, seat)
  const goalRaw = readJsonSafe(join(root, 'goal.json'))
  const gatesRaw = readJsonSafe(join(root, 'gates.json'))

  return {
    branch,
    lease: lease
      ? {
          occupantSession: lease.occupantSession,
          platform: lease.platform,
          claimedAt: lease.claimedAt,
          expiresAt: lease.expiresAt,
          worktree: lease.worktree,
        }
      : null,
    inbox,
    goal: goalRaw
      ? {
          title: sanitizeInlineSummary(goalRaw.title ?? '', 160) || null,
          kind: goalRaw.kind ?? null,
          changeClass: goalRaw.changeClass ?? null,
        }
      : null,
    gates: gatesRaw
      ? {
          entryCount: Array.isArray(gatesRaw.entries) ? gatesRaw.entries.length : 0,
        }
      : null,
    sliceId: sliceId ?? null,
    issueRef: issueRef ?? null,
    worktree: worktree ?? lease?.worktree ?? root,
  }
}

function renderPrimeMarkdown({ seat, situation, l1, l2, l3, warnings }) {
  const lines = [
    `# AgentFlow Seat Prime — \`${seat}\` (${situation})`,
    '',
    `## L1: Framework Law (${l1.packName} — ${l1.mode})`,
  ]

  if (l1.mode === 'pointers-only') {
    lines.push('Addressable L1 pointers (post-compaction minimal restore):')
    for (const ptr of l1.pointers) {
      lines.push(`- \`${ptr}\``)
    }
  } else {
    const boundaries = l1.seatContract.pathBoundaries
    lines.push(
      `- **Allowed Paths:** ${boundaries.allow.length ? boundaries.allow.map((p) => `\`${p}\``).join(', ') : 'none (read-only)'}`,
    )
    lines.push(`- **Denied Paths:** ${boundaries.deny.map((p) => `\`${p}\``).join(', ')}`)
    lines.push(
      `- **6-Way Outcomes:** ${l1.seatContract.outcomes.map((o) => `\`${o}\``).join(', ')}`,
    )
    lines.push(`- **Hot-Potato Rule:** ${l1.seatContract.hotPotatoRule}`)
    if (l1.seatContract.reviewerIsolation) {
      lines.push(
        `- **Reviewer Isolation:** Blind to builder reasoning; verify against ${l1.seatContract.reviewerIsolation.verifyAgainst.join(', ')}.`,
      )
    }
    if (l1.atoms.length > 0) {
      lines.push('', '### World Atoms')
      for (const atom of l1.atoms) {
        lines.push(`- **[${atom.region}]** \`${atom.address}\` — ${atom.summary}`)
      }
    }
  }

  lines.push('', `## L2: Project Domain (${l2.mode})`)
  lines.push(
    `- **Posture:** \`${l2.effectivePolicy.posture}\` | **Self-Review Allowed:** \`${l2.effectivePolicy.allowsSelfReview}\``,
  )
  if (l2.effectivePolicy.ciCommands?.length) {
    lines.push(
      `- **CI Commands:** ${l2.effectivePolicy.ciCommands.map((c) => `\`${c}\``).join(', ')}`,
    )
  }
  if (l2.pointers.length > 0) {
    lines.push('- **Addressable Pointers:**')
    for (const ptr of l2.pointers.slice(0, 12)) {
      const digest = l2.sectionDigests?.[ptr]
      lines.push(`  - \`${ptr}\`${digest ? ` (sha256:${digest})` : ''}`)
    }
  }

  lines.push('', '## L3: Reconciled Live Facts')
  lines.push(`- **Worktree:** \`${l3.worktree}\``)
  lines.push(`- **Git Branch:** \`${l3.branch ?? 'detached/none'}\``)
  lines.push(
    `- **Active Lease:** ${l3.lease ? `\`${l3.lease.occupantSession}\` (${l3.lease.platform}, expires ${l3.lease.expiresAt})` : 'none'}`,
  )
  if (l3.sliceId) lines.push(`- **Active Slice:** \`${l3.sliceId}\``)
  if (l3.issueRef) lines.push(`- **Issue Ref:** \`${l3.issueRef}\``)
  if (l3.goal) lines.push(`- **Goal:** ${l3.goal.title} (\`${l3.goal.kind ?? 'goal'}\`)`)
  lines.push(`- **Open Inbox Envelopes:** ${l3.inbox.length}`)
  for (const env of l3.inbox) {
    lines.push(`  - \`${env.id}\` from \`${env.from}\` [${env.outcome}]: ${env.summary}`)
  }

  if (warnings.length > 0) {
    lines.push('', '## Precedence Warnings')
    for (const warning of warnings) {
      lines.push(`- ⚠ ${warning}`)
    }
  }

  return `${lines.join('\n')}\n`
}

export function primeSeat(
  targetDir,
  { seat, situation = 'fresh', sliceId = null, issueRef = null, worktree = null, now } = {},
) {
  if (!targetDir) throw new Error('targetDir is required for primeSeat')
  const normalizedSeat = normalizeSeatId(seat)
  if (!VALID_SITUATIONS.includes(situation)) {
    throw new Error(
      `Unsupported situation "${situation}". Expected one of: ${VALID_SITUATIONS.join(', ')}`,
    )
  }

  const l1 = composeL1Layer(targetDir, { seat: normalizedSeat, situation })
  const { layer: l2, warnings } = composeL2Layer(targetDir, {
    seat: normalizedSeat,
    situation,
    l1,
  })
  const l3 = composeL3Layer(targetDir, {
    seat: normalizedSeat,
    sliceId,
    issueRef,
    worktree,
    now,
  })

  const markdown = renderPrimeMarkdown({
    seat: normalizedSeat,
    situation,
    l1,
    l2,
    l3,
    warnings,
  })

  return {
    seat: normalizedSeat,
    situation,
    layers: { l1, l2, l3 },
    markdown,
    warnings,
  }
}
