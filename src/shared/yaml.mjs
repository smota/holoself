// Minimal YAML subset used by link.yaml, frontmatter and proposals (moved verbatim from ecosystem.mjs).

export function quote(value) {
  return JSON.stringify(value ?? '')
}
export function stripYamlComment(value) {
  let quote = null,
    escaped = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && quote === '"') {
      escaped = true
      continue
    }
    if ((c === '"' || c === "'") && (!quote || quote === c)) {
      quote = quote ? null : c
      continue
    }
    if (c === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd()
  }
  return value
}
export function parseScalar(value) {
  const v = stripYamlComment(value).trim()
  if (!v || v === 'null' || v === '~') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v)
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Error(`invalid YAML scalar: ${v}`)
    try {
      return JSON.parse(v)
    } catch {
      const inner = v.slice(1, -1).trim()
      return inner ? inner.split(',').map(item => parseScalar(item)) : []
    }
  }
  if (v.startsWith('{') || v.startsWith('"')) {
    try {
      return JSON.parse(v)
    } catch {
      throw new Error(`invalid YAML scalar: ${v}`)
    }
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'")) throw new Error(`invalid YAML scalar: ${v}`)
    return v.slice(1, -1).replaceAll("''", "'")
  }
  return v
}
export function parseYaml(text) {
  const lines = []
  for (const [lineNumber, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (raw.includes('\t')) throw new Error(`invalid YAML indentation at line ${lineNumber + 1}`)
    const text = stripYamlComment(raw.trim())
    if (!text) continue
    lines.push({ indent: raw.length - raw.trimStart().length, text, line: lineNumber + 1 })
  }
  if (!lines.length) return {}
  const parseBlock = (start, indent) => {
    const array = lines[start].text.startsWith('- '),
      value = array ? [] : Object.create(null)
    let i = start
    while (i < lines.length) {
      const item = lines[i]
      if (item.indent < indent) break
      if (item.indent > indent) throw new Error(`unexpected YAML indentation at line ${item.line}`)
      if (array) {
        if (!item.text.startsWith('- ')) throw new Error(`mixed YAML list and mapping at line ${item.line}`)
        const raw = item.text.slice(2).trim()
        if (!raw) throw new Error(`empty YAML list item at line ${item.line}`)
        value.push(parseScalar(raw))
        i++
        continue
      }
      if (item.text.startsWith('- ')) throw new Error(`unexpected YAML list item at line ${item.line}`)
      const match = item.text.match(/^([^:#][^:]*):(?:\s*(.*))?$/)
      if (!match) throw new Error(`invalid YAML mapping at line ${item.line}`)
      const key = match[1].trim(),
        raw = match[2] ?? ''
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`unsafe YAML key ${key} at line ${item.line}`)
      if (Object.hasOwn(value, key)) throw new Error(`duplicate YAML key ${key} at line ${item.line}`)
      if (['>', '>-', '|', '|-'].includes(raw)) {
        const chunks = []
        let j = i + 1
        while (j < lines.length && lines[j].indent > indent) {
          chunks.push(lines[j].text)
          j++
        }
        const folded = raw.startsWith('>'),
          keepNewline = !raw.endsWith('-')
        value[key] = (folded ? chunks.join(' ') : chunks.join('\n')) + (keepNewline ? '\n' : '')
        i = j
        continue
      }
      if (raw !== '') {
        value[key] = parseScalar(raw)
        i++
        continue
      }
      const next = lines[i + 1]
      if (!next || next.indent <= indent) {
        value[key] = null
        i++
        continue
      }
      const child = parseBlock(i + 1, next.indent)
      value[key] = child.value
      i = child.next
    }
    return { value, next: i }
  }
  if (lines[0].indent !== 0) throw new Error(`invalid YAML root indentation at line ${lines[0].line}`)
  const parsed = parseBlock(0, 0)
  if (parsed.next !== lines.length) throw new Error(`invalid YAML at line ${lines[parsed.next].line}`)
  if (Array.isArray(parsed.value)) throw new Error('YAML root must be a mapping')
  return parsed.value
}
export function yamlObject(object, indent = '') {
  let out = ''
  for (const [key, value] of Object.entries(object)) {
    if (Array.isArray(value)) {
      if (!value.length) out += `${indent}${key}: []\n`
      else {
        out += `${indent}${key}:\n`
        for (const item of value) out += `${indent}  - ${quote(item)}\n`
      }
    } else if (value && typeof value === 'object') out += `${indent}${key}:\n${yamlObject(value, indent + '  ')}`
    else out += `${indent}${key}: ${typeof value === 'string' ? quote(value) : String(value)}\n`
  }
  return out
}
