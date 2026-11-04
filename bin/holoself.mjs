#!/usr/bin/env node
import { run } from '../src/cli.mjs'
// Test-only hook (active only under node --test): HOLOSELF_TEST_FORCE_INTERNAL forces an uncaught TypeError to test 500 handling.
Promise.resolve()
  .then(() => {
    if (process.env.HOLOSELF_TEST_FORCE_INTERNAL && process.env.NODE_TEST_CONTEXT) throw new TypeError('forced internal failure')
    return run(process.argv.slice(2))
  })
  .catch(error => {
    if (process.env.HOLOSELF_ERROR_FORMAT === 'json') {
      const internal =
        error instanceof TypeError ||
        error instanceof ReferenceError ||
        error instanceof RangeError ||
        error instanceof SyntaxError ||
        error instanceof EvalError ||
        error?.errno !== undefined ||
        error?.syscall !== undefined
      console.error(
        JSON.stringify({
          holoself_error: {
            name: error?.name || 'Error',
            code: error?.code || null,
            message: String(error?.message ?? error),
            kind: internal ? 'internal' : 'refusal'
          }
        })
      )
    } else console.error(`[!!] ${error.message}`)
    process.exitCode = 1
  })
