// Markdown text helpers: sections, links, tags, claims and tokenization.
import { frontmatter } from '../policy/privacy-fields.mjs'
import { parseClaimBlocks, replaceClaimBlocks } from './claim-blocks.mjs'

const STOPWORDS = new Set(
  (
    `a an and are as at be been before between both but by can current do does for from had has have how i if in ` +
    `into is it its me more my no not of on or our should so than that the their them then there these they this ` +
    `those through to under use used using was we were what when where which who why will with you your
de een en het in is met om op te van voor wat wie zijn
e o a os as um uma de do da dos das em no na nos nas para por que se seu sua
der die das ein eine und ist mit von zu`
  ).split(/\s+/)
)

export function sections(text, { raw = false, empty = false } = {}) {
  if (raw) {
    const lines = String(text).split(/\r?\n/),
      out = []
    let current = []
    for (const line of lines) {
      if (/^#{1,4}\s+/.test(line) && current.length) {
        out.push(current.join('\n'))
        current = []
      }
      current.push(line)
    }
    if (current.length) out.push(current.join('\n'))
    return out
  }
  const result = []
  let heading = '(document)',
    level = 0,
    lines = []
  const flush = () => {
    const content = lines.join('\n').trim()
    if (content || (empty && level)) result.push({ heading, level, content })
  }
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+)$/)
    if (match) {
      flush()
      heading = match[1].trim()
      level = line.match(/^#+/)[0].length
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
// Wording of the current canonical claims; superseded and retired claim blocks are history, not live claims.
export function canonicalClaims(text) {
  const { body } = frontmatter(text),
    found = []
  for (const block of parseClaimBlocks(body)) if (block.status === 'current' && block.text) found.push(block.text)
  const withoutBlocks = replaceClaimBlocks(body, () => '', { failClosed: false })
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
export function tokenize(text, { stopwords = true } = {}) {
  return [
    ...new Set(
      (
        String(text)
          .toLowerCase()
          .match(/[\p{L}\p{N}]{3,}/gu) || []
      ).filter(token => !stopwords || !STOPWORDS.has(token))
    )
  ]
}
