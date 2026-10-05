import { spawn as nodeSpawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import process from 'node:process'

export function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        resolve(false)
      } else {
        const server = net.createServer()
        server.once('error', (bindErr) => {
          resolve(bindErr.code === 'EADDRINUSE')
        })
        server.once('listening', () => {
          server.close(() => resolve(false))
        })
        server.listen(port, host)
      }
    })
    socket.connect(port, host)
  })
}

export function killProcessTree(pid, { force = true } = {}) {
  return new Promise((resolve) => {
    if (!pid || typeof pid !== 'number') {
      return resolve(false)
    }

    const isWin = os.platform() === 'win32'
    if (isWin) {
      const args = ['/pid', String(pid), '/T']
      if (force) {
        args.push('/F')
      }
      const killer = nodeSpawn('taskkill', args, {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('exit', () => resolve(true))
      killer.once('error', () => {
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          // Process already dead
        }
        resolve(true)
      })
    } else {
      try {
        // In POSIX, kill process group if negative pid
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          // Process already dead
        }
      }
      resolve(true)
    }
  })
}

export class ProcessSupervisor {
  constructor(options = {}) {
    this.managedProcesses = new Map()
    this.logger = options.logger || console
    this.defaultTimeoutMs = options.defaultTimeoutMs || 30000
  }

  spawnProcess({
    command,
    args = [],
    options = {},
    port = null,
    label = 'unnamed-qa-process',
    timeoutMs = null,
  }) {
    const child = nodeSpawn(command, args, {
      detached: os.platform() !== 'win32',
      ...options,
    })

    const record = {
      pid: child.pid,
      label,
      command: [command, ...args].join(' '),
      port,
      status: 'running',
      startTime: Date.now(),
      child,
      exitCode: null,
      timeoutHandle: null,
    }

    const effectiveTimeout = timeoutMs || this.defaultTimeoutMs
    if (effectiveTimeout > 0) {
      record.timeoutHandle = setTimeout(async () => {
        if (record.status === 'running') {
          if (this.logger?.warn) {
            this.logger.warn(
              `[ProcessSupervisor] Process ${record.pid} (${record.label}) exceeded timeout of ${effectiveTimeout}ms. Terminating.`,
            )
          }
          await this.terminateProcess(record.pid, { force: true })
        }
      }, effectiveTimeout)
    }

    child.on('exit', (code, signal) => {
      if (record.status !== 'terminated') {
        record.status = 'exited'
      }
      record.exitCode = code
      if (record.timeoutHandle) {
        clearTimeout(record.timeoutHandle)
        record.timeoutHandle = null
      }
    })

    this.managedProcesses.set(child.pid, record)
    return record
  }

  async terminateProcess(pid, { force = true } = {}) {
    const record = this.managedProcesses.get(pid)
    if (!record) return false

    if (record.timeoutHandle) {
      clearTimeout(record.timeoutHandle)
      record.timeoutHandle = null
    }

    await killProcessTree(pid, { force })
    record.status = 'terminated'
    return true
  }

  async terminateAll({ force = true } = {}) {
    const terminations = []
    for (const [pid, record] of this.managedProcesses.entries()) {
      if (record.status === 'running') {
        terminations.push(this.terminateProcess(pid, { force }))
      }
    }
    await Promise.all(terminations)
  }

  getRunningProcesses() {
    return Array.from(this.managedProcesses.values()).filter((p) => p.status === 'running')
  }

  getManagedProcess(pid) {
    return this.managedProcesses.get(pid)
  }
}
