import { normalizeOperation, operationDigest } from '../core/delegation-grant.mjs'
import { recordDigest } from '../core/record-digest.mjs'

// Optional GitHub action adapter. Authority/admission belongs to the run service.
export function createGitHubMergeAdapter({ client }) {
  const binding = (input) => {
    const operation = normalizeOperation(input)
    const { prNumber, headSha, mergeMethod = 'squash' } = operation.arguments
    if (
      operation.action !== 'merge' ||
      !/^[\w.-]+\/[\w.-]+$/.test(operation.repository) ||
      !Number.isSafeInteger(prNumber) ||
      prNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(headSha ?? '') ||
      !['merge', 'squash', 'rebase'].includes(mergeMethod)
    )
      throw new Error('Explicit GitHub merge binding required')
    return {
      operation,
      prNumber,
      headSha,
      mergeMethod,
      path: `/repos/${operation.repository}/pulls/${prNumber}`,
    }
  }
  const matches = (pr, b) =>
    pr?.number === b.prNumber &&
    pr.base?.repo?.full_name === b.operation.repository &&
    pr.base?.ref === b.operation.base &&
    pr.head?.sha === b.headSha
  return {
    async dispatch(input) {
      const b = binding(input)
      const pr = await client.request(b.path)
      if (!matches(pr, b)) throw new Error('Pull request identity or candidate changed')
      if (pr.merged === true) return { state: 'requires-reconciliation' }
      if (pr.state !== 'open') throw new Error('Open pull request required')
      // GitHub conditionally merges only this exact head; no branch deletion.
      await client.request(`${b.path}/merge`, {
        method: 'PUT',
        body: { sha: b.headSha, merge_method: b.mergeMethod },
      })
      return { state: 'requires-reconciliation' }
    },
    async reconcile(record, admission) {
      const b = binding(admission.operation)
      const digest = operationDigest(b.operation)
      if (
        record.id !== b.operation.id ||
        record.payloadDigest !== digest ||
        admission.operationDigest !== digest
      )
        throw new Error('Admitted merge identity mismatch')
      const pr = await client.request(b.path)
      if (
        !matches(pr, b) ||
        pr.merged !== true ||
        !pr.merged_at ||
        !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? '')
      )
        return { state: 'unknown' }
      return {
        verified: true,
        state: 'confirmed',
        operationId: b.operation.id,
        payloadDigest: digest,
        candidateDigest: b.operation.candidateDigest,
        sourceRevision: recordDigest({
          repository: b.operation.repository,
          number: pr.number,
          head: b.headSha,
          base: pr.base.ref,
          mergeCommit: pr.merge_commit_sha,
          mergedAt: pr.merged_at,
        }),
      }
    },
  }
}
