// Optional plain-data port. Observers never change application results.
export function emitObservation(observer, event) {
  try {
    const result = observer?.(event)
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {})
  } catch {}
}
