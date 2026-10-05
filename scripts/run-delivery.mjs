#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createFileRunStore } from '../lib/sources/run-store.mjs'
import { createGitHubRunStore, planGitHubCoordination } from '../lib/sources/github-run-store.mjs'
import { createGitHubApiCli } from '../lib/sources/github-api-cli.mjs'
import { createRunService, GovernedBlockError } from '../lib/application/run-service.mjs'
import { loadSdlcConfig } from '../lib/sdlc-state.mjs'
import { resolvePosture } from '../lib/core/posture.mjs'
import { GATE_CLASSES } from '../lib/core/gate.mjs'
import { actionBoundaryAllows, actionBoundaryRank } from '../lib/sdlc-vocabulary.mjs'
import { createHostIntentConsent, createIntentConsentRequest } from '../lib/core/intent-consent.mjs'
import {
  planProjection,
  publishProjection,
  reconcileProjection,
} from '../lib/application/publication-service.mjs'
import { collectProcessObservation } from '../lib/verification/process-collector.mjs'
import { fingerprintCandidate, containedPath } from '../lib/verification/workspace.mjs'
import { resolveObservation as resolveVerifiedObservation } from '../lib/verification/observation-resolver.mjs'
import { recordDigest } from '../lib/core/record-digest.mjs'
import { goalRevision } from '../lib/core/goal-revision.mjs'
import { validateDeliveryContract } from '../lib/core/delivery-policy.mjs'
import { RUN_ROLES, projectRunContext } from '../lib/core/run-state.mjs'
import { observeLocalWriter } from '../lib/providers/writer-status.mjs'
import { emitObservation } from '../lib/observability/observer.mjs'
import { createJournaledRunStore } from '../lib/sources/journaled-run-store.mjs'
import { createLocalCooperativeIssuer } from '../lib/application/local-cooperative-issuer.mjs'
import { createGitHubDeliveryActions } from '../lib/providers/github-delivery-actions.mjs'
import { grantRequestDigest, normalizeOperation } from '../lib/core/delegation-grant.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createContinuationBundle,
  reconstructContinuation,
} from '../lib/application/continuation-service.mjs'
import {
  createSegmentedRunStore,
  previewMigration,
  migrateRunStore,
} from '../lib/sources/segmented-run-store.mjs'
import { buildRunContext } from '../lib/application/context-service.mjs'
import {
  assertEngineeringEvidenceDisclosure,
  assertPublishableEngineeringEvidence,
} from '../lib/providers/engineering-evidence.mjs'
import { resolveConfiguredEngineeringProvider } from '../lib/providers/registry.mjs'
import {
  createGovernedEngineeringAdapter,
  createSourceEngineeringReceiptResolver,
} from '../lib/providers/governed-engineering.mjs'

export const RUN_EXIT_CODES = {
  success: 0,
  invalid: 2,
  blocked: 3,
  conflict: 4,
  unavailable: 5,
  unknown: 6,
}
const help =
  'Usage: agentflow-sdlc run <source-plan|start|status|context|next|freeze|verify|intent-plan|advance|checkpoint|pause|handoff|resume|grant-plan|grant-issue|grant-status|grant-revoke|act|reconcile|journal-reconcile|migrate|resolve-escalation|publish> <id> [--target <dir>] [--execute] [--plan <file> --confirm <digest>] [--json]'

// W8e / D3 — replaces message-regex classification. A GovernedBlockError carries its exit code as a
// fact about the error (RUN_EXIT_CODES.blocked, documented and distinct from a genuine error), so
// rewording its message can never change the code. Everything else still falls back to the existing
// message heuristic, which this change leaves in place rather than migrating every throw site in
// the codebase — see the session report.
export function classifyDeliveryError(error) {
  if (error?.governed) return RUN_EXIT_CODES.blocked
  const message = error?.message ?? ''
  if (/stale|changed|conflict|Obsolete/.test(message)) return RUN_EXIT_CODES.conflict
  if (/unavailable|ENOENT/.test(message)) return RUN_EXIT_CODES.unavailable
  if (/required|blocked|authorized/.test(message)) return RUN_EXIT_CODES.blocked
  return RUN_EXIT_CODES.invalid
}

// W8e / D6 — one readable line per run command, printed before the (unchanged) JSON block when
// `--json` was not requested. `command === 'next'` is the one shape whose run-state projection is
// nested under `.status` rather than at the top level (see the `next` branch of runDelivery below).
function summarizeRunResult(command, result) {
  if (!result || typeof result !== 'object') return 'Done.'
  const projection = command === 'next' ? result.status : result
  const nextAction = projection?.nextAction
    ? ` Next: ${String(projection.nextAction).replaceAll('-', ' ')}.`
    : ''
  if (command === 'verify' && result.verification) {
    return result.verification.outcome === 'pass'
      ? `Evidence recorded: your check passed.${nextAction}`
      : `Evidence recorded: your check did not pass.${nextAction}`
  }
  if (typeof projection?.status === 'string' && projection.status !== 'absent') {
    return `Run "${projection.runId ?? ''}" is ${projection.status}.${nextAction}`
  }
  if (result.blocked) return `Blocked: acceptance criteria are not yet satisfied.${nextAction}`
  if (typeof result.digest === 'string') return 'Plan ready; rerun with --confirm to apply it.'
  return `Done.${nextAction}`
}

export async function resolveDeliveryContract({ value, state, source, client }) {
  const validation = validateDeliveryContract(value)
  if (!validation.ok) return { verified: false }
  if (source.kind === 'local-preview')
    return { verified: true, value, sourceRevision: recordDigest(value) }
  if (!/^[\w.-]+\/[\w.-]+$/.test(source.repo)) throw new Error('Exact goal repository required')
  const reference = /^issue:([1-9]\d*)$/.exec(state.goalRef)
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(state.goalRef)
  const number = reference?.[1] ?? (url?.[1] === source.repo ? url[2] : null)
  if (!number) throw new Error('Goal must identify an issue in the configured repository')
  const issue = await client.request(`/repos/${source.repo}/issues/${number}`)
  if (
    issue.pull_request ||
    issue.number !== Number(number) ||
    !issue.updated_at ||
    typeof issue.body !== 'string'
  )
    throw new Error('Authoritative goal issue unavailable')
  // W8c D2 — calls the ONE shared revision recipe (lib/core/goal-revision.mjs); this used to type
  // the same {repo, number, title, body, updatedAt} recipe out inline, a second definition that
  // could silently drift from lib/cockpit-goal-model.mjs's own copy.
  const revision = goalRevision({
    repo: source.repo,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    updatedAt: issue.updated_at,
  })
  return {
    verified: value.goalRevision === revision,
    value,
    goalRevision: revision,
    sourceRevision: recordDigest({ goalRevision: revision, contractDigest: recordDigest(value) }),
  }
}

export async function runDelivery(
  args,
  {
    emit = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    resolveHostIntentConsent,
    onTiming,
  } = {},
) {
  const flag = (name, fallback) => {
    const i = args.indexOf(name)
    return i < 0 ? fallback : args[i + 1]
  }
  const [command, id] = args
  if (!command || args.includes('--help')) {
    emit({ version: 1, usage: help })
    return 0
  }
  const root = resolve(flag('--target', process.cwd()))
  const invocationStarted = performance.now()
  let observer = null
  let activeAttempt = null
  const sessionId = randomUUID()
  const sessionStarted = performance.now()
  const readJson = (path) => {
    const bytes = readFileSync(containedPath(root, path))
    emitObservation(observer, {
      kind: 'file_read',
      bytes: bytes.length,
      files: 1,
      purpose: 'configuration',
    })
    return JSON.parse(bytes.toString('utf8'))
  }
  const readExecutionAdapter = () => {
    try {
      return readJson('agent-workflow.config.json')
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error(
          'Execution adapter unavailable: agent-workflow.config.json not found at the project root. Run `agentflow-sdlc adopt apply` to create it.',
        )
      throw new Error(`Execution adapter agent-workflow.config.json is invalid: ${error.message}`)
    }
  }
  const executionAdapter = readExecutionAdapter()
  const config = executionAdapter.delivery
  if (!config?.source || !config.candidate)
    throw new Error('Configure delivery.source and delivery.candidate first')
  const external = config.source.kind === 'github'
  if (!external && config.source.kind !== 'local-preview') throw new Error('Unsupported run source')
  const execute = args.includes('--execute')
  const sdlcConfig = loadSdlcConfig(root)
  const profile = flag('--profile', 'standard')
  const maximum = resolvePosture({
    posture: executionAdapter.posture,
    changeClass: profile,
    config: sdlcConfig,
  }).maxBoundary
  const boundary = flag('--boundary', external ? maximum : 'mutate-worktree')
  // Source-branch writes are coordination transport; they do not widen the run's business ceiling.
  const coordinationBoundary = execute && external ? 'external-action' : 'observe'
  const intentDestinations = (state) => {
    if (!external) return ['local-preview']
    const postureMaximum = resolvePosture({
      posture: executionAdapter.posture,
      changeClass: state.profile,
      config: sdlcConfig,
    }).maxBoundary
    const permits = (required) =>
      actionBoundaryAllows(state.boundary, required, sdlcConfig) &&
      actionBoundaryAllows(postureMaximum, required, sdlcConfig)
    if (!permits('open-pr')) return ['source-coordination-only']
    return permits('external-action') &&
      !resolvePosture({
        posture: executionAdapter.posture,
        changeClass: state.profile,
        config: sdlcConfig,
      }).humanGateClasses.includes(GATE_CLASSES.releaseOfCandidate) &&
      config.delegation?.policy?.issuers?.some((issuer) => issuer.allowThroughMerge)
      ? ['ready-pr', 'named-merge']
      : ['ready-pr']
  }
  const intentScope = (state) => ({
    repository: external ? config.source.repo : null,
    coordinationBranch: external ? (config.source.branch ?? 'agentflow-state') : null,
    businessBoundary: state.boundary,
    destinations: intentDestinations(state),
    checks: Object.entries(config.checks ?? {})
      .map(([name, definition]) => ({ name, digest: recordDigest(definition) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    expiry: { effectGrant: 'separate-typed-grant-required' },
    budget: config.budget ?? null,
    assurance: 'agent-observed-local-cooperative',
  })
  // W8e / D4 — `--writer` used to be required plumbing typed on three of the six entry-path
  // commands. It now defaults to the local operator identity (the OS user name); `--writer` stays
  // available to override it (a shared machine, CI, or a name that differs from the OS account).
  const authority = {
    owner: flag('--writer', userInfo().username),
    generation: Number(flag('--generation', '0')),
    execute,
    boundary,
  }
  let telemetry = { observer: () => {}, shutdown: async () => {} }
  try {
    const { createTelemetry } = await import('../lib/observability/otel.mjs')
    telemetry = createTelemetry(executionAdapter.observability)
    observer = (event) => telemetry.observer({ ...event, runId: id, sessionId })
  } catch (err) {
    // ignore init failure
  }

  try {
    emitObservation(observer, { kind: 'session', state: 'started' })
    const client = external ? createGitHubApiCli({ observer }) : null
    if (
      config.source.format !== undefined &&
      !['v1', 'segmented-v2'].includes(config.source.format)
    )
      throw new Error('Unsupported source format')
    const sourceStore = external
      ? (config.source.format === 'segmented-v2' ? createSegmentedRunStore : createGitHubRunStore)({
          ...config.source,
          runId: id,
          client,
          boundary: coordinationBoundary,
          setupConfirm: flag('--setup-confirm'),
        })
      : createFileRunStore({ root, runId: id })
    const store = config.delegation
      ? createJournaledRunStore({
          store: sourceStore,
          directory: containedPath(root, `.agent-runs/runs/${id}/audit`, { allowMissing: true }),
          observeWriter: (state) => observeLocalWriter(state.writer),
        })
      : sourceStore
    const actions = client ? createGitHubDeliveryActions({ client }) : null
    const engineeringBinding = resolveConfiguredEngineeringProvider(executionAdapter, { cwd: root })
    const engineering = engineeringBinding
      ? createGovernedEngineeringAdapter({
          ...engineeringBinding,
          resolveReceipt: createSourceEngineeringReceiptResolver({ store }),
        })
      : null
    const issuer = config.delegation
      ? createLocalCooperativeIssuer({
          policy: config.delegation.policy,
          issuerId: config.delegation.issuerId,
          approve: async (context) => {
            if (
              !execute ||
              !authority.owner ||
              (external && coordinationBoundary !== 'external-action')
            )
              return false
            if (context.kind === 'issue-grant') {
              const approvedPlan = readJson(flag('--plan'))
              if (
                approvedPlan.kind !== 'delegation-plan' ||
                approvedPlan.version !== 1 ||
                approvedPlan.runId !== id ||
                approvedPlan.request?.repository !== config.source.repo ||
                approvedPlan.assurance !== 'local-cooperative' ||
                approvedPlan.destination !==
                  (context.request.allowedActions?.includes('merge')
                    ? 'named-merge'
                    : 'ready-pr') ||
                flag('--confirm') !== recordDigest(approvedPlan) ||
                approvedPlan.runRevision !== context.state.revision ||
                approvedPlan.requestDigest !== grantRequestDigest(context.request) ||
                approvedPlan.candidateDigest !== fingerprintCandidate(root, config.candidate).digest
              )
                throw new Error('Delegation approval is stale or mismatched')
              return { approved: true, decisionRef: `local-cooperative:${flag('--confirm')}` }
            }
            return {
              approved: true,
              decisionRef: context.grant.envelope.binding.issuerBinding.decisionRef,
            }
          },
        })
      : null
    const phaseContract = (state) => config.contracts?.[RUN_ROLES[state.phase]]
    const domainPath = ['sdlc.config.json', 'defaults/sdlc.config.json'].find((path) =>
      existsSync(containedPath(root, path, { allowMissing: true })),
    )
    let expectedResumeWorkspace = null
    const service = createRunService({
      store,
      // The run must be governed by the TARGET project's own configuration and posture. Without these,
      // run-service loaded config from process.cwd() - the framework checkout on the documented entry
      // path - and always used the default posture, silently ignoring what the adopter chose.
      sdlcConfig,
      posture: executionAdapter.posture,
      policy: domainPath ? readJson(domainPath).deliveryPolicy : {},
      budget: config.budget ?? null,
      delegationPolicy: config.delegation?.policy ?? null,
      intentScope,
      platformConfig: executionAdapter,
      resolveHostIntentConsent: async (request) => {
        if (typeof resolveHostIntentConsent === 'function') return resolveHostIntentConsent(request)
        const receiptPath = flag('--consent')
        if (!receiptPath) return null
        const receipt = readJson(receiptPath)
        if (flag('--consent-confirm') !== recordDigest(receipt))
          throw new GovernedBlockError('Current intent consent digest confirmation required')
        const canonical = createHostIntentConsent({ request, ...receipt })
        if (canonical.digest !== receipt.digest)
          throw new GovernedBlockError('Exact typed intent consent required')
        return canonical
      },
      authorize: async (context) =>
        ['issue-grant', 'resolve-grant', 'revoke-grant'].includes(context.kind)
          ? issuer
            ? issuer(context)
            : false
          : execute &&
            Boolean(authority.owner) &&
            context.kind !== 'human-acceptance' &&
            (!external || coordinationBoundary === 'external-action'),
      resolveContract: async (state) => {
        const path = phaseContract(state)
        if (!path) return null
        return resolveDeliveryContract({
          value: readJson(path),
          state,
          source: config.source,
          client,
        })
      },
      resolveCollaboration: async (state) => {
        const path = config.collaboration?.[RUN_ROLES[state.phase]]
        return path ? { verified: true, sources: readJson(path) } : null
      },
      // W8f D1 — the run and the role-pass gate (scripts/validate-sdlc-role-pass.mjs) both resolve
      // observation trust through the ONE shared function; no second copy of this decision lives here.
      resolveObservation: async (observation) =>
        resolveVerifiedObservation({ root, config, observation }),
      observeWriter: async (state) => observeLocalWriter(state.writer),
      observeWorkspace: async () => {
        const workspace = {
          verified: true,
          candidateDigest: fingerprintCandidate(root, config.candidate, { observer }).digest,
        }
        if (external) {
          const git = (...params) =>
            execFileSync('git', params, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
          workspace.branch = git('symbolic-ref', '--short', 'HEAD')
          workspace.commitSha = git('rev-parse', 'HEAD')
          if (
            expectedResumeWorkspace &&
            (workspace.branch !== expectedResumeWorkspace.branch ||
              workspace.commitSha !== expectedResumeWorkspace.commitSha)
          )
            workspace.verified = false
        }
        return workspace
      },
      reconcileOperation: async (operation, admission) =>
        operation.kind === 'issue-projection' && client
          ? reconcileProjection({ client, plan: operation.plan })
          : admission?.operation.action === 'edit' && engineering
            ? engineering.reconcile(operation, admission)
            : admission && actions
              ? actions.reconcile(operation, admission)
              : { state: 'unknown' },
      observer,
    })
    let result
    if (command === 'migrate') {
      if (!client) throw new Error('Migration requires GitHub source')
      const options = { ...config.source, runId: id, client }
      const preview = await previewMigration(options)
      if (!execute) result = { plan: preview, confirm: preview.digest }
      else {
        if (coordinationBoundary !== 'external-action' || flag('--confirm') !== preview.digest)
          throw new Error('Current migration preview confirmation required')
        result = await migrateRunStore({
          ...options,
          boundary: coordinationBoundary,
          expectedSourceRevision: preview.sourceRevision,
        })
      }
    } else if (command === 'grant-plan') {
      if (!issuer || !external)
        throw new Error('Configured cooperative issuer and durable source required')
      const { state } = await service.read()
      if (!state) throw new Error('Run not found')
      const request = readJson(flag('--request'))
      if (request.repository !== config.source.repo) throw new Error('Grant repository mismatch')
      const plan = {
        kind: 'delegation-plan',
        version: 1,
        runId: id,
        runRevision: state.revision,
        candidateDigest: fingerprintCandidate(root, config.candidate).digest,
        request,
        requestDigest: grantRequestDigest(request),
        assurance: 'local-cooperative',
        destination: request.allowedActions?.includes('merge') ? 'named-merge' : 'ready-pr',
      }
      result = { plan, confirm: recordDigest(plan) }
    } else if (command === 'grant-issue') {
      const plan = readJson(flag('--plan'))
      result = await service.issueGrant(plan.request, {
        expectedRevision: plan.runRevision,
        authority,
      })
    } else if (command === 'grant-status') {
      result = await service.resolveGrant(flag('--grant'))
    } else if (command === 'grant-revoke') {
      result = await service.revokeGrant(
        flag('--grant'),
        flag('--reason', 'Operator revoked delegation'),
        { expectedRevision: (await service.read()).revision, authority },
      )
    } else if (command === 'journal-reconcile') {
      if (!execute || !store.reconcileJournal)
        throw new Error('Configured journal and execution authority required')
      if (args.includes('--recover-lock-owner') && !args.includes('--recover-stages'))
        throw new Error('--recover-lock-owner requires --recover-stages')
      if (args.includes('--recover-lock-owner'))
        await store.journal.recoverLock(readJson(flag('--recover-lock-owner')))
      result = await store.reconcileJournal({
        replay: args.includes('--replay'),
        recoverStages: args.includes('--recover-stages'),
        authority,
      })
    } else if (command === 'act' || command === 'reconcile') {
      if (!actions || !issuer) throw new Error('Configured delegated GitHub actions required')
      if (command === 'reconcile') {
        if (!execute) throw new Error('Execution authority required')
        if (args.includes('--observe-provider')) {
          const snapshot = await service.read()
          const operationId = flag('--operation')
          const admitted = snapshot.state?.admissions?.[operationId]
          const operation = admitted?.operation
          if (!engineering || operation?.action !== 'edit')
            throw new Error('Admitted engineering operation required')
          if (
            snapshot.state.owner !== authority.owner ||
            snapshot.state.generation !== authority.generation
          )
            throw new Error('Current writer identity required')
          assertEngineeringEvidenceDisclosure(executionAdapter, operation)
          if (
            operation.candidateDigest !== fingerprintCandidate(root, config.candidate).digest ||
            operation.arguments.headSha !==
              execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: root,
                encoding: 'utf8',
                windowsHide: true,
              }).trim()
          )
            throw new Error('Operation candidate changed')
          const recorded = snapshot.events.some(
            (event) =>
              event.kind === 'checkpoint' &&
              event.payload?.kind === 'engineering-result' &&
              event.payload.operationId === operationId,
          )
          if (!recorded) {
            // Observation never invokes provider execution or grants new work.
            const observed = await engineering.observe(operation)
            if (observed.status === 'pass' && observed.verifiedOutput) {
              const payload = {
                kind: 'engineering-result',
                operationId,
                receipt: observed.receipt,
                output: observed.verifiedOutput,
              }
              assertPublishableEngineeringEvidence(payload, operation)
              if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024)
                throw new Error('Engineering evidence exceeds bounded checkpoint')
              await service.record('checkpoint', payload, {
                expectedRevision: snapshot.revision,
                authority,
              })
            }
          }
        }
        result = await service.reconcileDelegatedOperation({
          operationId: flag('--operation'),
          authority,
        })
      } else {
        const operation = normalizeOperation(readJson(flag('--operation')))
        if (operation.action === 'edit')
          assertEngineeringEvidenceDisclosure(executionAdapter, operation)
        const { state } = await service.read()
        if (
          !state ||
          operation.repository !== config.source.repo ||
          operation.candidateDigest !== fingerprintCandidate(root, config.candidate).digest
        )
          throw new Error('Operation candidate or repository changed')
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
        }).trim()
        if (
          operation.arguments.headSha !== head ||
          execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
            cwd: root,
            encoding: 'utf8',
            windowsHide: true,
          }).trim()
        )
          throw new Error('Clean exact Git candidate required')
        for (const path of config.candidate.inputs) {
          const git = (...params) =>
            execFileSync('git', params, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
          if (git('rev-parse', `HEAD:${path}`) !== git('hash-object', `--path=${path}`, '--', path))
            throw new Error('Candidate input is not preserved in the approved Git commit')
        }
        const reviewId = config.delegation.reviewCheck
        if (!reviewId || operation.review.policy !== 'automated')
          throw new Error(
            'Configured automated review check required; human review cannot be self-declared',
          )
        for (const checkId of [...config.delegation.policy.requiredChecks, reviewId]) {
          const observation = state.observations.findLast(
            (o) =>
              o.criterionId === checkId &&
              o.candidateDigest === operation.candidateDigest &&
              o.outcome === 'pass',
          )
          if (
            !observation ||
            (await resolveVerifiedObservation({ root, config, observation }))?.verified !== true
          )
            throw new Error('Fresh exact-candidate checks and review required')
        }
        const adapter = operation.action === 'edit' ? engineering : actions
        if (!adapter) throw new Error('Configured qualified engineering provider required')
        if (adapter.preflight) await adapter.preflight(operation)
        activeAttempt = {
          attemptId: randomUUID(),
          operationId: operation.id,
          started: performance.now(),
        }
        emitObservation(observer, {
          kind: 'execution_attempt',
          attemptId: activeAttempt.attemptId,
          state: 'started',
          operationId: operation.id,
        })
        const attemptStarted = performance.now()
        result = await service.executeDelegatedOperation(
          operation,
          { expectedRevision: state.revision, authority, grantId: flag('--grant') },
          adapter.dispatch,
        )
        if (
          operation.action === 'edit' &&
          !result.replayed &&
          result.dispatchResult?.verifiedOutput
        ) {
          const payload = {
            kind: 'engineering-result',
            operationId: operation.id,
            receipt: result.dispatchResult.receipt,
            output: result.dispatchResult.verifiedOutput,
          }
          assertPublishableEngineeringEvidence(payload, operation)
          if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024)
            throw new Error(
              'Engineering evidence exceeds bounded checkpoint; operation remains unknown',
            )
          await service.record('checkpoint', payload, {
            expectedRevision: (await service.read()).revision,
            authority,
          })
        }
        if (result.replayed)
          result = {
            state: 'unknown',
            operationId: operation.id,
            requiresOperationReconciliation: true,
            admissionEventDigest: result.receipt?.eventDigest ?? null,
          }
        else
          result = await service.reconcileDelegatedOperation({
            operationId: operation.id,
            authority,
          })
        emitObservation(observer, {
          kind: 'execution_attempt',
          operationId: operation.id,
          attemptId: activeAttempt.attemptId,
          state: result.state === 'confirmed' ? 'completed' : 'unknown',
          duration: performance.now() - attemptStarted,
        })
        activeAttempt = null
      }
    } else if (command === 'source-plan') {
      if (!client) throw new Error('Source setup planning requires a GitHub binding')
      result = await planGitHubCoordination({ ...config.source, client })
    } else if (command === 'start') {
      if (actionBoundaryRank(boundary, sdlcConfig) > actionBoundaryRank(maximum, sdlcConfig))
        throw new GovernedBlockError('Business boundary exceeds configured posture or profile')
      result = await service.start({
        runId: id,
        goalRef: flag('--goal'),
        owner: authority.owner,
        profile,
        boundary,
        writer: {
          host: hostname(),
          pid: Number(flag('--writer-pid', String(process.ppid))),
          instance: randomUUID(),
        },
        authority,
      })
    } else if (command === 'status') result = await service.status()
    else if (command === 'context') {
      const state = (await service.read()).state
      if (args.includes('--compact')) {
        const projection = projectRunContext(state)
        const references = [...projection.authorityReferences, projection.roleReference]
        const policyIndex = {
          version: 1,
          references: references.map((path) => {
            const content = readFileSync(containedPath(root, path))
            emitObservation(observer, {
              kind: 'file_read',
              bytes: content.length,
              files: 1,
              purpose: 'policy',
            })
            return {
              path,
              digest: createHash('sha256').update(content).digest('hex'),
              byteLength: content.length,
            }
          }),
        }
        result = buildRunContext({
          state,
          policyIndex,
          knownCommonDigest: flag('--known-common', null),
        })
        emitObservation(observer, {
          kind: 'context_admitted',
          bytes: result.bytes,
          policyBytes: result.policyBytes,
        })
      } else {
        result = projectRunContext(state)
        const bytes = Buffer.byteLength(JSON.stringify(result))
        if (bytes > 32 * 1024)
          throw new Error('Context exceeds 32 KiB; external artifact references required')
        emitObservation(observer, { kind: 'context_admitted', bytes, policyBytes: 0 })
      }
    } else if (command === 'next') {
      const { state } = await service.read()
      result = { status: await service.status() }
      if (state?.contract && state.candidateDigest) {
        const plan = {
          candidateDigest: state.candidateDigest,
          runRevision: state.revision,
          criteria: state.contract.criteria.map((criterion) => ({
            ...criterion,
            observationDigest:
              state.observations.findLast(
                (o) =>
                  o.criterionId === criterion.id &&
                  o.definitionDigest === criterion.definitionDigest,
              )?.digest ?? null,
          })),
        }
        result.advancePlan = plan
        result.confirm = recordDigest(plan)
      }
    } else if (command === 'freeze')
      result = await service.freezeContract({
        expectedRevision: (await service.read()).revision,
        authority,
      })
    else if (command === 'verify') {
      const check = config.checks?.[flag('--check')]
      if (!check) throw new Error('Configured --check required')
      let { state, events } = await service.read()
      const firstEvidencePending = !state?.observations.some((item) => item.outcome === 'pass')
      const runStartedAt = events[0]?.timestamp
      if (!state?.contract) throw new Error('Freeze criteria before execution')
      if (state.status !== 'active')
        throw new Error('Active run required before provider execution')
      const boundaries = ['observe', 'propose', 'mutate-worktree', 'open-pr', 'external-action']
      if (
        boundaries.indexOf(state.boundary) < 2 ||
        boundaries.indexOf(boundary) > boundaries.indexOf(state.boundary)
      )
        throw new Error('Requested execution exceeds run action authority')
      if (!execute || authority.owner !== state.owner || authority.generation !== state.generation)
        throw new Error('Current writer execution authority required')
      if (
        !(await service.admitAttempt({ estimatedNext: config.budget?.estimatedNext, authority }))
          .admitted
      )
        throw new Error('Budget admission blocked; checkpoint preserved')
      state = (await service.read()).state
      const definition = { ...check, ...config.candidate }
      if (
        !state.contract.criteria.some(
          (c) => c.id === check.criterionId && c.definitionDigest === recordDigest(definition),
        )
      )
        throw new Error('Check differs from frozen criterion definition')
      const attemptId = randomUUID()
      const attemptStarted = performance.now()
      emitObservation(observer, { kind: 'execution_attempt', state: 'started', attemptId })
      activeAttempt = { attemptId, started: attemptStarted }
      const collected = collectProcessObservation({ root, definition, boundary })
      emitObservation(observer, {
        kind: 'execution_attempt',
        attemptId,
        state: collected.observation.outcome === 'pass' ? 'completed' : 'failed',
        duration: performance.now() - attemptStarted,
      })
      activeAttempt = null
      if (state.candidateDigest !== collected.candidate.digest) {
        await service.record(
          'candidate',
          { digest: collected.candidate.digest },
          { expectedRevision: state.revision, authority },
        )
        state = (await service.read()).state
      }
      result = await service.record(
        'observation',
        { observation: collected.observation },
        { expectedRevision: state.revision, authority },
      )
      result.verification = {
        outcome: collected.observation.outcome,
        observationDigest: collected.observation.digest,
      }
      if (firstEvidencePending && collected.observation.outcome === 'pass')
        emitObservation(observer, {
          kind: 'process_stage',
          stage: 'first-evidence',
          duration: Math.max(0, Date.now() - Date.parse(runStartedAt)),
        })
    } else if (command === 'intent-plan') {
      const { state } = await service.read()
      if (!state || state.phase !== 0) throw new GovernedBlockError('Phase-zero run required')
      const plan = readJson(flag('--plan'))
      if (flag('--confirm') !== recordDigest(plan))
        throw new Error('Advance plan confirmation mismatch')
      const acceptance = await service.verifyCriteria(plan)
      if (acceptance.status !== 'pass')
        throw new GovernedBlockError('Current acceptance evidence required for intent plan')
      result = {
        request: createIntentConsentRequest({
          state,
          planDigest: recordDigest(plan),
          scope: intentScope(state),
          platformConfig: executionAdapter,
        }),
        assurance: 'agent-observed-local-cooperative',
      }
    } else if (command === 'advance') {
      const { state } = await service.read()
      const contract = readJson(flag('--plan'))
      if (flag('--confirm') !== recordDigest(contract))
        throw new Error('Advance plan confirmation mismatch')
      if (contract.runRevision !== state.revision) throw new Error('Advance plan is stale')
      result = await service.advance({ contract, authority })
    } else if (command === 'checkpoint' || command === 'pause') {
      result = await service.record(
        command === 'pause' ? 'paused' : 'checkpoint',
        { reason: flag('--reason', 'Requested operator checkpoint') },
        { expectedRevision: (await service.read()).revision, authority },
      )
    } else if (command === 'resolve-escalation') {
      // D5 (W8c) — the escalated gate's path to satisfaction, reachable from the product's own `run`
      // CLI (bin/cli.mjs -> scripts/run-delivery.mjs). `--attestation` is a review-attestation record
      // (lib/core/review-attestation.mjs); only a real human attestation resolves it
      // (service.resolveEscalation enforces this via satisfyGate).
      //
      // W8c2 D2/D3 — the gate now ranges over the specific drift, not the bare candidate, so
      // resolveEscalation needs the SAME plan (`--plan`, `--confirm`) `next`/`advance` already use to
      // rebuild that drift deterministically — exactly the same confirmation shape `advance` requires
      // just above, never trusted without its digest matching.
      //
      // Final review B1 — DEFECT FIXED. The attestation came from a file the caller writes, and
      // "human" is a declared field on it, so any agent with a shell could resolve a weakening
      // escalation by writing `platform: "human"`. The CLI cannot authenticate a human, exactly as
      // `authorize` above already refuses `human-acceptance`, so it fails closed: a human resolution
      // must arrive through an authenticated channel, never a self-supplied file.
      throw new GovernedBlockError(
        'Escalation resolution requires an authenticated human channel; the run CLI cannot accept a self-supplied attestation',
      )
    } else if (command === 'handoff') {
      if (!execute || !external)
        throw new Error('Durable source and execution authority required for handoff')
      const git = (...params) =>
        execFileSync('git', params, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
      if (git('status', '--porcelain').length)
        throw new Error('Commit and preserve all work before portable handoff')
      const branch = git('symbolic-ref', '--short', 'HEAD')
      const commitSha = git('rev-parse', 'HEAD')
      const remote = await client.request(
        `/repos/${config.source.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      )
      if (remote.object?.sha !== commitSha)
        throw new Error('Exact handoff commit must be preserved at the configured source')
      const artifacts = config.candidate.inputs.map((path) => {
        const bytes = readFileSync(containedPath(root, path))
        return {
          id: recordDigest({ path }),
          path,
          byteLength: bytes.length,
          digest: createHash('sha256').update(bytes).digest('hex'),
        }
      })
      const before = await service.read()
      const candidate = fingerprintCandidate(root, config.candidate).digest
      if (before.state?.candidateDigest !== candidate)
        throw new Error('Handoff candidate differs from verified run')
      await service.record(
        'checkpoint',
        { kind: 'portable-handoff', branch, commitSha, artifacts },
        { expectedRevision: before.revision, authority },
      )
      const snapshot = await service.read()
      result = createContinuationBundle({
        state: snapshot.state,
        runRevision: snapshot.revision,
        branch,
        commitSha,
        artifacts,
        nextSlice: 'source-derived-next',
        storeDigest: snapshot.sourceRevision,
      })
    } else if (command === 'resume') {
      if (external && !flag('--packet'))
        throw new Error('Source-backed continuation --packet required for durable recovery')
      if (flag('--packet')) {
        const packet = readJson(flag('--packet'))
        await reconstructContinuation({
          bundle: packet,
          store,
          strictWorkspace: true,
          resolveWorkspace: async () => {
            const git = (...params) =>
              execFileSync('git', params, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
            return {
              verified: git('status', '--porcelain').length === 0,
              runId: id,
              branch: git('symbolic-ref', '--short', 'HEAD'),
              commitSha: git('rev-parse', 'HEAD'),
              candidateDigest: fingerprintCandidate(root, config.candidate).digest,
              storeDigest: (await store.read({ cache: false })).sourceRevision,
            }
          },
          observeWriter: async (state) => observeLocalWriter(state.writer),
          resolveArtifact: async (artifact) => ({
            content: readFileSync(containedPath(root, artifact.path)),
          }),
        })
        expectedResumeWorkspace = { branch: packet.branch, commitSha: packet.commitSha }
      }
      if (!flag('--confirm'))
        result = await service.recoveryPlan({
          owner: authority.owner,
          boundary,
          writer: {
            host: hostname(),
            pid: Number(flag('--writer-pid', String(process.ppid))),
            instance: randomUUID(),
          },
        })
      else {
        const plan = readJson(flag('--plan'))
        if (plan.digest !== flag('--confirm')) throw new Error('Recovery confirmation mismatch')
        result = await service.resume({ plan, authority })
      }
    } else if (command === 'publish') {
      if (!client) throw new Error('Publishing requires a durable GitHub source')
      if (!flag('--confirm'))
        result = planProjection({
          status: await service.status(),
          repo: config.source.repo,
          issueNumber: Number(flag('--issue')),
        })
      else {
        if (flag('--boundary') !== 'external-action')
          throw new GovernedBlockError('Publication requires explicit --boundary external-action')
        result = await publishProjection({
          service,
          client,
          plan: readJson(flag('--plan')),
          confirm: flag('--confirm'),
          authority,
        })
      }
    } else throw new Error(help)
    // W8e / D6 — a plain-language line before the JSON when `--json` was not requested; `--json`
    // output itself is untouched (still exactly `emit({ version: 1, result })`, nothing prepended).
    if (!args.includes('--json')) process.stdout.write(`${summarizeRunResult(command, result)}\n`)
    emit({ version: 1, result })
    emitObservation(observer, {
      kind: 'session',
      state: 'completed',
      duration: performance.now() - sessionStarted,
    })
    if (command === 'verify')
      emitObservation(observer, {
        kind: 'verification',
        outcome: ['pass', 'fail'].includes(result?.verification?.outcome)
          ? result.verification.outcome
          : 'unknown',
        duration: performance.now() - sessionStarted,
      })
    if (command === 'resume')
      emitObservation(observer, {
        kind: 'recovery',
        outcome: flag('--confirm') && result?.status === 'active' ? 'resumed' : 'unknown',
        duration: performance.now() - sessionStarted,
      })
    return result?.state === 'unknown'
      ? 6
      : result?.blocked || result?.verification?.outcome === 'fail'
        ? 3
        : 0
  } catch (error) {
    if (activeAttempt) {
      emitObservation(observer, {
        kind: 'execution_attempt',
        attemptId: activeAttempt.attemptId,
        operationId: activeAttempt.operationId,
        state: 'unknown',
        duration: performance.now() - activeAttempt.started,
      })
      activeAttempt = null
    }
    emitObservation(observer, {
      kind: 'session',
      state: 'failed',
      duration: performance.now() - sessionStarted,
    })
    throw error
  } finally {
    const shutdownStarted = performance.now()
    const applicationMs = shutdownStarted - invocationStarted
    try {
      await telemetry.shutdown()
      if (executionAdapter.observability?.enabled && telemetry.getReport) {
        process.stderr.write(`${JSON.stringify({ telemetry: telemetry.getReport() })}\n`)
      }
    } catch (e) {}
    // Measurement is advisory and uses the same boundaries in every mode.
    emitObservation(onTiming, {
      applicationMs,
      shutdownMs: performance.now() - shutdownStarted,
      totalMs: performance.now() - invocationStarted,
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runDelivery(process.argv.slice(2))
  } catch (error) {
    if (!process.argv.includes('--json')) process.stdout.write(`Blocked: ${error.message}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, error: error.message })}\n`)
    process.exitCode = classifyDeliveryError(error)
  }
}
