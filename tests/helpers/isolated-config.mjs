// Side-effect import for every test that links a project: link setup/add/repair/approve register the self in the
// per-user self map (selves.json). scripts/run-tests.mjs already points HOLOSELF_CONFIG_DIR at the run directory; this
// keeps a test file run directly (`node --test tests/x.test.mjs`) away from the developer's real configuration too.
// Child processes spawned with the inherited environment use the same temporary directory.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.HOLOSELF_CONFIG_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'holoself-test-config-'))
  process.env.HOLOSELF_CONFIG_DIR = dir
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}
