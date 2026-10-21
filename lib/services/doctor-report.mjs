export function formatDoctorJson(report) {
  return JSON.stringify(report, null, 2) + '\n'
}

export function formatDoctorPlain(report) {
  const lines = []
  lines.push('=== AgentFlow Unified Health & Drift Report ===')
  lines.push('Target: ' + report.targetDir)
  lines.push(
    'Status: ' + report.summary.status.toUpperCase() + ' (Exit: ' + report.summary.exitCode + ')',
  )
  lines.push('')

  lines.push('--- Findings by Dimension ---')
  const byDim = {}
  for (const f of report.findings) {
    byDim[f.dimension] = byDim[f.dimension] || []
    byDim[f.dimension].push(f)
  }

  for (const [dim, findings] of Object.entries(byDim)) {
    lines.push('[' + dim + ']')
    for (const f of findings) {
      const mark =
        f.structural === 'valid' && (f.alignment === 'matched' || f.alignment === 'unknown')
          ? '✓'
          : '✗'
      lines.push('  ' + mark + ' ' + f.id + ' (' + f.target + '): ' + f.reason)
      if (f.proposedChange) {
        lines.push('    - Future repair: ' + f.proposedChange)
      }
      if (f.preservedPaths && f.preservedPaths.length) {
        lines.push('    - Preserves: ' + f.preservedPaths.join(', '))
      }
    }
    lines.push('')
  }

  lines.push('--- Summary Counts ---')
  for (const [key, count] of Object.entries(report.summary.counts)) {
    lines.push('  ' + key + ': ' + count)
  }
  lines.push('')

  if (report.summary.incomplete) {
    lines.push(
      '  Coverage incomplete: detailed output or input inspection was bounded; omitted scope remains unknown.',
    )
    lines.push(
      '  Observed findings: ' +
        report.summary.totalFindings +
        '; omitted details: ' +
        report.summary.omittedFindings,
    )
  }
  lines.push('--- Prospective Remediation Pointers ---')
  if (report.remediation.proposedChanges.length === 0) {
    lines.push('  No repair pointer in the observed scope; unknown state is not confirmation.')
  } else {
    for (const change of report.remediation.proposedChanges) {
      lines.push('  • Would modify: ' + change)
    }
  }
  if (report.remediation.preservedPaths.length) {
    lines.push('  • Would preserve: ' + [...new Set(report.remediation.preservedPaths)].join(', '))
  }

  return lines.join('\n') + '\n'
}
