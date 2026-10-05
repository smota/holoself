import { normalizeOperation, operationDigest } from '../core/delegation-grant.mjs'
import { recordDigest } from '../core/record-digest.mjs'
import { createGitHubMergeAdapter } from './github-merge.mjs'

// A narrow external-action port. It never issues grants or accepts review claims.
export function createGitHubDeliveryActions({ client }) {
  const merge = createGitHubMergeAdapter({ client })
  const bind = (input) => {
    const operation = normalizeOperation(input)
    if (!/^[\w.-]+\/[\w.-]+$/.test(operation.repository))
      throw new Error('Exact repository binding required')
    if (!['pr:create', 'pr:update', 'merge'].includes(operation.action))
      throw new Error('Unsupported delivery action; no effect dispatched')
    const args = operation.arguments
    if (!/^[a-f0-9]{40}$/.test(args.headSha ?? '')) throw new Error('Exact head SHA required')
    if (
      operation.action === 'pr:create' &&
      (typeof args.head !== 'string' || !args.head || typeof args.title !== 'string' || !args.title)
    )
      throw new Error('PR head and title required')
    if (
      operation.action === 'pr:create' &&
      Object.hasOwn(args, 'draft') &&
      typeof args.draft !== 'boolean'
    )
      throw new Error('PR draft must be a boolean when supplied')
    if (
      operation.action === 'pr:update' &&
      (!Number.isSafeInteger(args.prNumber) || args.prNumber < 1)
    )
      throw new Error('PR number required')
    if (operation.action !== 'merge' && typeof args.body !== 'string')
      throw new Error('PR body required')
    return {
      operation,
      args,
      draft: operation.action === 'pr:create' ? (args.draft ?? true) : undefined,
      base: `/repos/${operation.repository}`,
      marker: `<!-- agentflow-operation:${operationDigest(operation)} -->`,
    }
  }
  const bodyFor = (b) => `${b.args.body}\n\n${b.marker}`
  async function locate(b) {
    if (b.operation.action === 'pr:update')
      return [await client.request(`${b.base}/pulls/${b.args.prNumber}`)]
    const prs = await client.request(
      `${b.base}/pulls?state=all&head=${encodeURIComponent(b.operation.repository.split('/')[0] + ':' + b.args.head)}&base=${encodeURIComponent(b.operation.base)}&per_page=100`,
    )
    return prs
  }
  const matches = (pr, b) =>
    pr?.base?.repo?.full_name === b.operation.repository &&
    pr.base.ref === b.operation.base &&
    pr.head?.sha === b.args.headSha &&
    (b.operation.action !== 'pr:create' || pr.head?.ref === b.args.head)
  async function preflight(input) {
    const b = bind(input)
    const comparison = await client.request(
      `${b.base}/compare/${encodeURIComponent(b.operation.base)}...${b.args.headSha}`,
    )
    if (
      !Array.isArray(comparison.files) ||
      comparison.files.length >= 300 ||
      !Number.isSafeInteger(comparison.total_commits) ||
      comparison.total_commits < 1 ||
      comparison.total_commits > 250 ||
      comparison.commits?.at(-1)?.sha !== b.args.headSha
    )
      throw new Error('Complete exact-candidate changed-path evidence required')
    const paths = new Set(
      comparison.files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)),
    )
    if (!paths.size || [...paths].some((path) => !b.operation.paths.includes(path)))
      throw new Error('Actual changed paths exceed admitted operation scope')
    return { verified: true, paths: [...paths] }
  }
  return {
    preflight,
    async dispatch(input) {
      const b = bind(input)
      await preflight(input)
      if (b.operation.action === 'merge') return merge.dispatch(input)
      if (b.operation.action === 'pr:create') {
        const head = await client.request(
          `${b.base}/git/ref/heads/${encodeURIComponent(b.args.head)}`,
        )
        if (head?.object?.sha !== b.args.headSha) throw new Error('PR candidate changed')
        const existing = await locate(b)
        if (existing.some((pr) => matches(pr, b) && pr.body === bodyFor(b)))
          return { state: 'requires-reconciliation' }
        await client.request(`${b.base}/pulls`, {
          method: 'POST',
          body: {
            head: b.args.head,
            base: b.operation.base,
            title: b.args.title,
            body: bodyFor(b),
            draft: b.draft,
          },
        })
      } else {
        const [pr] = await locate(b)
        if (!matches(pr, b) || pr.state !== 'open') throw new Error('PR candidate changed')
        await client.request(`${b.base}/pulls/${b.args.prNumber}`, {
          method: 'PATCH',
          body: {
            body: bodyFor(b),
            ...(b.args.title ? { title: b.args.title } : {}),
          },
        })
      }
      return { state: 'requires-reconciliation' }
    },
    async reconcile(record, admission) {
      const b = bind(admission.operation)
      if (b.operation.action === 'merge') return merge.reconcile(record, admission)
      const digest = operationDigest(b.operation)
      if (
        record.id !== b.operation.id ||
        record.payloadDigest !== digest ||
        admission.operationDigest !== digest
      )
        throw new Error('Admitted operation identity mismatch')
      const matchesFound = (await locate(b)).filter(
        (pr) =>
          matches(pr, b) &&
          pr.body === bodyFor(b) &&
          (!b.args.title || pr.title === b.args.title) &&
          (b.operation.action !== 'pr:create' || pr.draft === b.draft),
      )
      if (matchesFound.length !== 1) return { state: 'unknown' }
      const pr = matchesFound[0]
      return {
        verified: true,
        state: 'confirmed',
        operationId: b.operation.id,
        payloadDigest: digest,
        candidateDigest: b.operation.candidateDigest,
        sourceRevision: recordDigest({
          number: pr.number,
          head: pr.head.sha,
          body: pr.body,
          updatedAt: pr.updated_at,
          ...(b.operation.action === 'pr:create' ? { draft: pr.draft } : {}),
        }),
      }
    },
  }
}
