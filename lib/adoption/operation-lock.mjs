import { hostname } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync, existsSync, linkSync } from 'node:fs'
import { containedPath } from '../verification/workspace.mjs'

export function withAdoptionLock(root, operation, { recovery = false, fault = () => {} } = {}) {
  const path = containedPath(root, '.agentflow-adoption.lock', { allowMissing: true })
  if (existsSync(path) && recovery) {
    const previous = readFileSync(path, 'utf8')
    const stopped = (raw) => {
      const owner = JSON.parse(raw)
      if (owner.host !== hostname() || !Number.isInteger(owner.pid) || !owner.instance)
        throw new Error('Prior adoption writer cannot be resolved on this host')
      try {
        process.kill(owner.pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return
        throw error
      }
      throw new Error('Prior adoption writer is still present')
    }
    stopped(previous)
    // Each dead claimant gets a new immutable claim slot. Never delete and reuse a
    // claim another contender may have inspected; that would introduce an ABA race.
    let key = previous,
      guardPath,
      claimed = false,
      reclaimed = false
    const abandonedClaims = []
    const staging = containedPath(root, `.agentflow-recovery-${randomUUID()}.tmp`, {
      allowMissing: true,
    })
    writeFileSync(
      staging,
      JSON.stringify({ host: hostname(), pid: process.pid, instance: randomUUID() }),
      { flag: 'wx', mode: 0o600, flush: true },
    )
    try {
      for (let depth = 0; depth < 64; depth++) {
        const digest = createHash('sha256').update(key).digest('hex')
        guardPath = containedPath(root, `.agentflow-recovery-${digest}.lock`, {
          allowMissing: true,
        })
        try {
          linkSync(staging, guardPath)
          claimed = true
          break
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          const priorClaim = readFileSync(guardPath, 'utf8')
          stopped(priorClaim)
          abandonedClaims.push(guardPath)
          key += priorClaim
        }
      }
      if (!claimed) throw new Error('Recovery claim chain exhausted; inspection required')
      fault('recovery.claimed')
      if (readFileSync(path, 'utf8') !== previous)
        throw new Error('Adoption writer changed; replan recovery')
      const previousStage = JSON.parse(previous).staging
      if (previousStage && /^\.agentflow-writer-[a-f0-9-]{36}\.tmp$/.test(previousStage)) {
        const stagedPath = containedPath(root, previousStage, { allowMissing: true })
        if (existsSync(stagedPath) && readFileSync(stagedPath, 'utf8') === previous)
          unlinkSync(stagedPath)
      }
      unlinkSync(containedPath(root, path))
      reclaimed = true
    } finally {
      unlinkSync(staging)
      if (claimed) unlinkSync(guardPath)
      if (reclaimed) for (const abandoned of abandonedClaims) unlinkSync(abandoned)
    }
  }
  const stagingName = `.agentflow-writer-${randomUUID()}.tmp`
  const staging = containedPath(root, stagingName, {
    allowMissing: true,
  })
  let acquired = false
  try {
    writeFileSync(
      staging,
      JSON.stringify({
        host: hostname(),
        pid: process.pid,
        instance: randomUUID(),
        startedAt: new Date().toISOString(),
        staging: stagingName,
      }),
      { flag: 'wx', mode: 0o600, flush: true },
    )
    fault('writer.before-publication')
    linkSync(staging, path)
    acquired = true
    unlinkSync(staging)
    return operation()
  } finally {
    if (existsSync(staging)) unlinkSync(staging)
    if (acquired) unlinkSync(containedPath(root, path))
  }
}
