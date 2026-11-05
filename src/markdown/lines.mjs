// Line classifier shared by every heading scanner. Dependency-free: claim, policy and text modules all use it.
//
// A heading rule STARTS LIBERALLY and ENDS CONSERVATIVELY, so an unusual heading shape hides more rather than less.
//  - `starts`: any line that could plausibly present a name as a heading, wherever it sits: any indent, inside fences,
//    raw HTML and comments, behind blockquote or list prefixes, Setext, HTML headings, table header cells, and lines that
//    hold only emphasis, a caption-like element or a name and a colon. Starts never depend on the raw state below, so no
//    fence or HTML block can switch a rule off.
//  - `real`: only an unambiguous ATX heading at column 0, with a space or tab after the hashes, outside fences, raw HTML
//    blocks and comments, and with no other heading shape on the line. Only `real` headings end a rule or split a section.
// A start keeps a level when its shape states one: the ATX count, Setext `===` as 1 and `---` as 2, HTML `hN` as N. Any
// other start has no level (ANY_HEADING), and so does anything inside a raw construct: the next real heading ends it.
// Fences follow CommonMark, including behind a list or quote prefix: three or more backticks or tildes, backticks in the
// info string make it inline code, and a closer uses the same character, is at least as long and has no info string.
// Unclosed fences, `<pre>` blocks and comments run to the end of the text.
export const ANY_HEADING = Infinity
const SHAPE_SCAN_LIMIT = 2000
const RAW_SCAN_LIMIT = 20000
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSER = /^(`{3,}|~{3,})\s*$/
const FENCE_PREFIX = /^(?:\s*(?:>\s?|[-*+]\s+|\d{1,9}[.)]\s+))*/
const QUOTE_PREFIX = /^(?:\s*>\s?)+/
const REAL_ATX = /^(#{1,6})[ \t]+(.+)$/
const LOOSE_ATX = /^(#+)(\s*)(.*)$/
const SETEXT_UNDERLINE = /^\s*(=+|-+)\s*$/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const PREFIX = /^(?:>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/
const WRAPPER_OPEN = /^(?:<(?:details|p|div|span|section|center|font|li|td|tr|u)\b[^>]{0,200}>\s*)+/i
const WRAPPER_CLOSE = /(?:\s*<\/(?:details|p|div|span|section|center|font|li|td|tr|u)\s*>)+$/i
const EMPHASIS_LINE = /^(?:\*{1,3}|_{1,3})(.+?)(?:\*{1,3}|_{1,3}):?$/
const EMPHASIS_ELEMENT_LINE = /^<(b|strong|em|i)\b[^>]{0,200}>(.*)<\/\1\s*>:?$/i
const CAPTION_ELEMENT = /<(summary|caption|legend|dt|th)\b[^>]{0,200}>(.*?)(?:<\/\1\s*>|$)/gi
const LABEL_LINE = /^([^:]{2,60}):$/
const HTML_HEADING_OPEN = /<h([1-6])\b[^>]{0,200}>/gi
const HTML_HEADING_SPAN = /<h([1-6])\b[^>]{0,500}>([\s\S]{0,2000}?)<\/h\1\s*>/gi
const RAW_ANYWHERE = [
  { open: /<!--/, close: /-->/ },
  { open: /<(?:pre|script|style|textarea)(?=[\s>])/i, close: /<\/(?:pre|script|style|textarea)\s*>/i }
]
const RAW_AT_LINE_START = [
  { open: /^ {0,3}<\?/, close: /\?>/ },
  { open: /^ {0,3}<!\[CDATA\[/, close: /\]\]>/ },
  { open: /^ {0,3}<![A-Za-z]/, close: />/ }
]
const HTML_BLOCK_START = /^ {0,3}<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/>]|$)/
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const plain = text => text.replace(/<[^>]*>/g, '').trim()

function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (all, decimal, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? all
    const code = decimal ? Number(decimal) : parseInt(hex, 16)
    return code <= 0x10ffff ? String.fromCodePoint(code) : all
  })
}
// What a reader sees, for comparing text: entities decoded, compatibility forms unified (full-width letters and `＃`),
// invisible format characters removed, and every kind of whitespace folded to a space. Homoglyphs across scripts are not
// unified. This is for reading a line, never for deciding a real heading.
export function foldText(text) {
  return decodeEntities(String(text))
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
}
// The form in which a rule name and a heading or field name are compared. Both sides go through it.
export function ruleKey(text) {
  return foldText(text)
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
export function stripLinePrefixes(text) {
  let value = text
  for (let next = value.replace(PREFIX, ''); next !== value; next = value.replace(PREFIX, '')) value = next
  return value
}
// Moves through one line's raw HTML and comments, leaving the raw construct still open at its end, if any.
function advanceRaw(line, current) {
  let open = current,
    rest = line
  for (;;) {
    if (open) {
      const end = rest.match(open.close)
      if (!end) return open
      rest = rest.slice(end.index + end[0].length)
      open = null
    }
    const candidates = [...RAW_ANYWHERE, ...(rest === line ? RAW_AT_LINE_START : [])]
      .map(kind => ({ kind, found: rest.match(kind.open) }))
      .filter(item => item.found)
      .sort((a, b) => a.found.index - b.found.index)
    if (!candidates.length) return null
    open = candidates[0].kind
    rest = rest.slice(candidates[0].found.index + candidates[0].found[0].length)
  }
}
// Heading shapes readable from one line, without looking at the lines around it.
function lineShapes(line) {
  let text = stripLinePrefixes(foldText(line.slice(0, SHAPE_SCAN_LIMIT)).trim())
  text = text.replace(/^<!--\s*/, '').replace(/\s*-->$/, '')
  const shapes = [],
    atx = text.match(LOOSE_ATX)
  for (const element of text.matchAll(CAPTION_ELEMENT)) shapes.push({ level: ANY_HEADING, text: plain(element[2]) })
  // An ATX line is a heading whatever its text ends with, so `## Education:` is no label.
  if (atx) {
    if (atx[3].trim()) shapes.push({ level: atx[2] && atx[1].length <= 6 ? atx[1].length : ANY_HEADING, text: atx[3].trim(), atx: true })
    return shapes
  }
  const bare = text.replace(WRAPPER_OPEN, '').replace(WRAPPER_CLOSE, ''),
    emphasis = bare.match(EMPHASIS_LINE),
    element = bare.match(EMPHASIS_ELEMENT_LINE),
    label = bare.match(LABEL_LINE)
  if (emphasis) shapes.push({ level: ANY_HEADING, text: emphasis[1].trim() })
  if (element) shapes.push({ level: ANY_HEADING, text: plain(element[2]) })
  if (label) shapes.push({ level: ANY_HEADING, text: label[1].trim() })
  return shapes
}
// For each line, the level of the Setext heading whose paragraph holds it, or 0.
function setextLevels(lines) {
  const levels = new Array(lines.length).fill(0),
    breaks = line => !line.trim() || SETEXT_UNDERLINE.test(line) || REAL_ATX.test(line)
  for (let i = lines.length - 2; i >= 0; i--) {
    if (breaks(lines[i])) continue
    const underline = lines[i + 1].match(SETEXT_UNDERLINE)
    if (underline) levels[i] = underline[1][0] === '=' ? 1 : 2
    else if (lines[i + 1].trim()) levels[i] = levels[i + 1]
  }
  return levels
}
// HTML headings that span lines: every line of one presents the whole name, joined with and without the line break.
function htmlHeadingSpans(lines) {
  const spans = new Map(),
    joined = lines.join('\n')
  if (!/<h[1-6]/i.test(joined)) return spans
  let line = 0,
    lineEnd = lines[0].length
  for (const match of joined.matchAll(HTML_HEADING_SPAN)) {
    while (match.index > lineEnd) lineEnd += 1 + lines[++line].length
    const end = match.index + match[0].length
    if (end <= lineEnd) continue
    const text = plain(match[2]),
      shapes = [text.replace(/\s+/g, ''), text].map(name => ({ level: Number(match[1]), text: name, fixed: true }))
    let last = line,
      lastEnd = lineEnd
    while (end > lastEnd) lastEnd += 1 + lines[++last].length
    for (let i = line; i <= last; i++) spans.set(i, shapes)
  }
  return spans
}
function fenceOpener(line) {
  const prefix = line.match(FENCE_PREFIX)[0],
    marker = line.slice(prefix.length).match(FENCE)
  if (!marker || (marker[1][0] === '`' && marker[2].includes('`'))) return null
  return { char: marker[1][0], length: marker[1].length, width: prefix.length }
}
function closesFence(line, fence) {
  const rest = line.replace(QUOTE_PREFIX, ''),
    indent = rest.length - rest.trimStart().length,
    marker = rest.trimStart().match(FENCE_CLOSER)
  return Boolean(marker) && indent <= fence.width + 3 && marker[1][0] === fence.char && marker[1].length >= fence.length
}
// One entry per line: `raw` says the line is code or raw HTML, `real` and `starts` are described above.
export function classifyLines(lines) {
  const texts = lines.map(String),
    setext = setextLevels(texts),
    spans = htmlHeadingSpans(texts)
  let fence = null,
    raw = null,
    untilBlank = false,
    htmlHeading = 0
  return texts.map((line, index) => {
    const wasRaw = Boolean(fence || raw || untilBlank)
    if (fence) {
      if (closesFence(line, fence)) fence = null
    } else {
      const opened = !raw && !untilBlank ? fenceOpener(line) : null
      if (opened) fence = opened
      else {
        if (!raw && !untilBlank && HTML_BLOCK_START.test(line)) untilBlank = true
        else if (!line.trim()) untilBlank = false
        raw = advanceRaw(line.slice(0, RAW_SCAN_LIMIT), raw)
      }
    }
    const isRaw = wasRaw || Boolean(fence || raw),
      head = line.slice(0, SHAPE_SCAN_LIMIT),
      shapes = lineShapes(line)
    // An unclosed HTML heading runs on, so every line up to its closing tag presents a name.
    if (htmlHeading && plain(head)) shapes.push({ level: htmlHeading, text: plain(head), fixed: true })
    if (htmlHeading && new RegExp(`</h${htmlHeading}\\s*>`, 'i').test(head)) htmlHeading = 0
    for (const open of head.matchAll(HTML_HEADING_OPEN)) {
      const level = Number(open[1]),
        rest = head.slice(open.index + open[0].length),
        close = rest.search(new RegExp(`</h${level}\\s*>`, 'i'))
      shapes.push({ level, text: plain(close < 0 ? rest : rest.slice(0, close)), fixed: true })
      if (close < 0) htmlHeading = level
    }
    if (spans.has(index)) shapes.push(...spans.get(index))
    if (setext[index]) shapes.push({ level: setext[index], text: head.trim() })
    const next = texts[index + 1]
    if (next !== undefined && head.includes('|') && TABLE_DELIMITER.test(next.slice(0, SHAPE_SCAN_LIMIT)))
      for (const cell of foldText(head).split('|')) if (cell.trim()) shapes.push({ level: ANY_HEADING, text: cell.trim() })
    const atx = line.match(REAL_ATX),
      real = atx && !isRaw && shapes.every(shape => shape.atx) ? { level: atx[1].length, text: atx[2].trim() } : null
    return { raw: isRaw, real, starts: real ? [] : shapes.map(({ level, text, fixed }) => ({ level: wasRaw && !fixed ? ANY_HEADING : level, text })) }
  })
}
// The real headings of a text, at most `maxLevel` deep.
export function realHeadings(text, maxLevel = 6) {
  return classifyLines(String(text).split(/\r?\n/))
    .map(kind => kind.real)
    .filter(real => real && real.level <= maxLevel)
}
