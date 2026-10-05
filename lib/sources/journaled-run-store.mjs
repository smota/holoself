import { createPendingAuditJournal } from './pending-audit-journal.mjs'
import { reduceRun } from '../core/run-state.mjs'

// Write-ahead evidence is local recovery data, never a replacement for the source.
export function createJournaledRunStore({ store, directory, observeWriter }) {
  const fresh = () => store.read({ cache: false })
  const journal = createPendingAuditJournal({
    directory,
    verifyAcknowledgment: async ({ event }) => {
      const snapshot = await fresh()
      const found = snapshot.events.find((item) => item.id === event.id)
      return {
        acknowledged: found?.digest === event.digest,
        eventId: event.id,
        eventDigest: event.digest,
        sourceRevision: snapshot.revision,
      }
    },
    verifyNonCommitment: async ({ event }) => {
      const snapshot = await fresh()
      return {
        notCommitted:
          snapshot.revision !== event.previousDigest &&
          !snapshot.events.some((item) => item.id === event.id),
        sourceRevision: snapshot.sourceRevision ?? snapshot.revision,
      }
    },
    verifyPhysicalRecovery: async ({ before, staged, safety, authority }) => {
      const snapshot = await fresh()
      const candidate = staged ?? before
      const state = reduceRun(snapshot.events)
      const recoveryEvent = candidate.entries[0]?.event ?? safety[0]?.event ?? snapshot.events[0]
      const writerState =
        state ??
        (recoveryEvent?.kind === 'started'
          ? {
              owner: recoveryEvent.payload.owner,
              generation: 0,
              writer: recoveryEvent.payload.writer,
            }
          : null)
      if (
        !writerState ||
        authority?.execute !== true ||
        authority.owner !== writerState.owner ||
        authority.generation !== writerState.generation ||
        typeof observeWriter !== 'function' ||
        (await observeWriter(writerState))?.stopped !== true
      )
        throw new Error('Physical journal recovery requires the recorded writer to be stopped')
      const sourceEvent = (event) => snapshot.events.find((item) => item.id === event.id)
      for (const entry of candidate.entries) {
        const found = sourceEvent(entry.event)
        if (found && found.digest !== entry.event.digest)
          throw new Error('Source conflicts with staged pending event')
      }
      for (const entry of safety) {
        const found = sourceEvent(entry.event)
        if (found && found.digest !== entry.event.digest)
          throw new Error('Source conflicts with staged safety event')
      }
      for (const ack of candidate.acknowledgments)
        if (snapshot.events.find((event) => event.id === ack.eventId)?.digest !== ack.eventDigest)
          throw new Error('Source does not contain staged acknowledgment')
      for (const retired of candidate.retirements) {
        if (snapshot.events.some((event) => event.id === retired.eventId))
          throw new Error('Source contradicts staged retirement')
        const previous = before.entries.find(
          (entry) => entry.event.id === retired.eventId && entry.event.runId === retired.runId,
        )
        if (previous && snapshot.revision === previous.event.previousDigest)
          throw new Error('Source has not advanced past staged retirement')
      }
    },
  })
  async function reconcile({ replay = false, authority, recoverStages = false } = {}) {
    let physicalRecovery = null
    if (recoverStages) {
      if (replay) throw new Error('Physical recovery and event replay require separate operations')
      if (authority?.execute !== true)
        throw new Error('Execution authority required for physical recovery')
      const snapshot = await fresh()
      const state = reduceRun(snapshot.events)
      if (state && (authority.owner !== state.owner || authority.generation !== state.generation))
        throw new Error('Physical recovery requires recorded writer generation')
      physicalRecovery = await journal.recoverPhysical({ authority })
    }
    const pending = await journal.list()
    if (pending.recoveryRequired) throw new Error('Pending audit stage requires recovery')
    let snapshot = await fresh()
    for (const ack of pending.acknowledgments) {
      if (
        !snapshot.events.some(
          (event) => event.id === ack.eventId && event.digest === ack.eventDigest,
        )
      )
        throw new Error('Authoritative source no longer contains acknowledged journal history')
    }
    for (const retired of pending.retirements) {
      if (snapshot.events.some((event) => event.id === retired.eventId))
        throw new Error('Authoritative source contradicts non-committed journal retirement')
    }
    for (const entry of pending.entries.filter((entry) => entry.acknowledged)) {
      if (
        !snapshot.events.some(
          (event) => event.id === entry.event.id && event.digest === entry.event.digest,
        )
      )
        throw new Error('Authoritative source no longer contains acknowledged safety history')
    }
    for (const entry of pending.entries.filter((entry) => !entry.acknowledged)) {
      const event = entry.event
      let found = snapshot.events.find((item) => item.id === event.id)
      if (found && found.digest !== event.digest) throw new Error('Conflicting pending event')
      if (!found && replay) {
        const state = reduceRun(snapshot.events)
        if (
          !state ||
          authority?.execute !== true ||
          authority.owner !== state.owner ||
          authority.generation !== state.generation ||
          event.generation !== state.generation ||
          event.previousDigest !== snapshot.revision
        )
          throw new Error(
            'Pending event replay requires unchanged source and recorded writer identity',
          )
        if (typeof observeWriter !== 'function')
          throw new Error('Pending event replay requires a writer liveness observer')
        const writer = await observeWriter(state)
        if (writer?.stopped !== true)
          throw new Error('Pending event replay requires the recorded writer to be stopped')
        await store.append(event, snapshot.revision)
        snapshot = await fresh()
        found = snapshot.events.find((item) => item.id === event.id)
      }
      if (!found)
        return {
          state: 'unknown',
          pendingEventId: event.id,
          ...(physicalRecovery?.recovered ? { physicalRecovery } : {}),
        }
      await journal.ack(event.id, event.digest, {}, { runId: event.runId })
    }
    return { state: 'acknowledged', ...(physicalRecovery?.recovered ? { physicalRecovery } : {}) }
  }
  return {
    ...store,
    journal,
    reconcileJournal: reconcile,
    async append(event, expectedRevision) {
      if ((await reconcile()).state !== 'acknowledged')
        throw new Error('Pending audit event requires reconciliation before new work')
      const snapshot = await fresh()
      if (snapshot.revision !== expectedRevision)
        throw Object.assign(new Error('Source revision conflict before journal stage'), {
          admissionOutcome: 'not-committed',
        })
      const safety = ['paused', 'blocked', 'delegation-safety'].includes(event.kind)
      const operationId =
        event.kind === 'operation'
          ? event.payload.id
          : event.payload?.kind === 'engineering-result'
            ? event.payload.operationId
            : null
      const admitted = operationId
        ? snapshot.events.find(
            (item) =>
              item.kind === 'operation-admitted' && item.payload.operation.id === operationId,
          )
        : null
      await journal.put(event, {
        kind: safety ? 'safety' : 'business',
        reservedBytes: event.kind === 'operation-admitted' ? 64 * 1024 : 0,
        ...(admitted ? { reservationId: admitted.id } : {}),
      })
      try {
        const result = await store.append(event, expectedRevision)
        await journal.ack(event.id, event.digest, {}, { runId: event.runId })
        return result
      } catch (error) {
        if (!safety) {
          if (error.admissionOutcome === 'not-committed') {
            try {
              await journal.retire(event.id, event.digest, {
                runId: event.runId,
                outcome: 'not-committed',
              })
            } catch {
              await journal.put(event, { state: 'unknown' })
            }
          } else await journal.put(event, { state: 'unknown' })
        }
        error.pendingEvent = event
        throw error
      }
    },
  }
}
