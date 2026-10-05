import { recordDigest } from '../core/record-digest.mjs'
import { sealDeliveryRecord, requireDeliveryRecord } from '../core/delivery-record.mjs'

function projectionContent(plan) {
  const { repo, issueNumber, runId, status, role, candidateDigest, nextAction } = plan
  return recordDigest({ repo, issueNumber, runId, status, role, candidateDigest, nextAction })
}

function scopeMarker(plan) {
  return `<!-- agentflow-run:${recordDigest({ repo: plan.repo, issueNumber: plan.issueNumber, runId: plan.runId })} -->`
}

async function readComments(client, plan) {
  const all = []
  let retainedBytes = 0
  for (let page = 1; page <= 100; page++) {
    const comments = await client.request(
      `/repos/${plan.repo}/issues/${plan.issueNumber}/comments?per_page=100&page=${page}`,
    )
    if (!Array.isArray(comments) || comments.some((comment) => typeof comment?.body !== 'string'))
      throw new Error('Invalid comments response')
    retainedBytes += Buffer.byteLength(JSON.stringify(comments))
    if (retainedBytes > 8 * 1024 * 1024) return null
    all.push(...comments)
    if (comments.length < 100) return all
  }
  return null
}

export function planProjection({ status, repo, issueNumber }) {
  if (
    !status?.durable ||
    !status.revision ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !Number.isInteger(issueNumber) ||
    issueNumber < 1
  )
    throw new Error('Projection requires a durable run and exact issue destination')
  const payload = {
    repo,
    issueNumber,
    runId: status.runId,
    revision: status.revision,
    status: status.status,
    role: status.role,
    candidateDigest: status.candidateDigest,
    nextAction: status.nextAction,
  }
  const id = recordDigest(payload)
  const body = `<!-- agentflow-run-projection:${id} -->\n${scopeMarker(payload)}\nAgentflow run **${status.runId}**: ${status.status}\n\nRole: ${status.role}\nCandidate: ${status.candidateDigest ?? 'unverified'}\nNext action: ${status.nextAction}\nRun revision: ${status.revision}\n`
  return sealDeliveryRecord('projection-plan', { ...payload, id, body })
}

export async function reconcileProjection({ client, plan }) {
  const marker = `<!-- agentflow-run-projection:${plan.id} -->`
  const comments = await readComments(client, plan)
  if (comments) {
    const matches = comments.filter((comment) => comment.body.includes(marker))
    return matches.length === 1 && matches[0].body === plan.body
      ? { verified: true, state: 'confirmed', url: matches[0].html_url, id: matches[0].id }
      : {
          state: 'unknown',
          reason: matches.length
            ? 'Duplicate or changed projection markers'
            : 'Projection not observed; absence does not prove submission failed',
        }
  }
  return { state: 'unknown', reason: 'Incomplete comment pagination' }
}

export async function publishProjection({ service, client, plan, confirm, authority }) {
  requireDeliveryRecord(plan, 'projection-plan')
  if (confirm !== plan.digest) throw new Error('Projection confirmation mismatch')
  await service.assertPublicationAuthority(authority)
  let { state } = await service.read()
  const operation = state.operations[plan.id]
  if (operation) {
    if (operation.payloadDigest !== plan.digest)
      throw new Error('Projection operation payload changed')
    // An acknowledged operation is historical evidence, not proof the remote
    // comment still exists or has not been edited by another actor.
    if (operation.state === 'confirmed') return reconcileProjection({ client, plan })
    // A second invocation is reconciliation only, never another POST.
    const result = await reconcileProjection({ client, plan })
    if (result.verified)
      await service.reconcile(plan.id, { expectedRevision: state.revision, authority })
    return result
  }
  if (state.revision !== plan.revision) throw new Error('Projection plan is stale')
  const previous = Object.values(state.operations).filter(
    (op) =>
      op.kind === 'issue-projection' &&
      op.plan?.repo === plan.repo &&
      op.plan?.issueNumber === plan.issueNumber &&
      op.plan?.runId === plan.runId,
  )
  if (previous.some((op) => !['confirmed', 'failed'].includes(op.state)))
    return { state: 'unknown', reason: 'Reconcile pending projection before publishing' }
  if (previous.length) {
    const comments = await readComments(client, plan)
    if (!comments) return { state: 'unknown', reason: 'Incomplete comment pagination' }
    const managed = comments.filter(
      (comment) =>
        comment.body.includes(scopeMarker(plan)) ||
        previous.some((op) =>
          comment.body.includes(`<!-- agentflow-run-projection:${op.plan.id} -->`),
        ),
    )
    const latest = managed.at(-1)
    const prior = previous.findLast((op) => op.state === 'confirmed')
    // No overwrite or blind repost when remote evidence disappeared or diverged.
    if (!prior || prior.plan.body !== latest?.body)
      return { state: 'unknown', reason: 'Remote projection diverged; reconcile before publishing' }
    const marker = `<!-- agentflow-run-projection:${prior.plan.id} -->`
    if (managed.filter((comment) => comment.body.includes(marker)).length !== 1)
      return { state: 'unknown', reason: 'Duplicate projection markers' }
    if (projectionContent(prior.plan) === projectionContent(plan)) {
      if ((await service.read()).state.revision !== state.revision)
        throw new Error('Projection plan became stale during remote observation')
      return {
        verified: true,
        state: 'confirmed',
        coalesced: true,
        url: latest.html_url,
        id: latest.id,
        projectedRevision: prior.plan.revision,
        observedRevision: state.revision,
      }
    }
  }
  const intent = {
    id: plan.id,
    payloadDigest: plan.digest,
    kind: 'issue-projection',
    destination: { repo: plan.repo, issueNumber: plan.issueNumber },
    state: 'planned',
    plan,
  }
  await service.record('operation', intent, { expectedRevision: state.revision, authority })
  state = (await service.read()).state
  await service.record(
    'operation',
    { ...intent, state: 'submitted' },
    { expectedRevision: state.revision, authority },
  )
  try {
    await client.request(`/repos/${plan.repo}/issues/${plan.issueNumber}/comments`, {
      method: 'POST',
      body: { body: plan.body },
    })
    const result = await reconcileProjection({ client, plan })
    state = (await service.read()).state
    if (result.verified)
      await service.reconcile(plan.id, { expectedRevision: state.revision, authority })
    else
      await service.record(
        'operation',
        { ...intent, state: 'unknown' },
        { expectedRevision: state.revision, authority },
      )
    return result
  } catch {
    state = (await service.read()).state
    await service.record(
      'operation',
      { ...intent, state: 'unknown' },
      { expectedRevision: state.revision, authority },
    )
    return { state: 'unknown', reason: 'Reconcile before any retry' }
  }
}
