// Issue #43: `holoself link remove --dry-run` must leave the project and the sovereign self byte-for-byte unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { canonicalSpaceId } from '../src/link/registry.mjs'

async function capture(fn) {
  const old = console.log
  let out = ''
  console.log = (...x) => {
    out += x.join(' ') + '\n'
  }
  try {
    await fn()
  } finally {
    console.log = old
  }
  return out
}

// Every path under dir (files, directories, symlinks) with file contents and link targets.
async function snapshot(dir) {
  const out = {}
  async function walk(rel) {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name
      const abs = join(dir, r)
      if (entry.isSymbolicLink()) out[r] = `link:${await readlink(abs)}`
      else if (entry.isDirectory()) {
        out[r] = 'dir'
        await walk(r)
      } else out[r] = (await readFile(abs)).toString('base64')
    }
  }
  await walk('')
  return out
}

async function linkedFixture(t) {
  const self = await mkdtemp(join(tmpdir(), 'holoself-rmdry-self-'))
  const project = await mkdtemp(join(tmpdir(), 'holoself-rmdry-proj-'))
  t.after(() => Promise.all([rm(self, { recursive: true, force: true }), rm(project, { recursive: true, force: true })]))
  await capture(() => run(['init', '--root', self]))
  await writeFile(join(project, 'README.md'), '# Synthetic project\n')
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--yes']))
  return { self, project }
}

async function registryStatus(self, project) {
  const reg = JSON.parse(await readFile(join(self, '.holoself', 'links.json'), 'utf8'))
  const links = Array.isArray(reg) ? reg : reg.links
  return links.find(l => l.project_id === canonicalSpaceId(project))?.status
}

test('link remove --dry-run --yes leaves project and self unchanged (#43)', async t => {
  const { self, project } = await linkedFixture(t)
  assert.equal(await registryStatus(self, project), 'active')
  const before = { self: await snapshot(self), project: await snapshot(project) }
  const out = await capture(() => run(['link', 'remove', '--project', project, '--dry-run', '--yes']))
  assert.deepEqual({ self: await snapshot(self), project: await snapshot(project) }, before)
  assert.equal(await registryStatus(self, project), 'active')
  assert.doesNotMatch(out, /\[ok\] removed/)
  assert.match(out, /\[dry-run\] would revoke sovereign link for /)
  assert.match(out, /\[dry-run\] would remove .*link\.yaml/)
})

test('link remove --dry-run with no link.yaml does not revoke the registry entry (#43)', async t => {
  const { self, project } = await linkedFixture(t)
  await rm(join(project, '.holoself', 'link.yaml'))
  const before = { self: await snapshot(self), project: await snapshot(project) }
  const out = await capture(() => run(['link', 'remove', '--project', project, '--self', self, '--dry-run']))
  assert.deepEqual({ self: await snapshot(self), project: await snapshot(project) }, before)
  assert.equal(await registryStatus(self, project), 'active')
  assert.match(out, /\[dry-run\] would revoke sovereign link for /)
})

test('link remove without --dry-run revokes the registry entry and removes link.yaml', async t => {
  const { self, project } = await linkedFixture(t)
  const out = await capture(() => run(['link', 'remove', '--project', project, '--yes']))
  assert.match(out, /\[ok\] removed /)
  assert.equal(await registryStatus(self, project), 'revoked')
  await assert.rejects(access(join(project, '.holoself', 'link.yaml')))
})

test('link remove with no link.yaml still revokes the registry entry when --self is given', async t => {
  const { self, project } = await linkedFixture(t)
  await rm(join(project, '.holoself', 'link.yaml'))
  await capture(() => run(['link', 'remove', '--project', project, '--self', self]))
  assert.equal(await registryStatus(self, project), 'revoked')
})
