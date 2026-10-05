import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { containedPath } from '../verification/workspace.mjs'
import { reduceRun } from '../core/run-state.mjs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

export function createMemoryRunStore({ durable = false } = {}) {
  let records = []
  return {
    durable,
    async read() {
      return { events: structuredClone(records), revision: reduceRun(records)?.revision ?? null }
    },
    async append(event, expectedRevision) {
      const old = records.find((item) => item.id === event.id)
      if (old) {
        if (old.digest !== event.digest) throw new Error('Conflicting event')
        return this.read()
      }
      if ((reduceRun(records)?.revision ?? null) !== expectedRevision)
        throw new Error('Source revision conflict')
      reduceRun([...records, event])
      records.push(structuredClone(event))
      return this.read()
    },
  }
}

// Local preview storage. A file checkpoint never substitutes for source acknowledgment.
export function createFileRunStore({ root, runId }) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId ?? '')) throw new Error('Invalid runId')
  const path = containedPath(root, `.agent-runs/runs/${runId}/events.json`, { allowMissing: true })
  const lock = path + '.lock'
  const read = () => {
    containedPath(root, path, { allowMissing: true })
    const events = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
    return { events, revision: reduceRun(events)?.revision ?? null }
  }
  return {
    durable: false,
    async read() {
      return read()
    },
    async append(event, expectedRevision) {
      mkdirSync(dirname(path), { recursive: true })
      containedPath(root, lock, { allowMissing: true })
      const descriptor = openSync(lock, 'wx', 0o600)
      const staged = path + '.' + randomUUID() + '.tmp'
      try {
        writeFileSync(
          descriptor,
          JSON.stringify({
            host: hostname(),
            pid: process.pid,
            instance: randomUUID(),
            startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            runId,
            generation: event.generation,
          }),
          { flush: true },
        )
        const current = read()
        const duplicate = current.events.find((item) => item.id === event.id)
        if (duplicate) {
          if (duplicate.digest !== event.digest) throw new Error('Conflicting event')
          return current
        }
        if (current.revision !== expectedRevision) throw new Error('Source revision conflict')
        const events = [...current.events, event]
        reduceRun(events)
        writeFileSync(staged, JSON.stringify(events, null, 2) + '\n', { flag: 'wx', flush: true })
        renameSync(staged, path)
        return read()
      } finally {
        closeSync(descriptor)
        unlinkSync(lock)
        if (existsSync(staged)) unlinkSync(staged)
      }
    },
  }
}
