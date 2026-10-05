# Authoring a provider

A provider descriptor has `version: 1`, a stable `id`, provider version, supported SPI range,
facets, intent support, targets, transports, OS support, trust source, compatibility range, facet
operations, and an async `inspect()` method. Execution providers also expose plan, execute, status,
cancel, cleanup, and receipt behavior. Inspection returns availability plus any execution target,
transport, delegation boundary, reason, and namespaced metadata.

`facets` declare service surfaces. `intentSupport` separately declares portable execution behavior
with implementation, fidelity, evidence level, and limits. Do not put facets such as `execution` or
controls such as `single-writer` into `intentSupport`.

```js
import { createLocalCliProvider } from '../../lib/providers/local-cli.mjs'

const provider = createLocalCliProvider({
  id: 'example-cli',
  platform: 'example',
  executable: 'example',
  args: ['--version'],
  executionTarget: 'provider-api',
})
```

## Rules

- Declare only facets the implementation proves.
- Prefer runtime probing for advanced intents; otherwise label support `contract-tested` or
  `self-declared` rather than presenting it as observed.
- Give every execution provider an explicit registered `platform` identity distinct from its
  provider ID and execution target.
- Use executable-plus-argument process invocation with `shell: false`.
- Keep credentials outside descriptors, receipts, and repository evidence.
- Return `ArtifactRef` values for portable inputs, outputs, and validation.
- Do not make optional provider unavailability block an intent that permits manual/sequential
  fallback.
- Do not import another product's private source or build output. Invoke a documented public CLI or
  API pinned to a reviewed contract.
- Treat mutation as an explicit action boundary with a preview token and
  receipt.
- Record unobserved revision, workspace, effective boundary, enforcement, and observed boundary as
  `null`; never copy requested or declared values into observed provenance.
- Bound API invocation with the planned timeout and retain a failed or cancelled receipt before
  propagating execution errors.
- Treat cancellation as observed only when the invoker settles after the abort request. A timed-out
  invoker that ignores its signal remains `timeout-pending`, records that execution may continue,
  and triggers configured cleanup.
- Force CLI-specific review adapters onto a non-command single-turn surface. The Grok adapter binds
  the complete prompt to `--single=<prompt>` after fixed plan/no-web policy; it enables delegation
  only when the resolved execution plan satisfies `delegated-work`.

Test descriptor validation, unavailable behavior, version rejection, fallback, receipt provenance,
and cross-platform process invocation. Architecture tests must keep `lib/core/` independent from
provider implementations.
