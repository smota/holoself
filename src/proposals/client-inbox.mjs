// Client proposal inbox (<self>/proposals/inbox/): pending append-only proposals from unlinked MCP clients whose
// owner enabled `proposals: inbox`. Records carry `origin: { kind: client, client_id }` and provenance
// `client:<client_id>`; they are approved only by the owner through the CLI or Workbench.
import { randomUUID } from 'node:crypto'
import { closeSync, constants as fsConstants, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { isPidAlive } from '../link/registry.mjs'
import { SECRET_RE } from '../policy/secrets.mjs'
import { ensureDir, hash, sleepSync } from '../shared/fs.mjs'
import { INBOX_EVIDENCE_MAX, findProposal, inboxDir, planProposalChanges, saveProposal, scanProposalStore, validateProposal } from './store.mjs'
import { join } from 'node:path'

export const CLIENT_INBOX_LIMIT = 50

function clientInboxError(message, code) {
  return Object.assign(new Error(message), { code })
}
export const CLIENT_INBOX_LOCK_STALE_MS = 10000
export function clientInboxLockPath(self) {
  return join(self, '.holoself', 'client-inbox.lock')
}
function sameStaleLock(raw, held, staleRaw) {
  if (held) {
    try {
      const current = JSON.parse(raw)
      return current.pid === held.pid && current.timestamp === held.timestamp
    } catch {
      return false
    }
  }
  return staleRaw !== null && raw === staleRaw
}
function breakStaleLock(lockPath, held, staleRaw) {
  const breakGuard = `${lockPath}.break`
  try {
    closeSync(openSync(breakGuard, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600))
  } catch (error) {
    if (error.code === 'EEXIST') {
      const info = lstatSync(breakGuard, { throwIfNoEntry: false })
      if (info && Date.now() - info.mtimeMs > 2000) rmSync(breakGuard, { force: true })
    }
    return
  }
  const tempPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
  try {
    if (!sameStaleLock(readFileSync(lockPath, 'utf8'), held, staleRaw)) return
    renameSync(lockPath, tempPath)
    if (!sameStaleLock(readFileSync(tempPath, 'utf8'), held, staleRaw)) {
      try {
        renameSync(tempPath, lockPath)
      } catch {}
      return
    }
    rmSync(tempPath, { force: true })
  } catch {
  } finally {
    rmSync(tempPath, { force: true })
    rmSync(breakGuard, { force: true })
  }
}
// Synchronous exclusive lock for the cap check and the write (tool calls run synchronously on a worker thread, and
// several server processes may serve clients of one self root). A lock older than the stale limit or held by a dead
// process is broken safely via rename+verify; a symlinked lock path is refused.
export function withClientInboxLock(self, fn, { timeoutMs = 15000 } = {}) {
  const lockPath = clientInboxLockPath(self)
  ensureDir(join(self, '.holoself'))
  const deadline = Date.now() + timeoutMs
  let ourToken = null
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600)
      try {
        ourToken = JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: randomUUID() }) + '\n'
        writeSync(fd, ourToken)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const info = lstatSync(lockPath, { throwIfNoEntry: false })
      if (info?.isSymbolicLink()) throw clientInboxError('client inbox lock is a symlink; refusing', 'CLIENT_INBOX_LOCK_UNSAFE')
      let stale = false,
        held = null,
        staleRaw = null
      try {
        staleRaw = readFileSync(lockPath, 'utf8')
        const parsed = JSON.parse(staleRaw)
        held = { pid: parsed.pid, timestamp: parsed.timestamp }
        stale = Date.now() - Number(held.timestamp || 0) > CLIENT_INBOX_LOCK_STALE_MS || (Number.isInteger(held.pid) && !isPidAlive(held.pid))
      } catch {
        stale = info ? Date.now() - info.mtimeMs > 2000 : false
      }
      if (stale) {
        breakStaleLock(lockPath, held, staleRaw)
        continue
      }
      if (Date.now() > deadline) throw clientInboxError('timed out waiting for the client inbox lock', 'CLIENT_INBOX_LOCK_TIMEOUT')
      sleepSync(Math.min(50, 5 + attempt * 5))
    }
  }
  try {
    return fn()
  } finally {
    try {
      if (ourToken && readFileSync(lockPath, 'utf8') === ourToken) rmSync(lockPath, { force: true })
    } catch {}
  }
}
export function listInboxProposals(self) {
  return scanProposalStore(null, { inboxSelf: self }).managed
}
export function scanInbox(self) {
  return scanProposalStore(null, { inboxSelf: self })
}
export function findInboxProposal(self, id) {
  return findProposal(null, id, { inboxSelf: self })
}
export function pendingInboxCount(self, clientId) {
  return listInboxProposals(self).filter(p => p.status === 'pending' && p.origin?.client_id === clientId).length
}
// Creates one pending append_claim proposal. The caller (the MCP facade) has already checked that the target is an
// existing document the client's lens can read; `view` narrows duplicate checks to what that lens delivers.
export function createInboxProposal(self, client, input, { view = null } = {}) {
  const evidence = typeof input.evidence === 'string' ? input.evidence : ''
  if (!evidence.trim()) throw clientInboxError('client proposals require evidence text (1-4,000 characters)', 'EVIDENCE_REQUIRED')
  if (evidence.length > INBOX_EVIDENCE_MAX) throw clientInboxError(`evidence is longer than ${INBOX_EVIDENCE_MAX} characters`, 'INVALID_ARGUMENT')
  if (typeof input.claim !== 'string' || !input.claim.trim()) throw clientInboxError('client proposals require claim text', 'INVALID_ARGUMENT')
  if ([input.claim, evidence, input.confidence].some(text => typeof text === 'string' && SECRET_RE.test(text)))
    throw clientInboxError('proposal text looks like a secret or credential and was rejected', 'SECRET_REJECTED')
  const p = {
    schema_version: 2,
    proposal_id: randomUUID(),
    title: `Review context proposed by client ${client.name}`,
    origin: { kind: 'client', client_id: client.client_id },
    status: 'pending',
    created_at: new Date().toISOString(),
    provenance: [`client:${client.client_id}`],
    changes: [
      {
        change_id: 'claim',
        target: input.target,
        operation: 'append_claim',
        proposal_type: input.proposal_type || 'new_fact',
        claim: input.claim,
        evidence,
        confidence: input.confidence || 'unverified',
        visibility: input.visibility || 'private'
      }
    ]
  }
  Object.defineProperty(p, '_inbox', { value: true, enumerable: false })
  const errors = validateProposal(p, { inbox: true })
  if (errors.length) throw clientInboxError(errors.join('; '), 'INVALID_ARGUMENT')
  planProposalChanges(p, self, view)
  // The cap check and the write happen under one lock, so concurrent creates can never exceed the cap.
  return withClientInboxLock(self, () => {
    if (pendingInboxCount(self, client.client_id) >= CLIENT_INBOX_LIMIT)
      throw clientInboxError(`client inbox is full (${CLIENT_INBOX_LIMIT} pending proposals); ask the owner to review it`, 'CLIENT_INBOX_FULL')
    const dir = inboxDir(self)
    ensureDir(dir)
    saveProposal(p, join(dir, `${p.proposal_id}.yaml`))
    return p
  })
}
export function inboxPreviewData(self, id, { view = null } = {}) {
  const p = findInboxProposal(self, id)
  if (p.status !== 'pending') throw new Error(`proposal is ${p.status}, expected pending`)
  const { grouped, previews, steps, commit_time_token } = planProposalChanges(p, self, view)
  return { proposal: p, grouped, steps, commit_time_token, changes: previews, preview_hash: hash(JSON.stringify(previews)) }
}
