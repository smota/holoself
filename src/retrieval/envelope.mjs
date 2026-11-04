// Context envelope: bounds the emitted packet by the budget's byte cap, dropping documents last.
import { ENVELOPE_BYTE_CAPS, buildCursor, contradictionDigest, estimateTokens, selectionReceipt } from '../context-selection.mjs'
import { mcpToolEnvelope, packetFormat } from '../render/packet.mjs'
import { groupRestrictions, withoutPrivatePaths } from './projection.mjs'
import { buildReceiptPolicySources, resolvedContextAssertions } from './records.mjs'

export function fitEnvelope(
  o,
  result,
  { isMcp, isLinked, records, projections, budgetName, selected, candidates, link, lens, adapter, resolution, subject, identityId, selfId, cursorSecret }
) {
  // Linked callers strip private paths before measuring so the cap and total_bytes apply to what is actually sent.
  const finish = value => {
    if (!isLinked && !isMcp) return value
    const clean = withoutPrivatePaths(value)
    clean.self = { documents: clean.self.documents }
    clean.project = { name: value.project.name, documents: clean.project.documents }
    return clean
  }
  // Measure the format that is actually emitted: the MCP tool result, JSON, or the Markdown packet.
  const emitted = isMcp ? 'mcp' : o.json || o.format === 'json' ? 'json' : 'packet',
    packetAdapter = o.restrictedHost ? 'restricted-host' : o.adapter || o.format || 'packet'
  const measurePayload = value =>
    emitted === 'mcp'
      ? Buffer.byteLength(JSON.stringify(mcpToolEnvelope(value)))
      : emitted === 'json'
        ? Buffer.byteLength(JSON.stringify(value, null, 2) + '\n')
        : Buffer.byteLength(packetFormat(value, packetAdapter).trimEnd() + '\n')
  result = finish(result)

  // The envelope cap (2x the content budget) bounds the emitted packet on every path, not only --manifest.
  // Under pressure the envelope shrinks first (restrictions grouped by reason, proposals reduced to ids); documents go last.
  // o.envelopeCapBytes is an internal, tighter cap for hosts with an output limit (session-start hook mode); never a CLI flag.
  const budgetCap = ENVELOPE_BYTE_CAPS[budgetName] || ENVELOPE_BYTE_CAPS.standard,
    envelopeCap = Number.isInteger(o.envelopeCapBytes) && o.envelopeCapBytes > 0 ? Math.min(budgetCap, o.envelopeCapBytes) : budgetCap,
    dropped = []
  // Size fields are present (with values at least as wide as the final ones) while trimming, so adding them cannot push past the cap.
  const widest = envelopeCap === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : envelopeCap
  Object.assign(result.selection, {
    envelope_cap_bytes: envelopeCap === Number.MAX_SAFE_INTEGER ? null : envelopeCap,
    total_bytes: widest,
    estimated_tokens_total: widest,
    estimated_tokens_total_heuristic: widest
  })
  let payloadBytes = measurePayload(result),
    compacted = false
  if (payloadBytes > envelopeCap) {
    compacted = true
    result.restrictions = groupRestrictions(result.restrictions)
    result.selection.restrictions_grouped = true
    if (result.proposals?.length) result.proposals = result.proposals.map(p => ({ proposal_id: p.proposal_id, status: p.status }))
    payloadBytes = measurePayload(result)
  }
  while (records.length > 0 && payloadBytes > envelopeCap) {
    const removed = records.pop()
    dropped.push(removed.source_id)
    result.selection.envelope_dropped = dropped
    result.restrictions.push({ source: removed.path, reason: `packet envelope cap ${budgetName} exceeded` })
    if (compacted) result.restrictions = groupRestrictions(result.restrictions)
    const next = projections(records),
      cleanNext = finish({ self: next.self, project: next.project, methods: next.methods, sources: next.sources })
    Object.assign(result, {
      self: cleanNext.self,
      project: cleanNext.project,
      methods: cleanNext.methods,
      sources: cleanNext.sources
    })
    result.packet_metadata.source_hashes = next.source_hashes
    const receipt = selectionReceipt(records, {
      budget: budgetName,
      taskHash: selected.taskHash,
      lens,
      temporal: selected.temporalVal,
      need: result.selection.context_need,
      needReason: result.selection.need_reason
    })
    result.context_receipt = {
      ...result.context_receipt,
      context_hash: receipt.context_hash,
      source_ids: receipt.source_ids,
      source_hashes: receipt.source_hashes,
      ...(!isLinked && !isMcp ? { policy_sources: buildReceiptPolicySources(records) } : {})
    }
    const chars = records.reduce((sum, r) => sum + (r.content?.length || 0), 0)
    Object.assign(result.selection, {
      selected_count: records.length,
      selected_sources: records.map(r => r.source_id),
      omitted_count: result.selection.omitted_count + 1,
      truncated: true,
      content_chars: chars,
      estimated_tokens: estimateTokens(chars),
      truncated_sources: records.filter(r => r.truncated).map(r => r.source_id),
      contrib_sources: records.filter(r => r.kind === 'contrib').map(r => r.source_id),
      contradiction_digest: contradictionDigest(records)
    })
    result.validation = resolvedContextAssertions(records, lens, o.task, adapter, link, resolution, subject)
    payloadBytes = measurePayload(result)
  }
  if (dropped.length && o.manifest) {
    const candidateList = selected.candidates || candidates,
      startOffset = selected.startOffset || 0
    const nextOffset = records.length === 0 && startOffset < candidateList.length ? startOffset + 1 : startOffset + records.length
    result.selection.next_cursor =
      nextOffset < candidateList.length
        ? buildCursor(identityId, lens, budgetName, true, selfId, selected.taskHash, selected.temporalVal, nextOffset, selected.stateHash, cursorSecret)
        : null
  }
  if (payloadBytes > envelopeCap) {
    result.selection.truncated = true
    result.warnings.push('packet envelope exceeds cap without content')
  }

  // total_bytes counts itself, so measure until the digit count is stable.
  for (let pass = 0; pass < 4; pass++) {
    const bytes = measurePayload(result)
    if (result.selection.total_bytes === bytes) break
    Object.assign(result.selection, {
      total_bytes: bytes,
      estimated_tokens_total: Math.ceil(bytes / 4),
      estimated_tokens_total_heuristic: Math.ceil(bytes / 4)
    })
  }
  Object.defineProperty(result.selection, 'need', { get() { return this.context_need }, enumerable: false, configurable: true })
  return result
}
