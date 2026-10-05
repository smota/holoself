import { pathMatches, safePath } from '../core/delegation-grant.mjs'
import { scrubSecretsAndPii } from '../runtime/context-sanitizer.mjs'

export const SOURCE_EVIDENCE_DISCLOSURE = 'bounded-output-and-artifacts'

const absolutePrivatePath =
  /(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/(?:Users|home|root|private|tmp|var\/tmp|etc)\/)[^\s"'<>]*/i
const absolutePosixPath = /(?:^|[\s"'=(:,])\/(?!\/)[^\s"'<>/][^\s"'<>]*/
const privateArtifactPath =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:$|\/)/i

function operationPaths(operation) {
  if (
    operation?.action !== 'edit' ||
    !Array.isArray(operation.paths) ||
    operation.paths.length === 0
  )
    throw new Error('Scoped edit operation paths required')
  if (operation.paths.some((path) => !safePath(path))) throw new Error('Unsafe edit operation path')
  return operation.paths
}

export function assertEngineeringEvidenceDisclosure(config, operation) {
  const paths = operationPaths(operation)
  const provider = config?.delivery?.engineeringProvider
  if (provider?.sourceEvidenceDisclosure !== SOURCE_EVIDENCE_DISCLOSURE)
    throw new Error(
      'Explicit bounded engineering source-evidence disclosure required before dispatch',
    )
  const source = config?.delivery?.source
  if (source?.kind !== 'github' || typeof source.repo !== 'string' || !source.repo)
    throw new Error('Disclosure must identify the configured durable GitHub source')
  if (operation.repository !== source.repo)
    throw new Error('Engineering evidence source does not match admitted repository')
  const expected = operation.arguments?.expectedArtifacts
  if (
    expected !== undefined &&
    (!Array.isArray(expected) ||
      expected.some(
        (path) =>
          !safePath(path) ||
          privateArtifactPath.test(path) ||
          !paths.some((pattern) => pathMatches(path, [pattern])),
      ))
  )
    throw new Error(
      'Expected engineering artifacts must stay within admitted paths and exclude private files',
    )
  return true
}

function inspectString(value) {
  if (
    scrubSecretsAndPii(value) !== value ||
    absolutePrivatePath.test(value) ||
    absolutePosixPath.test(value)
  )
    throw new Error('Engineering evidence contains a secret or private absolute path')
}

function inspectValue(value, seen = new Set()) {
  if (typeof value === 'string') {
    inspectString(value)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) inspectValue(item, seen)
  } else {
    for (const [key, item] of Object.entries(value)) {
      inspectString(key)
      if (key === 'path' && typeof item === 'string' && privateArtifactPath.test(item))
        throw new Error('Private engineering artifact path cannot be published')
      if (key === 'contentBase64' && typeof item === 'string') {
        const canonical = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          item,
        )
        if (!canonical) throw new Error('Engineering artifact base64 is not canonical')
        const bytes = Buffer.from(item, 'base64')
        if (bytes.toString('base64') !== item)
          throw new Error('Engineering artifact base64 is not canonical')
        inspectString(bytes.toString('utf8'))
      }
      inspectValue(item, seen)
      if (key === 'stdout' && typeof item === 'string') {
        let parsed
        try {
          parsed = JSON.parse(item)
        } catch {
          continue
        }
        inspectValue(parsed, seen)
      }
    }
  }
  seen.delete(value)
}

export function assertPublishableEngineeringEvidence(payload, operation) {
  const paths = operationPaths(operation)
  if (
    payload?.kind !== 'engineering-result' ||
    payload.operationId !== operation.id ||
    !payload.output
  )
    throw new Error('Engineering checkpoint identity and output required')
  const output = payload.output
  const stdout = typeof output === 'object' && output !== null ? output.stdout : output
  if (typeof stdout === 'string') {
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      parsed = null
    }
    for (const artifact of parsed?.artifacts ?? []) {
      if (
        typeof artifact?.path !== 'string' ||
        !paths.some((pattern) => pathMatches(artifact.path, [pattern]))
      )
        throw new Error('Returned engineering artifact is outside admitted operation paths')
    }
  }
  inspectValue(payload)
  return true
}
