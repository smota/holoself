// holoself context command (moved verbatim from runEcosystem).
import { join } from 'node:path'
import { recordServedPacket } from '../../ledger.mjs'
import { packetFormat } from '../../render/packet.mjs'
import { resolveCaller } from '../../retrieval/caller.mjs'
import { contextData } from '../../retrieval/context.mjs'
import { assertContainedPath, atomicWrite, slash } from '../../shared/fs.mjs'
import { hookContext } from '../hook-mode.mjs'
import { projectPath } from '../link-helpers.mjs'

export async function runContext(o, sub) {
  if (o.hook) {
    console.log(hookContext(o).content.trimEnd())
    return true
  }
  const data = contextData(o),
    format = o.json ? 'json' : o.format || 'packet',
    packetAdapter = o.restrictedHost ? 'restricted-host' : o.adapter || format,
    content = format === 'json' ? JSON.stringify(data, null, 2) + '\n' : packetFormat(data, packetAdapter)
  if (o.output || o.snapshot) {
    const project = projectPath(o),
      out = o.output || join(project, '.holoself', 'runtime', 'context-packet.md')
    if (!o.yes) throw new Error(`Writing context snapshot requires --yes: ${out}`)
    assertContainedPath(project, out, 'snapshot output')
    atomicWrite(out, content)
    console.log(
      JSON.stringify(
        {
          status: 'written',
          mode: 'snapshot',
          path: slash(out),
          lens: data.lens,
          sources: data.sources.length,
          packet_metadata: data.packet_metadata,
          validation: data.validation,
          warnings: data.warnings
        },
        null,
        2
      )
    )
  } else console.log(content.trimEnd())
  try {
    const caller = resolveCaller(o)
    const isLinked = caller.identity?.kind === 'client:linked'
    const surface = process.env.HOLOSELF_SURFACE === 'workbench' ? 'workbench' : 'cli'
    recordServedPacket({
      data,
      project: isLinked ? caller.project : null,
      self: caller.self,
      link: isLinked ? caller.link : null,
      surface,
      host: process.env.HOLOSELF_HOST || null,
      onFailure: err => console.error(`[warn] served-context ledger write failed (${err.code}): ${err.message}`)
    })
  } catch {}
  return true
}
