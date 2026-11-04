// Markdown text helpers: sections, links, tags, claims and token relevance.
import { frontmatter } from '../policy/privacy-fields.mjs'

export function sections(text) {
  const result = []
  let heading = '(document)',
    lines = []
  const flush = () => {
    const content = lines.join('\n').trim()
    if (content) result.push({ heading, content })
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+)$/)
    if (match) {
      flush()
      heading = match[1].trim()
      lines = []
    } else lines.push(line)
  }
  flush()
  return result
}
export function links(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1])
}
export function tags(text) {
  return [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map(m => m[1]))].sort()
}
export function claims(text) {
  return text
    .split(/\r?\n/)
    .map(x => x.replace(/^[-*]\s+/, '').trim())
    .filter(x => x.length >= 20 && !x.startsWith('#'))
    .slice(0, 50)
}
export function canonicalClaims(text) {
  const { body } = frontmatter(text),
    found = []
  const blocks = [...body.matchAll(/<!-- holoself-claim visibility=[a-z-]+ -->([\s\S]*?)<!-- \/holoself-claim -->/g)]
  for (const [, block] of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(x => x && !x.startsWith('#') && !/^[-*]\s+(?:Evidence|Confidence|Visibility|Provenance|Approved):/i.test(x))
    if (lines.length) found.push(lines.join(' '))
  }
  const withoutBlocks = body.replace(/<!-- holoself-claim visibility=[a-z-]+ -->[\s\S]*?<!-- \/holoself-claim -->/g, '')
  for (const section of sections(withoutBlocks)) {
    if (!/^CLAIM(?:[- _]|$)/i.test(section.heading)) continue
    const approved = section.content
      .split(/\r?\n/)
      .map(line => line.match(/^\s*[-*]?\s*\*\*Approved wording:\*\*\s*(.+?)\s*$/i)?.[1])
      .filter(Boolean)
    if (approved.length) found.push(...approved)
    else {
      const prose = section.content
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(x => x && !/^[-*|]/.test(x) && !/^\*\*[^*]+:\*\*/.test(x))
      if (prose.length) found.push(prose.join(' '))
    }
  }
  return found.map(x => x.trim()).filter(Boolean)
}
export function tokenize(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])
}
export function relevance(text, task) {
  if (!task) return 0
  const wanted = tokenize(task)
  const got = tokenize(text)
  let score = 0
  for (const token of wanted) if (got.has(token)) score++
  return score
}
