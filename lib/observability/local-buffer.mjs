import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const OWNED = /^af-otel-v1-\d+-[a-f0-9-]{36}\.json$/
const hash = (value) => createHash('sha256').update(value).digest('hex')
const positive = (value) => Number.isSafeInteger(value) && value > 0

function portable(items) {
  if (Array.isArray(items))
    return {
      kind: 'traces',
      records: items.map((span) => ({
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        attributes: span.attributes,
        context: span.spanContext(),
        parentSpanId: span.parentSpanId ?? null,
      })),
    }
  return {
    kind: 'metrics',
    records: (items.scopeMetrics ?? []).flatMap((scope) =>
      scope.metrics.map((metric) => ({
        name: metric.descriptor.name,
        unit: metric.descriptor.unit,
        dataPointType: metric.dataPointType,
        aggregationTemporality: metric.aggregationTemporality,
        dataPoints: metric.dataPoints.map((point) => ({
          attributes: point.attributes,
          startTime: point.startTime,
          endTime: point.endTime,
          value: point.value,
        })),
      })),
    ),
  }
}

// Advisory data only. An unavailable spool drops observations, never audit records.
export class LocalSpoolExporter {
  constructor({
    maxSpoolBytes = 32 * 1024 * 1024,
    maxBufferBytes = 8 * 1024 * 1024,
    spoolDir = '.agent-runs/telemetry',
    retentionDays = 7,
    now = Date.now,
    io = fs,
  } = {}) {
    if (
      !positive(maxSpoolBytes) ||
      !positive(maxBufferBytes) ||
      maxSpoolBytes > 32 * 1024 * 1024 ||
      maxBufferBytes > 8 * 1024 * 1024 ||
      !Number.isFinite(retentionDays) ||
      retentionDays <= 0 ||
      retentionDays > 7
    )
      throw new Error('Invalid telemetry bounds')
    Object.assign(this, {
      maxSpoolBytes,
      maxBufferBytes,
      spoolDir: path.resolve(spoolDir),
      now,
      io,
    })
    this.retentionMs = retentionDays * 86400000
    this.buffer = []
    this.bufferBytes = 0
    this.drops = 0
    this.expired = 0
    this.evicted = 0
    this.writeFailures = 0
    this.closed = false
    try {
      io.mkdirSync(this.spoolDir, { recursive: true })
      if (
        !io.lstatSync(this.spoolDir).isDirectory() ||
        io.lstatSync(this.spoolDir).isSymbolicLink()
      )
        throw new Error('Invalid spool directory')
      this.available = true
    } catch {
      this.available = false
    }
  }

  export(items, callback) {
    let count = Array.isArray(items) ? items.length : 1
    try {
      if (this.closed || !this.available) throw new Error('Spool unavailable')
      const payload = portable(items)
      count = payload.records.length
      const content = JSON.stringify(payload)
      const bytes = Buffer.from(
        JSON.stringify({
          version: 1,
          createdAt: this.now(),
          count,
          sha256: hash(content),
          payload,
        }) + '\n',
      )
      if (bytes.length > this.maxBufferBytes || bytes.length > this.maxSpoolBytes)
        throw new Error('Oversized telemetry batch')
      if (this.bufferBytes + bytes.length > this.maxBufferBytes) this.flushSync()
      this.buffer.push({ bytes, count })
      this.bufferBytes += bytes.length
      callback({ code: 0 })
    } catch {
      this.drops += count
      callback({ code: 1 })
    }
  }

  flushSync() {
    const pending = this.buffer
    this.buffer = []
    this.bufferBytes = 0
    if (!this.available) {
      this.drops += pending.reduce((n, item) => n + item.count, 0)
      return
    }
    const lock = path.join(this.spoolDir, '.writer-lock')
    let lockFd
    try {
      // Cooperative writers serialize size accounting; crash-stale lock fails closed
      // for telemetry only. Never remove another writer's lock automatically.
      lockFd = this.io.openSync(lock, 'wx')
      const files = []
      const entries = this.io.opendirSync(this.spoolDir)
      let scanned = 0
      try {
        let entry
        while ((entry = entries.readSync())) {
          if (++scanned > 4096) throw new Error('Spool scan bound exceeded')
          if (!OWNED.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue
          const file = path.join(this.spoolDir, entry.name)
          const stat = this.io.lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink()) continue
          let record = null
          if (stat.size <= this.maxSpoolBytes) {
            try {
              const parsed = JSON.parse(this.io.readFileSync(file, 'utf8'))
              if (
                parsed.version === 1 &&
                ['traces', 'metrics'].includes(parsed.payload?.kind) &&
                Number.isSafeInteger(parsed.count) &&
                parsed.count >= 0 &&
                Number.isFinite(parsed.createdAt) &&
                parsed.sha256 === hash(JSON.stringify(parsed.payload))
              )
                record = parsed
            } catch {
              /* Preserve corrupt or unrecognized data; it still occupies capacity. */
            }
          }
          if (record && this.now() - record.createdAt >= this.retentionMs) {
            this.io.unlinkSync(file)
            this.expired += record.count
            this.drops += record.count
          } else files.push({ file, size: stat.size, record })
        }
      } finally {
        entries.closeSync()
      }
      let used = files.reduce((n, file) => n + file.size, 0)
      files.sort((a, b) => (a.record?.createdAt ?? Infinity) - (b.record?.createdAt ?? Infinity))
      for (const item of pending) {
        for (const file of files) {
          if (used + item.bytes.length <= this.maxSpoolBytes) break
          if (!file.record || file.removed) continue
          this.io.unlinkSync(file.file)
          used -= file.size
          file.removed = true
          this.evicted += file.record.count
          this.drops += file.record.count
        }
        if (used + item.bytes.length > this.maxSpoolBytes) {
          this.drops += item.count
          item.written = true
          continue
        }
        const file = path.join(this.spoolDir, `af-otel-v1-${this.now()}-${randomUUID()}.json`)
        this.io.writeFileSync(file, item.bytes, { flag: 'wx' })
        used += item.bytes.length
        files.push({
          file,
          size: item.bytes.length,
          record: { count: item.count, createdAt: this.now() },
        })
        item.written = true
      }
    } catch {
      this.writeFailures++
      this.drops += pending.filter((item) => !item.written).reduce((n, item) => n + item.count, 0)
    } finally {
      if (lockFd !== undefined) {
        try {
          this.io.closeSync(lockFd)
        } catch {}
        try {
          this.io.unlinkSync(lock)
        } catch {}
      }
    }
  }

  async forceFlush() {
    this.flushSync()
  }
  async shutdown() {
    if (!this.closed) this.flushSync()
    this.closed = true
  }
}
