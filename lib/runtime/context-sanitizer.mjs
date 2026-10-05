import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Normalizes file paths to POSIX format, stripping machine-specific local prefixes.
 */
export function normalizePathToPosix(filePath) {
  if (typeof filePath !== 'string') return ''
  let normalized = filePath.replace(/\\/g, '/')
  // Strip Windows drive letters (e.g., C:/Users/... -> /Users/...)
  normalized = normalized.replace(/^[a-zA-Z]:\//, '/')
  // Anonymize user home paths
  normalized = normalized.replace(/\/(Users|home)\/[^/]+\//g, '~//')
  normalized = normalized.replace(/\/\//g, '/')
  return normalized
}

/**
 * Secret and PII patterns for scrubbing before remote synchronization.
 */
const SECRET_PATTERNS = [
  // GitHub Tokens
  { regex: /gh[pousr]_[A-Za-z0-9_]{36,255}/g, replacement: '[REDACTED_GH_TOKEN]' },
  // OpenAI / LLM API Keys
  { regex: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_API_KEY]' },
  // AWS Access Keys
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  // Slack Tokens
  {
    regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,34}/g,
    replacement: '[REDACTED_SLACK_TOKEN]',
  },
  // Private Key Headers
  {
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // Bearer / Authorization headers
  { regex: /Bearer\s+[A-Za-z0-9\-_.]+/gi, replacement: 'Bearer [REDACTED_BEARER_TOKEN]' },
  // Local workstation absolute paths
  {
    regex: /[a-zA-Z]:\\(?:Users|home)\\[^\s"'<>]+/gi,
    replacement: (match) => normalizePathToPosix(match),
  },
  { regex: /\/(?:Users|home)\/[^\s"'<>]+/g, replacement: (match) => normalizePathToPosix(match) },
]

/**
 * Scrubs credentials, tokens, and local workstation paths from text.
 */
export function scrubSecretsAndPii(content) {
  if (typeof content !== 'string') return content
  let scrubbed = content
  for (const { regex, replacement } of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(regex, replacement)
  }
  return scrubbed
}

/**
 * Recursively scrubs objects, arrays, and strings.
 */
export function scrubObject(obj) {
  if (!obj || typeof obj !== 'object') {
    return typeof obj === 'string' ? scrubSecretsAndPii(obj) : obj
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => scrubObject(item))
  }
  const result = {}
  for (const [key, value] of Object.entries(obj)) {
    result[key] = scrubObject(value)
  }
  return result
}

/**
 * Detects and removes stale .git/index.lock files left by previous crashed processes.
 */
export function cleanupGitLocks({ repoDir = process.cwd() } = {}) {
  let gitDir = join(repoDir, '.git')
  if (existsSync(gitDir) && statSync(gitDir).isFile()) {
    const match = /^gitdir: (.+)\s*$/.exec(readFileSync(gitDir, 'utf8').trim())
    if (!match) return { cleaned: false, reason: 'unknown_gitdir' }
    gitDir = resolve(repoDir, match[1])
  }
  const lockPath = join(gitDir, 'index.lock')
  if (!existsSync(lockPath)) return { cleaned: false, reason: 'no_lock_found' }
  // Git index locks do not carry a verifiable owner. Age can never authorize deletion.
  return { cleaned: false, lockPath, reason: 'lock_owner_unverified' }
}

// A bounded envelope references complete bytes; never silently truncate executable data.
export function compressContextPayload(
  payload,
  { maxTokens = 15000, maxChars = 60000, externalize } = {},
) {
  const sanitized = typeof payload === 'string' ? scrubSecretsAndPii(payload) : scrubObject(payload)
  const serialized = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized, null, 2)
  const limit = Math.min(maxChars, maxTokens * 4)
  if (serialized.length <= limit)
    return {
      payload: sanitized,
      compressed: false,
      charCount: serialized.length,
      estimatedTokens: Math.ceil(serialized.length / 4),
    }
  if (typeof externalize !== 'function')
    throw new Error('Complete context artifact externalization required; truncation refused')
  const bytes = Buffer.from(serialized)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const artifact = externalize(bytes, { digest, byteLength: bytes.length })
  if (
    !artifact ||
    artifact.digest !== digest ||
    artifact.byteLength !== bytes.length ||
    !artifact.path
  )
    throw new Error('Verified complete context artifact reference required')
  const envelope = { version: 1, artifact }
  const size = JSON.stringify(envelope).length
  if (size > limit) throw new Error('Artifact envelope exceeds context budget')
  return {
    payload: envelope,
    compressed: true,
    charCount: size,
    estimatedTokens: Math.ceil(size / 4),
  }
}
