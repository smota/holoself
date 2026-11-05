// Line classifier shared by every heading scanner. Dependency-free: claim, policy and text modules all use it.
//
// A heading rule STARTS LIBERALLY and ENDS CONSERVATIVELY, so an unusual heading shape hides more rather than less.
//  - `starts`: any line that could plausibly present a name as a heading, wherever it sits: any indent, inside fences,
//    raw HTML and comments, behind blockquote or list prefixes, Setext, HTML headings, and lines that hold only emphasis, a
//    caption-like element or a name and a colon. Starts never depend on
//    the raw state below, so no fence or HTML block can switch a rule off.
//  - `real`: only an unambiguous ATX heading at column 0 to 3, outside fences, raw HTML blocks and comments, and with no
//    other heading shape on the line. Only `real` headings end a rule or split a section.
// Fences follow CommonMark: three or more backticks or tildes after at most three spaces, backticks in the info string
// make it inline code, and a closer uses the same character, is at least as long and has no info string. Unclosed fences,
// `<pre>` blocks and comments run to the end of the text.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const REAL_ATX = /^ {0,3}(#{1,6})\s+(.+)$/
const LOOSE_ATX = /^(#+)\s*(.*)$/
const SETEXT_UNDERLINE = /^\s*(=+|-+)\s*$/
const PREFIX = /^(?:>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/
const EMPHASIS_LINE = /^(?:\*{1,3}|_{1,3})(.+?)(?:\*{1,3}|_{1,3}):?$/
const ELEMENT_LINE = /^<(b|strong|em|i|summary|caption|legend|dt|th)\b[^>]*>(.*)<\/\1\s*>:?$/i
const LABEL_LINE = /^([^:]{2,60}):$/
const HTML_HEADING_OPEN = /<h([1-6])\b[^>]*>/gi
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

const plain = text => text.replace(/<[^>]*>/g, '').trim()

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
// Heading shapes readable from one line, without the Setext look-ahead.
function lineShapes(line) {
  let text = line.trim()
  for (let next = text.replace(PREFIX, ''); next !== text; next = text.replace(PREFIX, '')) text = next
  text = text.replace(/^<!--\s*/, '').replace(/\s*-->$/, '')
  const shapes = [],
    atx = text.match(LOOSE_ATX),
    emphasis = text.match(EMPHASIS_LINE),
    element = text.match(ELEMENT_LINE),
    label = text.match(LABEL_LINE)
  if (atx?.[2].trim()) shapes.push({ level: atx[1].length <= 6 ? atx[1].length : 1, text: atx[2].trim(), atx: true })
  if (emphasis) shapes.push({ level: 1, text: emphasis[1].trim() })
  if (element) shapes.push({ level: 1, text: plain(element[2]) })
  if (label) shapes.push({ level: 1, text: label[1].trim() })
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
// One entry per line: `raw` says the line is code or raw HTML, `real` and `starts` are described above.
export function classifyLines(lines) {
  const texts = lines.map(String),
    setext = setextLevels(texts)
  let fence = null,
    raw = null,
    untilBlank = false,
    htmlHeading = 0
  return texts.map((line, index) => {
    const wasRaw = Boolean(fence || raw || untilBlank)
    if (fence) {
      const marker = line.match(FENCE)
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null
    } else {
      const marker = !raw && !untilBlank ? line.match(FENCE) : null
      if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = { char: marker[1][0], length: marker[1].length }
      else {
        if (!raw && !untilBlank && HTML_BLOCK_START.test(line)) untilBlank = true
        else if (!line.trim()) untilBlank = false
        raw = advanceRaw(line, raw)
      }
    }
    const isRaw = wasRaw || Boolean(fence || raw),
      shapes = lineShapes(line)
    // An HTML heading can span lines, so every line up to its closing tag presents the name.
    if (htmlHeading && plain(line)) shapes.push({ level: htmlHeading, text: plain(line) })
    if (htmlHeading && new RegExp(`</h${htmlHeading}\\s*>`, 'i').test(line)) htmlHeading = 0
    for (const open of line.matchAll(HTML_HEADING_OPEN)) {
      const level = Number(open[1]),
        rest = line.slice(open.index + open[0].length),
        close = rest.search(new RegExp(`</h${level}\\s*>`, 'i'))
      shapes.push({ level, text: plain(close < 0 ? rest : rest.slice(0, close)) })
      if (close < 0) htmlHeading = level
    }
    if (setext[index]) shapes.push({ level: setext[index], text: line.trim() })
    const atx = line.match(REAL_ATX),
      real = atx && !isRaw && shapes.every(shape => shape.atx) ? { level: atx[1].length, text: atx[2].trim() } : null
    return { raw: isRaw, real, starts: real ? [] : shapes.map(({ level, text }) => ({ level, text })) }
  })
}
// The real headings of a text, at most `maxLevel` deep.
export function realHeadings(text, maxLevel = 6) {
  return classifyLines(String(text).split(/\r?\n/))
    .map(kind => kind.real)
    .filter(real => real && real.level <= maxLevel)
}
