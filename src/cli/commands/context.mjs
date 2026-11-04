// holoself context command (moved verbatim from runEcosystem).
import { join } from 'node:path'
import { packetFormat } from '../../render/packet.mjs'
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
  return true
}
