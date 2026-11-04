// Worker-thread entry for MCP tool calls (see src/mcp-pool.mjs). It runs the same synchronous core as the CLI and
// posts back either the serialised tool result or a code/message pair; the main thread owns stdout and auditing.
import { parentPort, workerData } from 'node:worker_threads'

// Without an on-disk .cursor.key, cursors are signed with a per-process in-memory key. Every worker shares the
// server's key so a cursor issued by one worker validates in another.
if (workerData?.cursorKey && !globalThis.__HOLOSELF_CURSOR_KEY__) globalThis.__HOLOSELF_CURSOR_KEY__ = Buffer.from(workerData.cursorKey)

const { executeToolJob } = await import('./mcp-server.mjs')
// Test seam: synchronous busy time per tool name, set only through createToolPool({ workerData }) in tests.
const simulateWorkMs = workerData?.simulateWorkMs || {}

parentPort.on('message', ({ jobId, project, name, args }) => {
  const busy = simulateWorkMs[name]
  if (busy > 0) {
    const end = Date.now() + busy
    while (Date.now() < end);
  }
  parentPort.postMessage({ jobId, ...executeToolJob(project, name, args) })
})
