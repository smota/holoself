// Packet rendering: Markdown context packets per adapter and the MCP tool envelope.

// MCP context results carry the packet once, in structuredContent; the text part is a short summary.
export function mcpContextSummary(data) {
  const docs = [...(data.self?.documents || []), ...(data.project?.documents || []), ...(data.methods?.documents || [])]
  return (
    `Holoself context (${data.lens}, ${data.status}): ${docs.length} document(s) in structuredContent.data; ` +
    `${data.selection?.total_bytes ?? '?'} bytes; receipt ${data.context_receipt?.context_hash}.\n` +
    // Source handles are listed in the text block too: some hosts pass only text content to the model, and
    // holoself_context_get needs the exact handle.
    `${docs.map(doc => `- ${doc.path}${doc.source_id ? ` [${doc.source_id}]` : ''}${doc.truncated ? ' (excerpt)' : ''}`).join('\n')}`
  )
}
export function mcpToolEnvelope(data) {
  const structuredContent = { schema_version: 1, data }
  return { content: [{ type: 'text', text: mcpContextSummary(data) }], structuredContent }
}
export function packetFormat(data, adapter = 'generic') {
  const labels = {
    pi: 'Pi context packet',
    claude: 'Claude Code context packet',
    codex: 'Codex context packet',
    generic: 'Holoself context packet',
    obsidian: 'Obsidian/Claude context packet',
    'restricted-host': 'Restricted-host Holoself context packet'
  }
  const title = labels[adapter] || labels.generic,
    metadata = data.packet_metadata
  const docs = [
    ...data.self.documents.map(x => ({ ...x, owner: 'self' })),
    ...data.project.documents.map(x => ({ ...x, owner: 'project' })),
    ...(data.methods?.documents || []).map(x => ({ ...x, owner: 'method' }))
  ]
  const receipt =
    `Context receipt: ${data.context_receipt.context_hash} (${data.context_receipt.cache.hit ? 'cache hit' : 'fresh resolution'})\n` +
    `Context gate: ${data.selection.context_need}; budget: ${data.selection.budget}; estimated tokens: ${data.selection.estimated_tokens}; ` +
    `selected sources: ${data.selection.selected_count}${data.selection.total_bytes ? `; packet bytes: ${data.selection.total_bytes}` : ''}`
  return (
    `# ${title}\n\nPacket ID: ${metadata.packet_id}\n${receipt}\nGenerated: ${metadata.generated_at}\n` +
    `Expires: ${metadata.expires_at || 'not applicable (live local resolution)'}\nHost mode: ${metadata.host_mode}\n` +
    `Lens: ${data.lens}\nTask: ${data.task || '(none)'}\n` +
    `Privacy: access-filtered. Reading context does not authorize external action. Preserve provenance; never silently write self.\n\n` +
    `## Source hashes (SHA-256)\n\n${
      metadata.source_hashes.map(source => `- ${source.kind}:${source.path} ${source.sha256} (${source.freshness})`).join('\n') || '- None'
    }\n\n${docs
      .map(
        d =>
          `## ${d.owner}: ${d.path}\n\nAccess lenses: ${(d.metadata.access_lenses || []).join(', ')}\nDisclosure: ${d.metadata.disclosure}\n` +
          `Sensitivity: ${d.metadata.sensitivity}\nDocument role: ${d.metadata.document_role}\n` +
          `Publication allowed: ${d.metadata.publication_allowed ? 'yes' : 'no'}\n\n${d.content}`
      )
      .join('\n\n')}\n\n## Restrictions\n\n${
      data.restrictions.map(x => `- ${x.source}: ${x.reason}${x.count > 1 ? ` (${x.count} sources)` : ''}`).join('\n') || '- None'
    }\n`
  )
}
