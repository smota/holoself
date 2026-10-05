#!/usr/bin/env node
import { resolve } from 'node:path'
import { validateSkillCatalog } from '../lib/skill-catalog.mjs'

const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const packageRoot = resolve(targetIndex >= 0 ? args[targetIndex + 1] : process.cwd())
const result = validateSkillCatalog({ packageRoot })

if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
else {
  process.stdout.write(`[validate-skill-catalog] ${result.ok ? 'READY' : 'FAILED'}\n`)
  for (const item of result.findings)
    process.stdout.write(`  ${item.severity.toUpperCase()} ${item.code}: ${item.message}\n`)
}

process.exit(result.ok ? 0 : 1)
