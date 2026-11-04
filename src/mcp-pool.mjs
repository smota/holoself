// Bounded worker-thread pool for MCP tool calls (#62). The deterministic core stays synchronous and shared with the
// CLI; the stdio server runs it off the main thread so ping, initialize, tools/list, notifications and cancellation
// are answered immediately while a slow call runs.
//
// Scheduling rules:
// - at most `size` jobs run at once, one per worker;
// - a job whose affinity key was seen before goes back to the same worker, so the per-process in-memory selection
//   cache keeps reporting `cache.hit` as it would in a single-threaded server (until that worker is replaced);
// - an exclusive job (a tool that writes, such as proposal_create) runs alone: it waits for running jobs to
//   finish, and no later job overtakes it or runs beside it;
// - cancelling a queued job removes it. Cancelling a running read-only job, or one that exceeds `timeoutMs`,
//   terminates its worker; a terminated job never produces a result. An exclusive job is never terminated, so a
//   write cannot be cut off between its temporary file and its rename: cancelling it lets it finish and drops the
//   result ({ status: 'dropped', value } so the caller can still record that the write happened). It is exempt
//   from `timeoutMs`; past the much longer `writeTimeoutMs` its caller is answered with 'timeout', but the job
//   keeps its slot - and the exclusive barrier - until the worker really finishes or the pool is closed;
// - workers are started lazily by the next job that needs one, and scheduling after a cancellation or timeout is
//   deferred to the next turn of the event loop, so a burst of cancellations never spawns a worker per message.
// Every submitted job settles exactly once with { status: 'ok' | 'cancelled' | 'dropped' | 'timeout' | 'crashed', value? }.
import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./mcp-worker.mjs', import.meta.url)
const AFFINITY_LIMIT = 256

export function createToolPool({ size = 2, timeoutMs = 60000, writeTimeoutMs = 600000, workerData = {}, maxOldGenerationSizeMb = 512 } = {}) {
  const slots = Array.from({ length: Math.max(1, size) }, (_, index) => ({ index, worker: null, job: null }))
  const queue = new Set(),
    affinity = new Map()
  let nextJobId = 1,
    closed = false,
    spawned = 0,
    pumpScheduled = false

  function spawn(slot) {
    const worker = new Worker(WORKER_URL, { workerData, stdout: true, resourceLimits: { maxOldGenerationSizeMb } })
    spawned++
    // Worker console output must never reach the protocol stream.
    worker.stdout.on('data', chunk => process.stderr.write(chunk))
    worker.on('message', message => {
      if (slot.worker !== worker || !slot.job || message?.jobId !== slot.job.id) return
      finish(slot, slot.job.dropped ? { status: 'dropped', value: message } : { status: 'ok', value: message })
    })
    const crashed = () => {
      if (slot.worker === worker) recycle(slot, { status: 'crashed' })
    }
    worker.on('messageerror', crashed)
    worker.on('error', crashed)
    worker.on('exit', crashed)
    worker.unref()
    slot.worker = worker
  }
  function finish(slot, outcome, { deferPump = false } = {}) {
    const job = slot.job
    slot.job = null
    slot.worker?.unref()
    if (job) {
      clearTimeout(job.timer)
      job.state = 'done'
      settle(job, outcome)
    }
    if (deferPump) schedulePump()
    else pump()
  }
  function recycle(slot, outcome) {
    const worker = slot.worker
    slot.worker = null
    for (const [key, index] of affinity) if (index === slot.index) affinity.delete(key)
    const stopped = worker ? worker.terminate().catch(() => {}) : Promise.resolve()
    if (slot.job) finish(slot, outcome, { deferPump: true })
    return stopped
  }
  function start(slot, job) {
    if (!slot.worker) spawn(slot)
    slot.job = job
    job.state = 'running'
    slot.worker.ref()
    job.timer = job.exclusive ? setTimeout(() => settle(job, { status: 'timeout' }), writeTimeoutMs) : setTimeout(() => recycle(slot, { status: 'timeout' }), timeoutMs)
    slot.worker.postMessage({ jobId: job.id, ...job.payload })
  }
  function slotFor(job) {
    const pinned = affinity.get(job.key)
    if (pinned !== undefined) return slots[pinned].job ? null : slots[pinned]
    const free = slots.find(slot => !slot.job && slot.worker) || slots.find(slot => !slot.job)
    if (free) {
      affinity.set(job.key, free.index)
      if (affinity.size > AFFINITY_LIMIT) affinity.delete(affinity.keys().next().value)
    }
    return free || null
  }
  function settle(job, outcome) {
    if (job.settled) return
    job.settled = true
    job.resolve(outcome)
  }
  function schedulePump() {
    if (pumpScheduled) return
    pumpScheduled = true
    setImmediate(() => {
      pumpScheduled = false
      pump()
    })
  }
  function pump() {
    if (closed || slots.some(slot => slot.job?.exclusive)) return
    for (const job of queue) {
      if (slots.every(slot => slot.job)) return
      if (job.exclusive) {
        if (slots.some(slot => slot.job)) return
        queue.delete(job)
        start(slotFor(job) || slots[0], job)
        return
      }
      const slot = slotFor(job)
      if (!slot) continue
      queue.delete(job)
      start(slot, job)
    }
  }
  function cancel(job) {
    if (job.state === 'queued') {
      queue.delete(job)
      job.state = 'done'
      settle(job, { status: 'cancelled' })
      schedulePump()
    } else if (job.state === 'running') {
      if (job.exclusive) {
        job.dropped = true
        return
      }
      const slot = slots.find(item => item.job === job)
      if (slot) recycle(slot, { status: 'cancelled' })
    }
  }

  return {
    submit(payload, { key = '', exclusive = false } = {}) {
      const job = { id: nextJobId++, payload, key, exclusive, state: 'queued', dropped: false, settled: false, timer: null, resolve: null }
      const promise = new Promise(resolvePromise => (job.resolve = resolvePromise))
      if (closed) {
        job.state = 'done'
        settle(job, { status: 'cancelled' })
      } else {
        queue.add(job)
        pump()
      }
      return { promise, cancel: () => cancel(job) }
    },
    stats() {
      return { running: slots.filter(slot => slot.job).length, queued: queue.size, workers: slots.filter(slot => slot.worker).length, spawned }
    },
    async close() {
      closed = true
      for (const job of queue) {
        job.state = 'done'
        settle(job, { status: 'cancelled' })
      }
      queue.clear()
      await Promise.all(slots.map(slot => recycle(slot, { status: 'cancelled' })))
    }
  }
}
