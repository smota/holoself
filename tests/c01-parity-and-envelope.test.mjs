import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../src/cli.mjs'
import { createMcpSession } from '../src/mcp-server.mjs'

async function temp(prefix = 'holoself-c01-') {
  return mkdtemp(join(tmpdir(), prefix))
}

async function capture(fn) {
  const oldLog = console.log
  const oldErr = console.error
  let out = ''
  let err = ''
  console.log = (...x) => { out += x.join(' ') + '\n' }
  console.error = (...x) => { err += x.join(' ') + '\n' }
  try {
    await fn()
  } finally {
    console.log = oldLog
    console.error = oldErr
  }
  return { stdout: out, stderr: err }
}

async function setupC01Fixture() {
  const self = await temp('self-')
  const project = await temp('project-')
  await capture(() => run(['init', '--root', self]))

  // Add custom lens spiritual with base general
  const lensesDir = join(self, 'lenses')
  await mkdir(lensesDir, { recursive: true })
  await writeFile(
    join(lensesDir, 'spiritual.json'),
    JSON.stringify({
      schema_version: 1,
      id: 'spiritual',
      title: 'Spiritual perspective',
      base_lens: 'general',
      sensitivity_access: []
    }, null, 2)
  )

  // Add documents in self
  await writeFile(
    join(self, 'profile', 'identity.md'),
    '---\naccess_lenses: [general, career, spiritual, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Identity\n\nCanonical identity profile.\n'
  )
  await writeFile(
    join(self, 'context', 'secret-personal.md'),
    '---\naccess_lenses: [private]\ndisclosure: internal-only\nsensitivity: restricted\ndocument_role: content\n---\n# Secret personal notes\n\nStrictly private and restricted.\n'
  )

  // Link project with general lens only
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  return { self, project }
}

test('V-04 Parity: CLI and MCP both reject ungranted lens with LENS_NOT_GRANTED', async () => {
  const { self, project } = await setupC01Fixture()

  // MCP rejects private lens
  const mcpOutput = []
  const session = createMcpSession({ project, write: line => mcpOutput.push(JSON.parse(line)) })
  session(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
  session(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'holoself_context_manifest', arguments: { lens: 'private' } }
  }))
  const mcpRes = mcpOutput.find(x => x.id === 2)
  assert.equal(mcpRes.result.isError, true)
  assert.equal(mcpRes.result.structuredContent.error.code, 'LENS_NOT_GRANTED')

  // CLI must reject private lens on linked project with exit code nonzero and LENS_NOT_GRANTED
  let cliError = null
  try {
    await capture(() => run(['context', '--project', project, '--lens', 'private', '--json']))
  } catch (err) {
    cliError = err
  }
  assert.ok(cliError, 'CLI should fail when requesting ungranted lens on linked project')
  assert.equal(cliError.code, 'LENS_NOT_GRANTED')
})

test('V-04 Parity: Client cannot forge owner:direct via --self from linked project', async () => {
  const { self, project } = await setupC01Fixture()

  // Calling with --self pointing to self but --project pointing to linked project
  let cliError = null
  try {
    await capture(() => run(['context', '--project', project, '--self', self, '--lens', 'private', '--json']))
  } catch (err) {
    cliError = err
  }
  assert.ok(cliError, 'CLI should not allow bypassing link via --self')
  assert.equal(cliError.code, 'LENS_NOT_GRANTED')
})

test('V-04 Parity: External caller outside self cannot claim owner:direct without valid link', async () => {
  const { self } = await setupC01Fixture()
  const emptyDir = await temp('empty-')

  // Calling from emptyDir pointing to self without a link
  let cliError = null
  try {
    await capture(() => run(['context', '--project', emptyDir, '--self', self, '--lens', 'private', '--json']))
  } catch (err) {
    cliError = err
  }
  assert.ok(cliError, 'CLI should require a link when called for an unlinked external directory')
  assert.equal(cliError.code, 'LINK_REQUIRED')
})

test('V-04 Privacy: Denied sources do not leak paths in restrictions or warnings', async () => {
  const { self, project } = await setupC01Fixture()

  const { stdout } = await capture(() => run(['context', '--project', project, '--lens', 'general', '--budget', 'small', '--json']))
  const data = JSON.parse(stdout)

  // Should not contain secret-personal.md anywhere in restrictions or warnings
  const serialized = JSON.stringify({ restrictions: data.restrictions, warnings: data.warnings })
  assert.doesNotMatch(serialized, /secret-personal\.md/i)
  assert.doesNotMatch(serialized, /Secret personal notes/i)

  // client:linked projection: absolute self path should not be exposed
  assert.doesNotMatch(JSON.stringify(data.self), new RegExp(self.replaceAll('\\', '\\\\'), 'i'))
})

test('V-05 Custom lens with base general does not fail validation on contribs', async () => {
  const { self } = await setupC01Fixture()
  const projSpiritual = await temp('proj-spiritual-')

  // Link project with spiritual lens
  await capture(() => run(['link', 'add', '--project', projSpiritual, '--self', self, '--lens', 'spiritual', '--no-activate', '--yes']))

  // Running context with task should not throw "context leakage validation failed"
  const { stdout } = await capture(() => run(['context', '--project', projSpiritual, '--task', 'reflect on leadership', '--budget', 'small', '--json']))
  const data = JSON.parse(stdout)
  assert.ok(data.sources.length >= 1)
  assert.equal(data.lens, 'spiritual')
})
