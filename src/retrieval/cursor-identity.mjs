// Per-root cursor secret and the caller identity id bound into pagination cursors.
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function getOrCreateCursorSecret(selfRoot) {
  const keyPath = join(selfRoot, '.holoself', 'runtime', '.cursor.key')
  try {
    if (existsSync(keyPath)) return readFileSync(keyPath)
  } catch {}
  if (!globalThis.__HOLOSELF_CURSOR_KEY__) globalThis.__HOLOSELF_CURSOR_KEY__ = randomBytes(32)
  return globalThis.__HOLOSELF_CURSOR_KEY__
}
export function getIdentityId(identity, cursorSecret) {
  const raw = `${identity.kind}:${identity.project || ''}:${[...(identity.allowedLenses || [])].sort().join(',')}`
  return createHmac('sha256', cursorSecret).update(raw).digest('hex').slice(0, 16)
}
