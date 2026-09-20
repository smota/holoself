import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFixture } from './helpers/c00-fixture.mjs'
import { installIoMeter } from './helpers/c00-io.mjs'

let fixture
before(async () => { fixture = await createFixture({ count: 100 }) })
after(async () => { await fixture.cleanup() })

test('C00 fixture is reproducible and isolated', async () => {
  const other = await createFixture({ count: 100 })
  try {
    assert.notEqual(fixture.root, other.root)
    assert.equal(fixture.sourceDigest, other.sourceDigest)
    assert.equal(fixture.qualityCases.length, 36)
    assert.equal(fixture.qualityDigest, '47e5812f687d535418eb00d4f09e2138bf5281ef30272e9c7aba5c9eb7c14c81')
    assert.ok(fixture.project.startsWith(fixture.root))
    assert.ok(fixture.peer.startsWith(fixture.root))
    assert.match(await fsp.readFile(join(fixture.peer, 'C00-PEER-EXCLUSIVE.md'), 'utf8'), /C00_PEER_EXCLUSIVE/)
  } finally { await other.cleanup() }
})

test('C00 fixture cleanup refuses a replaced root', async () => {
  const victim = await createFixture({ count: 0 })
  const moved = `${victim.root}-moved`
  await fsp.rename(victim.root, moved)
  await fsp.symlink(moved, victim.root, 'junction')
  try {
    await assert.rejects(victim.cleanup(), /replaced|unsafe/i)
  } finally {
    await fsp.unlink(victim.root)
    await fsp.rename(moved, victim.root)
    await victim.cleanup()
  }
})

for (const expected of [
  ['pt', 'personal'], ['pt', 'mechanical'], ['pt', 'ambiguous'],
  ['en', 'personal'], ['en', 'mechanical'], ['en', 'ambiguous']
]) {
  for (let variant = 1; variant <= 6; variant += 1) test(`quality ${expected[0]} ${expected[1]} ${variant}`, async () => {
    const item = fixture.qualityCases.find(candidate => candidate.id === `q-${expected[0]}-${expected[1]}-${variant}`)
    assert.ok(item)
    assert.equal(item.budget, 'deep')
    assert.equal(item.requiredMarkers.length, expected[1] === 'mechanical' ? 0 : 1)
    if (expected[1] === 'mechanical') assert.deepEqual(item.expectedNeed, ['not-needed'])
    if (expected[1] === 'personal') assert.deepEqual(item.expectedNeed, ['required'])
    if (expected[1] === 'ambiguous') assert.deepEqual(item.expectedNeed, ['helpful', 'required'])
    const source = await fsp.readFile(item.sourcePath, 'utf8')
    const restricted = await fsp.readFile(fixture.restrictedQualityPath, 'utf8')
    for (const marker of item.requiredMarkers) assert.match(source, new RegExp(marker))
    for (const marker of item.optionalMarkers) assert.match(source, new RegExp(marker))
    for (const marker of item.forbiddenMarkers) { assert.doesNotMatch(source, new RegExp(marker)); assert.match(restricted, new RegExp(marker)) }
    assert.ok(item.task.length > 12)
  })
}

test('IO meter calibrates sync, callback, promise, stream, metadata, and Unicode bytes', async () => {
  const path = join(fixture.self, 'context', 'c00-unicode-ação-世界.md')
  const unicode = 'ação 世界\n'
  await fsp.writeFile(path, unicode)
  const expectedBytes = Buffer.byteLength(unicode)
  assert.notEqual(expectedBytes, unicode.length)
  const meter = installIoMeter({ roots: { self: fixture.self, project: fixture.project, peer: fixture.peer }, syntheticPaths: [...fixture.syntheticPaths, path] })
  meter.start()
  try {
    fs.readFileSync(path)
    await new Promise((resolve, reject) => fs.readFile(path, (error, value) => error ? reject(error) : resolve(value)))
    await fsp.readFile(path)
    await new Promise((resolve, reject) => { const stream = fs.createReadStream(path); stream.on('error', reject); stream.on('end', resolve); stream.resume() })
    fs.statSync(path)
    await fsp.stat(path)
    const result = meter.stop()
    assert.equal(result.bodyReads, 4)
    assert.equal(result.bodyBytes, expectedBytes * 4)
    assert.equal(result.syntheticReads, 4)
    assert.equal(result.syntheticBytes, expectedBytes * 4)
    assert.equal(result.uniqueBodyFiles, 1)
    assert.equal(result.metadataOps, 2)
    assert.equal(result.byApi.readFileSync, 1)
    assert.equal(result.byApi.readFile, 1)
    assert.equal(result.byApi.readFilePromise, 1)
    assert.equal(result.byApi.createReadStream, 1)
    assert.equal(result.unsupported.length, 0)
  } finally { meter.restore(); await fsp.rm(path, { force: true }) }
})

test('IO meter reports unsupported raw fd reads and restores after errors', async () => {
  const path = fixture.syntheticPaths[0]
  const meter = installIoMeter({ roots: { self: fixture.self }, syntheticPaths: fixture.syntheticPaths })
  meter.start()
  try {
    const fd = fs.openSync(path, 'r')
    try { const buffer = Buffer.alloc(2); fs.readSync(fd, buffer, 0, 2, 0) } finally { fs.closeSync(fd) }
    assert.throws(() => fs.readFileSync(join(fixture.self, 'missing.md')), /ENOENT/)
    const result = meter.stop()
    assert.ok(result.unsupported.some(item => item.api === 'openSync' || item.api === 'readSync'))
    assert.equal(result.bodyReads, 0)
  } finally { meter.restore() }
  const original = fs.readFileSync
  const check = installIoMeter({ roots: { self: fixture.self } })
  check.start(); check.restore()
  assert.equal(fs.readFileSync, original)
})

test('IO meter marks numeric descriptors and handles opened before start as unsupported', async () => {
  const path = fixture.syntheticPaths[0]
  const preopened = await fsp.open(path, 'r')
  const meter = installIoMeter({ roots: { self: fixture.self }, syntheticPaths: fixture.syntheticPaths })
  meter.start()
  try {
    await assert.rejects(fsp.readFile(preopened.fd), /ERR_INVALID_ARG_TYPE/)
    await preopened.read(Buffer.alloc(1), 0, 1, 0)
    const result = meter.stop()
    assert.ok(result.unsupported.some(item => item.api === 'readFilePromise'))
    assert.ok(result.unsupported.some(item => item.api === 'FileHandle.read'))
    assert.equal(result.bodyReads, 0)
  } finally {
    await preopened.close()
    meter.restore()
  }
})

test('IO meter accepts file URLs, counts failed metadata, and does not auto-flow streams', async () => {
  const path = fixture.syntheticPaths[0]
  const meter = installIoMeter({ roots: { self: fixture.self }, syntheticPaths: fixture.syntheticPaths })
  meter.start()
  try {
    const stream = fs.createReadStream(pathToFileURL(path))
    assert.equal(stream.readableFlowing, null)
    stream.resume()
    await new Promise((resolve, reject) => { stream.once('error', reject); stream.once('end', resolve) })
    assert.throws(() => fs.statSync(join(fixture.self, 'missing.md')), /ENOENT/)
    const result = meter.stop()
    assert.equal(result.bodyReads, 1)
    assert.equal(result.metadataOps, 1)
    assert.equal(result.byApi.statSync, 1)
  } finally { meter.restore() }
})

test('IO meter detects raw reads made concurrently and from stream consumers', async () => {
  const path = fixture.syntheticPaths[0]
  const rawFd = fs.openSync(path, 'r')
  const meter = installIoMeter({ roots: { self: fixture.self }, syntheticPaths: fixture.syntheticPaths })
  meter.start()
  try {
    const pending = fsp.readFile(path)
    fs.readSync(rawFd, Buffer.alloc(1), 0, 1, 0)
    await pending
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(path)
      let read = false
      stream.on('data', () => {
        if (!read) { read = true; fs.readSync(rawFd, Buffer.alloc(1), 0, 1, 0) }
      })
      stream.once('error', reject)
      stream.once('end', resolve)
    })
    const result = meter.stop()
    assert.equal(result.unsupported.filter(item => item.api === 'readSync').length, 2)
  } finally {
    fs.closeSync(rawFd)
    meter.restore()
  }
})
