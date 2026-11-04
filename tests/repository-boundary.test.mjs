import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))
const lock = JSON.parse(readFileSync(join(root, 'agent-framework-lock.json'), 'utf8'))
const lockTargets = new Set(lock.entries.map(entry => entry.target))

function listSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/i.test(entry.name)) out.push(full)
  }
  return out
}

function extractModuleSpecifiers(code) {
  const specifiers = []
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

test('product modules under bin/, src/, and web/ do not import from AgentFlow paths', () => {
  const productDirs = ['bin', 'src', 'web'].map(dir => join(root, dir))
  const files = productDirs.flatMap(dir => listSourceFiles(dir))
  assert.ok(files.length > 0, 'expected product source files')

  const forbiddenTopDirs = new Set(['lib', 'adapters', 'roles', '.agentflow'])
  const violations = []

  for (const file of files) {
    const relFile = relative(root, file).replace(/\\/g, '/')
    const code = readFileSync(file, 'utf8')
    for (const spec of extractModuleSpecifiers(code)) {
      if (spec.startsWith('.')) {
        const resolved = resolve(dirname(file), spec)
        const relTarget = relative(root, resolved).replace(/\\/g, '/')
        const firstSeg = relTarget.split('/')[0]
        if (
          forbiddenTopDirs.has(firstSeg) ||
          lockTargets.has(relTarget) ||
          lockTargets.has(`${relTarget}.mjs`) ||
          lockTargets.has(`${relTarget}.js`)
        ) {
          violations.push(`${relFile} -> ${spec} (${relTarget})`)
        }
      } else {
        const normalized = posix.normalize(spec).replace(/^\.\//, '')
        const firstSeg = normalized.split('/')[0]
        if (forbiddenTopDirs.has(firstSeg) || lockTargets.has(normalized)) {
          violations.push(`${relFile} -> ${spec}`)
        }
      }
    }
  }

  assert.deepEqual(violations, [])
})

test('every path in package.json files is not an AgentFlow-managed target and not under lib/', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0)

  const violations = []
  for (const entry of pkg.files) {
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (
      normalized === 'lib' ||
      normalized.startsWith('lib/') ||
      lockTargets.has(normalized)
    ) {
      violations.push(entry)
    }
  }

  assert.deepEqual(violations, [])
})

test('docs/repository-map.md covers every tracked top-level path and every named top-level entry exists', () => {
  const mapText = readFileSync(join(root, 'docs', 'repository-map.md'), 'utf8')
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')

  const namedTopLevel = new Set()
  for (const match of mapText.matchAll(/^\|\s*`([^`|\n]+)`\s*\|/gm)) {
    const raw = match[1].trim().replace(/\/+$/, '')
    if (raw && !raw.includes('/')) {
      namedTopLevel.add(raw)
    }
  }
  assert.ok(namedTopLevel.size > 0, 'expected top-level paths in docs/repository-map.md table')

  const missingOnDisk = []
  for (const name of namedTopLevel) {
    const exists = existsSync(join(root, name))
    const ignored = gitignore.split(/\r?\n/).some(line => line.trim().replace(/^\/+|\/+$/g, '') === name)
    if (!exists && !ignored) {
      missingOnDisk.push(name)
    }
  }
  assert.deepEqual(missingOnDisk, [])

  const trackedTopLevel = new Set(
    execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.split('/')[0])
  )
  const unmappedTracked = [...trackedTopLevel].filter(seg => !namedTopLevel.has(seg)).sort()
  assert.deepEqual(unmappedTracked, [])
})

test('docs/README.md links every file in docs/decisions/', () => {
  const readmeText = readFileSync(join(root, 'docs', 'README.md'), 'utf8')
  const linkedDecisions = new Set()
  for (const match of readmeText.matchAll(/\[[^\]]+\]\((decisions\/[^)#\s]+)(?:#[^)]*)?\)/g)) {
    linkedDecisions.add(match[1])
  }

  const decisionFiles = readdirSync(join(root, 'docs', 'decisions'))
    .filter(name => name.endsWith('.md'))
    .map(name => `decisions/${name}`)
    .sort()

  assert.ok(decisionFiles.length > 0, 'expected files in docs/decisions/')
  const unlinked = decisionFiles.filter(file => !linkedDecisions.has(file))
  assert.deepEqual(unlinked, [])
})
