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
  if (actual === expected) return
  assert.fail(`packet parity drifted; regenerate with UPDATE_PARITY=1 only for an intended behaviour change\n${describeDrift(JSON.parse(expected), JSON.parse(actual))}`)
})

// Names each drifting case and shows its first differing lines, so CI logs are diagnosable.
function describeDrift(expected, actual, maxCases = 5, maxLines = 20) {
  const all = run => [...run.setup.map(c => ['setup', c]), ...run.cases.map(c => ['cases', c])]
  const want = all(expected), got = all(actual), report = []
  if (want.length !== got.length) report.push(`case count: expected ${want.length}, actual ${got.length}`)
  for (let i = 0; i < Math.max(want.length, got.length) && report.length < maxCases; i++) {
    const [group, e] = want[i] || ['', undefined], [, a] = got[i] || ['', undefined]
    const left = serialise(e ?? null).split('\n'), right = serialise(a ?? null).split('\n')
    if (left.join('\n') === right.join('\n')) continue
    const lines = []
    for (let j = 0; j < Math.max(left.length, right.length) && lines.length < maxLines; j++) {
      if (left[j] === right[j]) continue
      lines.push(`  line ${j + 1}:\n    - ${(left[j] ?? '<none>').slice(0, 200)}\n    + ${(right[j] ?? '<none>').slice(0, 200)}`)
    }
    report.push(`${group}[${i}] ${e?.name ?? a?.name} (expected ${serialise(e ?? null).length} chars, actual ${serialise(a ?? null).length})\n${lines.join('\n')}`)
  }
  return report.join('\n')
}

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
