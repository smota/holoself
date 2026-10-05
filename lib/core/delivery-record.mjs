import { hasCurrentDigest, recordDigest } from './record-digest.mjs'

export function sealDeliveryRecord(type, payload) {
  const record = { ...payload, version: 1, type }
  return { ...record, digest: recordDigest(record) }
}

export function requireDeliveryRecord(record, type) {
  if (record?.version !== 1 || record.type !== type || !hasCurrentDigest(record)) {
    throw new Error(`Invalid or stale ${type} record`)
  }
  return record
}

export function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
}

export function requireDigest(value, name) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${name} must be a SHA-256 digest`)
  return value
}

export function requireUnique(values, name) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw new Error(`${name} must be a unique array`)
  }
  return values
}
