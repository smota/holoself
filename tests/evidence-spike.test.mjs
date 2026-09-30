import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { inventory } from './fixtures/evidence/golden.mjs'
import { realisticDocx, syntheticZip } from './fixtures/evidence/build-realistic.mjs'
import { archiveNameError, compare, scanDocx } from '../scripts/evidence-spike.mjs'

const fixture = new URL('./fixtures/evidence/', import.meta.url)
const dependencies = existsSync(new URL('./fixtures/evidence/spike/node_modules/yauzl/package.json', import.meta.url))

test('D01 committed deflate variants have fixed identities and distinct property coverage', () => {
  for (const [name, digest] of [['complex-deflate.docx','ac207002c646be66722c01307580c8ba9d4812392a70b52f78ce9579d525cfe5'],['complex-deflate-props.docx','495a2c6eb4d3bbf81e2027f5f7d2c9fae57bcf79cfa36c378bb6b9d1f994f153']]) {
    const committed = readFileSync(new URL(name, fixture))
    assert.equal(createHash('sha256').update(committed).digest('hex'), digest)
    assert.ok(committed.length > 1000 && committed.length < 10000)
    let central = committed.indexOf(Buffer.from('504b0102', 'hex')), checked = 0
    while (central >= 0 && committed.readUInt32LE(central) === 0x02014b50) {
      const local = committed.readUInt32LE(central + 42)
      assert.equal(committed.readUInt32LE(local), 0x04034b50)
      assert.equal(committed.readUInt16LE(local + 6), committed.readUInt16LE(central + 8), 'local/central flags agree')
      assert.equal(committed.readUInt16LE(local + 8), committed.readUInt16LE(central + 10), 'local/central method agree')
      assert.equal(committed.readUInt16LE(local + 8), 8, 'DEFLATE method in both headers')
      checked++
      central += 46 + committed.readUInt16LE(central + 28) + committed.readUInt16LE(central + 30) + committed.readUInt16LE(central + 32)
    }
    assert.equal(checked, name.includes('props') ? 11 : 9)
  }
  assert.notDeepEqual(realisticDocx(), realisticDocx({ properties: true }))
})
test('D01 scorer names each missing authored unit rather than treating accounting as fidelity', () => {
  const scored = compare(inventory.docx, inventory.docx.map(([id]) => id).filter(id => id !== 'comment'))
  assert.deepEqual(scored, { found: 15, total: 16, missing: ['comment'] })
})
test('D01 rejects unsafe member names before materializing them', () => {
  for (const name of ['../evil.xml','a/../evil.xml','/absolute.xml','C:/drive.xml','a\\evil.xml','a//evil.xml']) assert.equal(archiveNameError(name), 'unsafe-name')
  assert.equal(archiveNameError('word/document.xml'), null)
})
test('D01 streamed ZIP accounting rejects bounded faults', { skip: !dependencies && 'spike-only npm ci not run' }, async () => {
  const bytes = readFileSync(new URL('complex-deflate-props.docx', fixture))
  const result = await scanDocx(bytes)
  assert.equal(result.entries, 11)
  assert.equal(result.expanded, 7096)
  assert.deepEqual(result.methods, [8])
  assert.ok(result.parts.has('docProps/core.xml'))
  assert.equal(result.parts.get('word/document.xml').includes(Buffer.from('Participant A')), true)
  await assert.rejects(scanDocx(bytes, { input: 100, expanded: 1000, entries: 20 }), /input-limit/)
  await assert.rejects(scanDocx(bytes, { input: 10000, expanded: 100, entries: 20 }), /expanded-limit/)
  await assert.rejects(scanDocx(bytes, { input: 10000, expanded: 10000, entries: 2 }), /entry-limit/)
  await assert.rejects(scanDocx(syntheticZip([['../evil.xml', Buffer.from('x')]])), /invalid relative path|unsafe-name/)
  await assert.rejects(scanDocx(syntheticZip([['word/vbaProject.bin', Buffer.from('x')]])), /macro-entry/)
})
