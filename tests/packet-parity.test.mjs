// Packet parity for the ecosystem module split (issue #58): the public CLI and MCP output for a
// fixed synthetic self root and linked project must stay byte-identical after normalisation.
// Regenerate the golden only for an intended behaviour change: UPDATE_PARITY=1 npm test
// (or: UPDATE_PARITY=1 node --test tests/packet-parity.test.mjs). See tests/helpers/parity.mjs
// for the fixture, the case matrix and the documented list of normalised volatile fields.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parityRun } from './helpers/parity.mjs'

const golden = fileURLToPath(new URL('./fixtures/parity/golden.json', import.meta.url))
const serialise = value => JSON.stringify(value, null, 2) + '\n'

test('CLI and MCP output matches the packet parity golden', { timeout: 120000 }, async () => {
  const actual = serialise(await parityRun())
  if (process.env.UPDATE_PARITY === '1') {
    mkdirSync(join(golden, '..'), { recursive: true })
    writeFileSync(golden, actual)
    return
  }
  assert.ok(existsSync(golden), 'missing golden; run UPDATE_PARITY=1 node --test tests/packet-parity.test.mjs')
  const expected = readFileSync(golden, 'utf8').replaceAll('\r\n', '\n')
  assert.equal(actual, expected, 'packet parity drifted; regenerate with UPDATE_PARITY=1 only for an intended behaviour change')
})

test('packet parity output does not depend on the temporary path', { timeout: 120000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'holoself-parity-base-with-a-much-longer-name-'))
  try {
    const nested = join(base, 'nested-directory')
    mkdirSync(nested)
    const [first, second] = [serialise(await parityRun()), serialise(await parityRun({ baseDir: nested }))]
    assert.equal(second, first)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
