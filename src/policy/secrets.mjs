// Secret-content and secret-file detection.
import { relative } from 'node:path'
import { slash } from '../shared/fs.mjs'

// The patterns are assembled from String.raw alternatives only to keep lines short; each RegExp
// has exactly the source and flags of the original single-line literal.
export const SECRET_RE = new RegExp(
  [
    String.raw`(-----BEGIN [A-Z ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----`,
    String.raw`|(?:api[_-]?key|client[_-]?secret|password|passwd|secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?)`,
    String.raw`\s*[:=]\s*["']?(?:bearer\s+)?[^\s"']{8,}`,
    String.raw`|\bAKIA[0-9A-Z]{16}\b`,
    String.raw`|\b(?:ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|sk-(?:proj-)?|npm_)[A-Za-z0-9_-]{12,}`,
    String.raw`|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
    String.raw`|(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s]+:[^\s]+@`,
    String.raw`|(?:sig|signature|se|sp|sv)=[^&\s]{8,}(?:&|$))`
  ].join(''),
  'i'
)
export const SECRET_FILE_RE = new RegExp(
  [
    String.raw`(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)`,
    String.raw`|[^/]*(?:secret|credential|password|private[-_]?key|access[-_]?token)[^/]*`,
    String.raw`|[^/]+\.(?:pem|p12|pfx|key))(?:\.md)?$`
  ].join(''),
  'i'
)
export function secretFile(path, root) {
  return SECRET_FILE_RE.test(slash(relative(root, path)))
}
