import { createHash } from 'node:crypto'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function recordDigest(record) {
  const { digest, ...payload } = record ?? {}
  return createHash('sha256').update(stableJson(payload)).digest('hex')
}

export function hasCurrentDigest(record) {
  return /^[a-f0-9]{64}$/.test(record?.digest ?? '') && recordDigest(record) === record.digest
}
