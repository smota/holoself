import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { PACKAGE_ROOT } from '../src/shared/package-root.mjs'

// Explicit allowlist of top-level helper/declaration names permitted in more than one module under src/.
// Ideally empty: consolidate shared helpers into src/shared/* or domain modules and import/re-export them.
const ALLOWLIST = new Set([])

function listSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full)
  }
  return out.sort()
}

function tokenizeJs(src) {
  const tokens = []
  let i = 0
  const isIdentStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$'
  const isIdentPart = c => isIdentStart(c) || (c >= '0' && c <= '9')
  const regexPrevValues = new Set([
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '%',
    '<',
    '>',
    '^',
    '~',
    'return',
    'throw',
    'case',
    'in',
    'of',
    'typeof',
    'void',
    'delete',
    'await',
    'yield'
  ])

  const scanTemplate = () => {
    i++
    while (i < src.length) {
      if (src[i] === '\\') {
        i += 2
        continue
      }
      if (src[i] === '`') {
        i++
        break
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2
        let depth = 1
        while (i < src.length && depth > 0) {
          const ch = src[i]
          if (ch === "'" || ch === '"') {
            const q = ch
            i++
            while (i < src.length) {
              if (src[i] === '\\') i += 2
              else if (src[i] === q) {
                i++
                break
              } else i++
            }
          } else if (ch === '`') {
            scanTemplate()
          } else if (ch === '/' && src[i + 1] === '/') {
            i += 2
            while (i < src.length && src[i] !== '\n') i++
          } else if (ch === '/' && src[i + 1] === '*') {
            i += 2
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
            i += 2
          } else {
            if (ch === '{') depth++
            else if (ch === '}') depth--
            i++
          }
        }
        continue
      }
      i++
    }
  }

  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      i += 2
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === q) {
          i++
          break
        }
        i++
      }
      tokens.push({ type: 'str', value: q })
      continue
    }
    if (c === '`') {
      scanTemplate()
      tokens.push({ type: 'tmpl', value: '`' })
      continue
    }
    if (c === '/') {
      const prev = tokens[tokens.length - 1]
      const canBeRegex = !prev || regexPrevValues.has(prev.value)
      if (canBeRegex) {
        i++
        let inClass = false
        while (i < src.length) {
          if (src[i] === '\\') {
            i += 2
            continue
          }
          if (src[i] === '[') inClass = true
          else if (src[i] === ']') inClass = false
          else if (src[i] === '/' && !inClass) {
            i++
            while (i < src.length && /[a-z]/i.test(src[i])) i++
            break
          }
          i++
        }
        tokens.push({ type: 'regex', value: '/' })
        continue
      }
    }
    if (isIdentStart(c)) {
      let start = i
      i++
      while (i < src.length && isIdentPart(src[i])) i++
      tokens.push({ type: 'id', value: src.slice(start, i) })
      continue
    }
    if (c >= '0' && c <= '9') {
      while (i < src.length && /[0-9a-fA-FxXoObBn._]/.test(src[i])) i++
      tokens.push({ type: 'num', value: '0' })
      continue
    }
    if ((c === '=' && src[i + 1] === '=') || (c === '!' && src[i + 1] === '=') || (c === '&' && src[i + 1] === '&') || (c === '|' && src[i + 1] === '|')) {
      tokens.push({ type: 'punc', value: c })
      i += 2
      continue
    }
    tokens.push({ type: 'punc', value: c })
    i++
  }
  return tokens
}

function extractTopLevelDeclarations(src) {
  const tokens = tokenizeJs(src)
  const decls = []
  let brace = 0,
    paren = 0,
    bracket = 0

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.type === 'punc') {
      if (t.value === '{') brace++
      else if (t.value === '}') brace = Math.max(0, brace - 1)
      else if (t.value === '(') paren++
      else if (t.value === ')') paren = Math.max(0, paren - 1)
      else if (t.value === '[') bracket++
      else if (t.value === ']') bracket = Math.max(0, bracket - 1)
      continue
    }
    if (brace !== 0 || paren !== 0 || bracket !== 0) continue

    let exported = false
    let k = idx
    if (tokens[k].type === 'id' && tokens[k].value === 'export') {
      exported = true
      k++
      if (tokens[k]?.type === 'id' && tokens[k].value === 'default') k++
    }
    if (tokens[k]?.type === 'id' && tokens[k].value === 'async' && tokens[k + 1]?.type === 'id' && tokens[k + 1].value === 'function') {
      k++
    }
    const kw = tokens[k]
    if (!kw || kw.type !== 'id') continue

    if (kw.value === 'function' || kw.value === 'class') {
      const nameTok = tokens[k + 1]
      if (nameTok?.type === 'id') {
        decls.push({ name: nameTok.value, kind: kw.value, exported })
      }
      idx = k + 1
    } else if (kw.value === 'const' || kw.value === 'let' || kw.value === 'var') {
      let j = k + 1
      let dBrace = 0,
        dParen = 0,
        dBracket = 0
      let expectName = true
      while (j < tokens.length) {
        const tj = tokens[j]
        if (tj.type === 'punc') {
          if (tj.value === '{') dBrace++
          else if (tj.value === '}') dBrace = Math.max(0, dBrace - 1)
          else if (tj.value === '(') dParen++
          else if (tj.value === ')') dParen = Math.max(0, dParen - 1)
          else if (tj.value === '[') dBracket++
          else if (tj.value === ']') dBracket = Math.max(0, dBracket - 1)
        }
        if (dBrace === 0 && dParen === 0 && dBracket === 0) {
          if ( expectName && tj.type === 'id') {
            decls.push({ name: tj.value, kind: kw.value, exported })
            expectName = false
          } else if (tj.type === 'punc' && tj.value === ',') {
            expectName = true
          } else if (tj.type === 'punc' && tj.value === ';') {
            break
          } else if (
            !expectName &&
            tj.type === 'id' &&
            ['import', 'export', 'function', 'class', 'const', 'let', 'var', 'if', 'for', 'while', 'return', 'try', 'switch'].includes(tj.value)
          ) {
            j--
            break
          } else if (!expectName && tj.type === 'id' && tj.value === 'async' && tokens[j + 1]?.type === 'id' && tokens[j + 1].value === 'function') {
            j--
            break
          }
        }
        j++
      }
      idx = j
    }
  }
  return decls
}

test('no top-level or exported function/helper name in src/ is defined in more than one module', () => {
  const srcRoot = join(PACKAGE_ROOT, 'src')
  const files = listSourceFiles(srcRoot)
  const definitionsByName = new Map()

  for (const file of files) {
    const rel = relative(PACKAGE_ROOT, file).replaceAll('\\', '/')
    const decls = extractTopLevelDeclarations(readFileSync(file, 'utf8'))
    const seenInFile = new Set()
    for (const decl of decls) {
      if (seenInFile.has(decl.name)) continue
      seenInFile.add(decl.name)
      if (!definitionsByName.has(decl.name)) definitionsByName.set(decl.name, [])
      definitionsByName.get(decl.name).push({ file: rel, kind: decl.kind, exported: decl.exported })
    }
  }

  const duplicates = []
  for (const [name, locations] of [...definitionsByName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (locations.length > 1 && !ALLOWLIST.has(name)) {
      duplicates.push(`${name}: ${locations.map(loc => `${loc.file} (${loc.exported ? 'export ' : ''}${loc.kind})`).join(', ')}`)
    }
  }

  assert.deepEqual(duplicates, [], `Duplicate top-level definitions found across src/:\n${duplicates.join('\n')}`)
})
