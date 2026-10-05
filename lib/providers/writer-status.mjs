import { hostname } from 'node:os'

export function observeLocalWriter(
  writer,
  { host = hostname(), probe = (pid) => process.kill(pid, 0) } = {},
) {
  if (
    !writer ||
    writer.host !== host ||
    !Number.isInteger(writer.pid) ||
    writer.pid < 1 ||
    !writer.instance
  )
    return { stopped: null, reason: 'Writer identity is unavailable on this host' }
  try {
    probe(writer.pid)
    return {
      stopped: false,
      identity: writer.instance,
      reason: 'Recorded PID exists; a timeout never grants takeover',
    }
  } catch (error) {
    return error.code === 'ESRCH'
      ? {
          stopped: true,
          identity: writer.instance,
          reason: 'Recorded process no longer exists on the recorded host',
        }
      : { stopped: null, identity: writer.instance, reason: 'Process status unavailable' }
  }
}
