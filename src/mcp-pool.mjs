// Bounded worker-thread pool for MCP tool calls (#62). The deterministic core stays synchronous and shared with the
// CLI; the stdio server runs it off the main thread so ping, initialize, tools/list, notifications and cancellation
// are answered immediately while a slow call runs.
//
// Scheduling rules:
// - at most `size` jobs run at once, one per worker;
// - a job whose affinity key (tool + canonical arguments) was seen before goes back to the same worker, so the
//   per-process in-memory selection cache keeps reporting `cache.hit` as it would in a single-threaded server;
// - an exclusive job (a tool that writes, such as proposal_create) runs alone: it waits for running jobs to
//   finish, and no later job overtakes it or runs beside it;
// - cancelling a queued job removes it; cancelling a running job, or a job that exceeds `timeoutMs`, terminates
//   that worker and a fresh one is started for the next job. A terminated job never produces a result.
// Every submitted job settles exactly once with { status: 'ok' | 'cancelled' | 'timeout' | 'crashed', value? }.
import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./mcp-worker.mjs', import.meta.url)
const AFFINITY_LIMIT = 256

export function createToolPool({ size = 2, timeoutMs = 60000, workerData = {} } = {}) {
  const slots = Array.from({ length: Math.max(1, size) }, (_, index) => ({ index, worker: null, job: null }))
  const queue = [],
    affinity = new Map()
  let nextJobId = 1,
    closed = false

  function spawn(slot) {
    const worker = new Worker(WORKER_URL, { workerData, stdout: true })
    // Worker console output must never reach the protocol stream.
    worker.stdout.on('data', chunk => process.stderr.write(chunk))
    worker.on('message', message => {
      if (slot.worker === worker && slot.job && message?.jobId === slot.job.id) finish(slot, { status: 'ok', value: message })
    })
    worker.on('error', () => {
      if (slot.worker === worker) recycle(slot, { status: 'crashed' })
    })
    worker.on('exit', () => {
      if (slot.worker === worker) recycle(slot, { status: 'crashed' })
    })
    worker.unref()
    slot.worker = worker
  }
  function finish(slot, outcome) {
    const job = slot.job
    slot.job = null
    slot.worker?.unref()
    if (job) {
      clearTimeout(job.timer)
      job.state = 'done'
      job.resolve(outcome)
    }
    pump()
  }
  function recycle(slot, outcome) {
    const worker = slot.worker
    slot.worker = null
    for (const [key, index] of affinity) if (index === slot.index) affinity.delete(key)
    const stopped = worker ? worker.terminate().catch(() => {}) : Promise.resolve()
    if (slot.job) finish(slot, outcome)
    return stopped
  }
  function start(slot, job) {
    if (!slot.worker) spawn(slot)
    slot.job = job
    job.state = 'running'
    slot.worker.ref()
    job.timer = setTimeout(() => recycle(slot, { status: 'timeout' }), timeoutMs)
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
  function pump() {
    if (closed || slots.some(slot => slot.job?.exclusive)) return
    for (let i = 0; i < queue.length; ) {
      const job = queue[i]
      if (job.exclusive) {
        if (slots.some(slot => slot.job)) return
        queue.splice(i, 1)
        start(slotFor(job) || slots[0], job)
        return
      }
      const slot = slotFor(job)
      if (!slot) {
        i++
        continue
      }
      queue.splice(i, 1)
      start(slot, job)
    }
  }
  function cancel(job) {
    if (job.state === 'queued') {
      queue.splice(queue.indexOf(job), 1)
      job.state = 'done'
      job.resolve({ status: 'cancelled' })
      pump()
    } else if (job.state === 'running') {
      const slot = slots.find(item => item.job === job)
      if (slot) recycle(slot, { status: 'cancelled' })
    }
  }

  return {
    submit(payload, { key = '', exclusive = false } = {}) {
      const job = { id: nextJobId++, payload, key, exclusive, state: 'queued', timer: null, resolve: null }
      const promise = new Promise(resolvePromise => (job.resolve = resolvePromise))
      if (closed) {
        job.state = 'done'
        job.resolve({ status: 'cancelled' })
      } else {
        queue.push(job)
        pump()
      }
      return { promise, cancel: () => cancel(job) }
    },
    stats() {
      return { running: slots.filter(slot => slot.job).length, queued: queue.length, workers: slots.filter(slot => slot.worker).length }
    },
    async close() {
      closed = true
      for (const job of queue.splice(0)) {
        job.state = 'done'
        job.resolve({ status: 'cancelled' })
      }
      await Promise.all(slots.map(slot => recycle(slot, { status: 'cancelled' })))
    }
  }
}
