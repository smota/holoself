#!/usr/bin/env node
import { resolve } from 'node:path'
import { validateRoleCatalog } from '../lib/role-catalog.mjs'

const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const packageRoot = resolve(targetIndex >= 0 ? args[targetIndex + 1] : process.cwd())
const result = validateRoleCatalog({ packageRoot })
const output = {
  ok: result.ok,
  roles: result.catalog?.roles?.map((role) => role.qualifiedName) ?? [],
  methods: result.methodCatalog?.methods?.map((method) => method.id) ?? [],
  findings: result.findings,
}

if (args.includes('--json')) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
else {
  process.stdout.write(`[validate-role-catalog] ${output.ok ? 'READY' : 'FAILED'}\n`)
  for (const item of output.findings)
    process.stdout.write(`  ${item.severity.toUpperCase()} ${item.code}: ${item.message}\n`)
}
process.exit(output.ok ? 0 : 1)
