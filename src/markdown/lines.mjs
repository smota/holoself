// Line classifier shared by every heading scanner, following CommonMark for fenced code. An opener is three or more
// backticks or tildes after at most three spaces, and backticks in its info string make it inline code instead. A closer
// uses the same character, is at least as long and has no info string. An unclosed fence runs to the end of the text.
// Dependency-free: claim, policy and text modules all use it.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^(#{1,6})\s+(.+)$/

function headingOf(line) {
  const match = line.match(HEADING)
  return match ? { level: match[1].length, text: match[2].trim() } : null
}
// Returns a function to call on each line in order. `heading` reports the shape of a line and `fenced` says it is code,
// so a heading-shaped line inside a fence has both. Callers that want real headings check `heading && !fenced`.
export function createLineClassifier() {
  let open = null
  return line => {
    const text = String(line),
      marker = text.match(FENCE)
    if (open) {
      if (marker && marker[1][0] === open.char && marker[1].length >= open.length && !marker[2].trim()) open = null
      return { fenced: true, heading: marker ? null : headingOf(text) }
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      open = { char: marker[1][0], length: marker[1].length }
      return { fenced: true, heading: null }
    }
    return { fenced: false, heading: headingOf(text) }
  }
}
// The real headings of a text, at most `maxLevel` deep.
export function realHeadings(text, maxLevel = 6) {
  const classify = createLineClassifier(),
    found = []
  for (const line of String(text).split(/\r?\n/)) {
    const { fenced, heading } = classify(line)
    if (heading && !fenced && heading.level <= maxLevel) found.push(heading)
  }
  return found
}
