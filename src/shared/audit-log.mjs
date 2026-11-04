// Hardened append-only NDJSON audit writer shared by the MCP server and session-start hook mode.
// Absolute paths only; never follows a symlink (O_NOFOLLOW, lstat on platforms without it); refuses hard-linked or
// non-regular files; keeps mode 0600 even when the file already exists; stops growing at maxBytes after one final
// audit_log_capped line. Failures are swallowed: auditing is diagnostic only.
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024
const CAPPED_LINE = `${JSON.stringify({ event: 'audit_log_capped' })}\n`
export function appendAuditLine(logPath, entry, maxBytes = AUDIT_LOG_MAX_BYTES) {
  if (!logPath || !isAbsolute(logPath)) return
  let fd
  try {
    const noFollow = fsConstants.O_NOFOLLOW || 0
    if (!noFollow || process.platform === 'win32') {
      try {
        if (lstatSync(logPath).isSymbolicLink()) return
      } catch (error) {
        if (error.code !== 'ENOENT') return
      }
    }
    // O_RDWR (not O_WRONLY) so the tail can be checked for an existing cap marker.
    fd = openSync(logPath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow, 0o600)
    const stat = fstatSync(fd)
    // A hard-linked log could append into another file the server has no business writing.
    if (!stat.isFile() || stat.nlink > 1) return
    if (process.platform !== 'win32')
      try {
        fchmodSync(fd, 0o600)
      } catch {
        // Best effort: a file owned by another user keeps its mode.
      }
    const line = `${JSON.stringify(entry)}\n`
    if (stat.size + Buffer.byteLength(line) <= maxBytes) {
      writeSync(fd, line)
      return
    }
    const tail = Buffer.alloc(Math.min(stat.size, Buffer.byteLength(CAPPED_LINE)))
    if (tail.length) readSync(fd, tail, 0, tail.length, stat.size - tail.length)
    if (tail.toString('utf8') !== CAPPED_LINE) writeSync(fd, CAPPED_LINE)
  } catch {
    // Auditing is diagnostic only; a failed append never changes the caller's result.
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd)
      } catch {}
  }
}
