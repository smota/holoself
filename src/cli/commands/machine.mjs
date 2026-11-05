// holoself machine status|register|forget: this machine's map from self_id to self checkout
// (docs/decisions/portable-links.md, section 2).
import { forgetSelf, machineStatus, registerSelf } from '../../link/machine.mjs'
import { askConfirm } from '../link-helpers.mjs'

const print = (o, value, text) => console.log(o.json ? JSON.stringify(value, null, 2) : text)

export async function runMachine(o, sub) {
  if (sub === 'status') {
    const status = machineStatus()
    const lines = [`Self map: ${status.selves_file} (${status.state})`]
    if (!status.selves.length) lines.push('No selves registered on this machine.')
    for (const item of status.selves)
      lines.push(`${item.exists && item.id_matches ? '[ok]' : '[!!]'} ${item.self_id} -> ${item.path}${item.exists ? (item.id_matches ? '' : ' (config.json id differs)') : ' (missing)'}`)
    for (const message of status.diagnostics) lines.push(`[warn] ${message}`)
    print(o, status, lines.join('\n'))
    if (status.state === 'invalid' || status.selves.some(item => !item.exists || !item.id_matches)) process.exitCode = 1
    return true
  }
  if (sub === 'register') {
    const result = registerSelf(o.root, { dryRun: Boolean(o.dryRun) }),
      value = { dry_run: Boolean(o.dryRun), self_id: result.self_id, path: result.path, adds_self_id: result.adds_self_id, changed: result.changed, diagnostics: result.diagnostics }
    const id = result.self_id || '(new self_id)'
    print(
      o,
      value,
      o.dryRun
        ? `[dry-run] would ${result.adds_self_id ? 'add a self_id to config.json and ' : ''}register ${id} -> ${result.path}${result.changed ? '' : ' (unchanged)'}`
        : `[ok] registered ${id} -> ${result.path}${result.changed ? '' : ' (unchanged)'}`
    )
    return true
  }
  if (sub === 'forget') {
    const id = o.args?.[1]
    if (!id) throw new Error('machine forget requires <self_id>')
    if (!o.dryRun && !(await askConfirm(o, `Forget this machine's checkout of ${id}?`))) return true
    const result = forgetSelf(id, { dryRun: Boolean(o.dryRun) }),
      value = { dry_run: Boolean(o.dryRun), self_id: id, changed: result.changed, previous_path: result.previous?.path || null, diagnostics: result.diagnostics }
    print(
      o,
      value,
      !result.changed ? `[ok] ${id} is not registered on this machine` : o.dryRun ? `[dry-run] would forget ${id} -> ${result.previous.path}` : `[ok] forgot ${id}`
    )
    return true
  }
  throw new Error('machine requires status, register, or forget')
}
