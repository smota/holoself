#!/usr/bin/env node
import { resolve, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { validateSkillCatalog, loadSkillCatalog } from '../lib/skill-catalog.mjs'

const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const packageRoot = resolve(targetIndex >= 0 ? args[targetIndex + 1] : process.cwd())
const result = validateSkillCatalog({ packageRoot })

const schemaPath = join(packageRoot, 'schemas/skill-catalog.schema.json')
if (existsSync(schemaPath)) {
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
    const catalog = loadSkillCatalog(packageRoot)
    const ajv = new Ajv2020({ allErrors: true })
    const validate = ajv.compile(schema)
    const valid = validate(catalog)
    if (!valid) {
      result.ok = false
      for (const err of validate.errors || []) {
        result.findings.push({
          severity: 'blocker',
          code: 'catalog.schema',
          message: `${err.instancePath || '/'}: ${err.message}`,
        })
      }
    }
  } catch (error) {
    result.ok = false
    result.findings.push({
      severity: 'blocker',
      code: 'catalog.schema-error',
      message: error.message,
    })
  }
}

if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
else {
  process.stdout.write(`[validate-skill-catalog] ${result.ok ? 'READY' : 'FAILED'}\n`)
  for (const item of result.findings)
    process.stdout.write(`  ${item.severity.toUpperCase()} ${item.code}: ${item.message}\n`)
}

process.exit(result.ok ? 0 : 1)
