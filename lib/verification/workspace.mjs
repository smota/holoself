import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { createCandidateIdentity } from '../core/verification-observation.mjs'
import { emitObservation } from '../observability/observer.mjs'

export function containedPath(root, path, { allowMissing = false } = {}) {
  const base = resolve(root)
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel))
    throw new Error('Path must stay inside project')
  let current = base
  for (const part of ['', ...rel.split(sep)]) {
    current = part ? resolve(current, part) : current
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) throw new Error('Symlink or junction path is not permitted')
  }
  return target
}

export function fingerprintCandidate(root, definition, { observer } = {}) {
  if (!Array.isArray(definition.inputs) || !definition.inputs.length)
    throw new Error('Explicit candidate inputs are required')
  const inputs = {}
  for (const path of definition.inputs) {
    if (typeof path !== 'string' || path.replaceAll('\\', '/').split('/').includes('.git'))
      throw new Error('Invalid candidate input')
    const target = containedPath(root, path)
    if (!lstatSync(target).isFile()) throw new Error('Candidate input must be a regular file')
    const key = relative(resolve(root), target).replaceAll('\\', '/')
    if (Object.hasOwn(inputs, key)) throw new Error('Duplicate candidate input')
    const bytes = readFileSync(target)
    emitObservation(observer, {
      kind: 'file_read',
      bytes: bytes.length,
      files: 1,
      purpose: 'candidate',
    })
    inputs[key] = createHash('sha256').update(bytes).digest('hex')
  }
  return createCandidateIdentity({ inputs, context: definition.context ?? {} })
}

export function computeOracleDigest({ dir = 'tests/oracles', packageRoot = process.cwd() } = {}) {
  const targetDir = resolve(packageRoot, dir)
  try {
    const stat = lstatSync(targetDir)
    if (!stat.isDirectory()) return null
  } catch {
    return null
  }
  const files = []
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('Symlinks not permitted in oracle directory')
      }
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  walk(targetDir)
  if (!files.length) return null
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    const rel = relative(targetDir, file).replaceAll('\\', '/')
    const bytes = readFileSync(file)
    hash.update(`${rel}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}
