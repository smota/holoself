import { Resource } from '@opentelemetry/resources'
import { ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { normalizeObservation, metricLabels } from './events.mjs'
import { LocalSpoolExporter } from './local-buffer.mjs'
import { BoundedTraceProcessor } from './bounded-trace-processor.mjs'

export function createTelemetry({
  enabled = false,
  offline = false,
  serviceName = 'agentflow-sdlc',
  otlpEndpoint = null,
  maxQueueSize = 2048,
  spoolDir = undefined,
} = {}) {
  let tracerProvider = null
  let tracer = null
  let sessionSpan = null
  let sessionContext = ROOT_CONTEXT
  let spanProcessor = null
  let meterProvider = null
  let metricReader = null
  let meter = null

  const drops = { count: 0 }
  let localExporter = null

  if (enabled && (offline || otlpEndpoint)) {
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
    })

    let traceExporter
    let metricExporter
    if (offline) {
      localExporter = new LocalSpoolExporter(spoolDir ? { spoolDir } : {})
      traceExporter = localExporter
      metricExporter = localExporter
    } else {
      traceExporter = new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
        timeoutMillis: 500,
        concurrencyLimit: 1,
      })
      metricExporter = new OTLPMetricExporter({
        url: `${otlpEndpoint}/v1/metrics`,
        timeoutMillis: 500,
        concurrencyLimit: 1,
      })
    }

    spanProcessor = new BoundedTraceProcessor(traceExporter, { maxQueueSize })
    tracerProvider = new BasicTracerProvider({ resource })
    tracerProvider.addSpanProcessor(spanProcessor)
    tracer = tracerProvider.getTracer('agentflow-sdlc-tracer')
    sessionSpan = tracer.startSpan(
      'agentflow.session',
      { attributes: { schemaVersion: 1 } },
      ROOT_CONTEXT,
    )
    sessionContext = trace.setSpan(ROOT_CONTEXT, sessionSpan)

    metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60000,
      exportTimeoutMillis: 750,
    })
    meterProvider = new MeterProvider({ resource, readers: [metricReader] })
    meter = meterProvider.getMeter('agentflow-sdlc-meter')
  }

  const counters = enabled ? new Map() : null
  function getCounter(name) {
    if (!counters.has(name)) {
      counters.set(name, meter.createCounter(name))
    }
    return counters.get(name)
  }
  function getHistogram(name, unit = '1') {
    if (!counters.has(name)) {
      counters.set(name, meter.createHistogram(name, { unit }))
    }
    return counters.get(name)
  }

  const observer = (value) => {
    if (!tracer) return
    try {
      const event = normalizeObservation(value)
      if (!event) {
        drops.count++
        return
      }

      if (enabled && tracer) {
        const span = tracer.startSpan(event.kind, {}, sessionContext)
        const attributes = {}
        const metricAttributes = metricLabels(event)

        for (const [k, v] of Object.entries(event)) {
          if (v !== undefined && v !== null && typeof v !== 'object') {
            attributes[k] = v
          }
        }

        span.setAttributes(attributes)
        for (const key of ['runId', 'sessionId']) {
          if (event[key]) sessionSpan?.setAttribute(key, event[key])
        }
        span.end()

        if (event.kind) {
          getCounter(event.kind + '_count').add(1, metricAttributes)
          if (typeof event.duration === 'number') {
            getHistogram(event.kind + '_duration', 'ms').record(event.duration, metricAttributes)
          }
          if (typeof event.requestBytes === 'number') {
            getHistogram(event.kind + '_request_bytes', 'By').record(
              event.requestBytes,
              metricAttributes,
            )
          }
          if (typeof event.responseBytes === 'number') {
            getHistogram(event.kind + '_response_bytes', 'By').record(
              event.responseBytes,
              metricAttributes,
            )
          }
          for (const field of [
            'bytes',
            'repeatedBytes',
            'policyBytes',
            'files',
            'inputTokens',
            'outputTokens',
            'cachedInputTokens',
            'totalTokens',
            'astReductionRatio',
            'lyapunovIterations',
            'orphanProcessCount',
            'worktreeLockWaitMs',
          ]) {
            if (typeof event[field] === 'number') {
              const unit = /bytes/i.test(field) ? 'By' : /waitms/i.test(field) ? 'ms' : '1'
              getHistogram(`${event.kind}_${field}`, unit).record(event[field], metricAttributes)
            }
          }
        }
      }
    } catch (e) {
      drops.count++
    }
  }

  return {
    observer,
    getDrops: () => drops.count + (spanProcessor?.drops ?? 0),
    getReport: () => ({
      rejectedObservations: drops.count,
      droppedSpans: spanProcessor?.drops ?? 0,
      queuedPayloadBytes: spanProcessor?.bytes ?? 0,
      spoolDroppedRecords: localExporter?.drops ?? 0,
      spoolExpiredRecords: localExporter?.expired ?? 0,
      spoolEvictedRecords: localExporter?.evicted ?? 0,
      coverage: 'supported-boundaries-only',
    }),
    shutdown: async () => {
      let timeoutId
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), 2000)
      })
      const finish = async () => {
        sessionSpan?.end()
        sessionSpan = null
        spanProcessor?.prepareShutdown()
        // Both signals share the offline exporter. Flush both before either
        // provider closes it; metric shutdown alone does not collect final data.
        await Promise.allSettled([
          Promise.resolve().then(() => tracerProvider?.forceFlush()),
          Promise.resolve().then(() => metricReader?.forceFlush()),
        ])
        await Promise.allSettled([
          Promise.resolve().then(() => tracerProvider?.shutdown()),
          Promise.resolve().then(() => meterProvider?.shutdown()),
        ])
      }
      await Promise.race([finish(), timeout])

      clearTimeout(timeoutId)
    },
  }
}
