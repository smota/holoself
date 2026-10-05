// OTel SpanProcessor with explicit serialized-payload and queue-count bounds.
// SDK object/runtime overhead is not represented as measured process RSS.
export class BoundedTraceProcessor {
  constructor(
    exporter,
    { maxBytes = 8 * 1024 * 1024, maxQueueSize = 2048, timeoutMs = 750, intervalMs = 1000 } = {},
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(maxQueueSize) ||
      maxQueueSize < 1 ||
      maxQueueSize > 2048
    )
      throw new Error('Invalid trace queue bounds')
    Object.assign(this, { exporter, maxBytes, maxQueueSize, timeoutMs, intervalMs })
    this.queue = []
    this.bytes = 0
    this.count = 0
    this.drops = 0
    this.closed = false
    this.draining = null
    this.timer = null
  }
  onStart() {}
  onEnd(span) {
    try {
      const bytes = Buffer.byteLength(
        JSON.stringify({
          name: span.name,
          attributes: span.attributes,
          context: span.spanContext(),
          start: span.startTime,
          end: span.endTime,
        }),
      )
      if (this.closed || this.count >= this.maxQueueSize || this.bytes + bytes > this.maxBytes) {
        this.drops++
        return
      }
      this.queue.push({ span, bytes })
      this.bytes += bytes
      this.count++
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          void this.forceFlush()
        }, this.intervalMs)
        this.timer.unref?.()
      }
    } catch {
      this.drops++
    }
  }
  async forceFlush() {
    clearTimeout(this.timer)
    this.timer = null
    if (this.draining) return this.draining
    this.draining = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 128)
        const success = await new Promise((resolve) => {
          let settled = false
          const done = (value) => {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              resolve(value)
            }
          }
          const timer = setTimeout(() => done(false), this.timeoutMs)
          try {
            this.exporter.export(
              batch.map((item) => item.span),
              (result) => done(result.code === 0),
            )
          } catch {
            done(false)
          }
        })
        if (!success) this.drops += batch.length
        this.bytes -= batch.reduce((n, item) => n + item.bytes, 0)
        this.count -= batch.length
      }
    })()
      .catch(() => {
        this.drops += this.count
        this.queue = []
        this.count = 0
        this.bytes = 0
      })
      .finally(() => {
        this.draining = null
      })
    return this.draining
  }
  prepareShutdown() {
    this.closed = true
    clearTimeout(this.timer)
    // Shutdown is deliberately bounded to one remaining batch. Record unsent spans
    // as lost instead of draining a full outage queue for many timeout intervals.
    if (this.queue.length > 128) {
      const discarded = this.queue.splice(128)
      this.drops += discarded.length
      this.count -= discarded.length
      this.bytes -= discarded.reduce((n, item) => n + item.bytes, 0)
    }
  }
  async shutdown() {
    this.prepareShutdown()
    await this.forceFlush()
    try {
      await this.exporter.shutdown()
    } catch {}
  }
}
