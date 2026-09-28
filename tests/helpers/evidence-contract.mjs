// Test-only contract oracle. Never imported by product runtime.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
export const hash = value => createHash('sha256').update(value).digest('hex')
const schemas = new Map(['evidence-v1.schema.json','coaching-v1.schema.json','proposal.schema.json'].map(name => [name,JSON.parse(readFileSync(new URL(`../../schemas/${name}`,import.meta.url)))]))
const supported = new Set(['$schema','$id','title','$defs','$ref','type','additionalProperties','required','properties','oneOf','anyOf','allOf','not','if','then','else','const','enum','format','pattern','minLength','maxLength','minimum','exclusiveMinimum','minItems','uniqueItems','items'])
export function validate(value, name, schema = schemas.get(name)) {
  // Existing proposal schema has a misplaced target keyword inside source_files.
  // JSON Schema treats that unknown keyword as annotation; preserve that baseline.
  const legacySourceFiles = schemas.get('proposal.schema.json').allOf[0].then.properties.source_files
  for (const key of Object.keys(schema)) if (!supported.has(key) && !(schema === legacySourceFiles && key === 'target')) throw new Error(`Unsupported test validator keyword: ${key}`)
  const check = (v,s) => validate(v,name,s)
  if (schema.$ref) {
    const [file, fragment] = schema.$ref.split('#'), document = schemas.get(file || name)
    if (!document) throw new Error(`Unknown schema: ${file}`)
    const target = (fragment || '').split('/').filter(Boolean).reduce((node,key)=>node[key.replaceAll('~1','/').replaceAll('~0','~')],document)
    if (!target) throw new Error(`Unknown reference: ${schema.$ref}`)
    return validate(value,file || name,target)
  }
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b)
  if ('const' in schema && !equal(value,schema.const)) return false
  if (schema.enum && !schema.enum.some(item=>equal(value,item))) return false
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type && !(schema.type === 'integer' ? Number.isInteger(value) : type === schema.type)) return false
  if (schema.oneOf && schema.oneOf.filter(s=>check(value,s)).length !== 1) return false
  if (schema.anyOf && !schema.anyOf.some(s=>check(value,s))) return false
  if (schema.allOf && !schema.allOf.every(s=>check(value,s))) return false
  if (schema.not && check(value,schema.not)) return false
  if (schema.if) { const branch = check(value,schema.if) ? schema.then : schema.else; if (branch && !check(value,branch)) return false }
  if (type === 'object') {
    if (schema.required?.some(key=>!Object.hasOwn(value,key))) return false
    if (schema.additionalProperties === false && Object.keys(value).some(key=>!Object.hasOwn(schema.properties || {},key))) return false
    for (const [key,s] of Object.entries(schema.properties || {})) if (Object.hasOwn(value,key) && !check(value[key],s)) return false
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false
    if (schema.uniqueItems && new Set(value.map(v=>JSON.stringify(v))).size !== value.length) return false
    if (schema.items && !value.every(v=>check(v,schema.items))) return false
  }
  if (type === 'number' && ((!Number.isFinite(value)) || schema.minimum !== undefined && value < schema.minimum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)) return false
  if (type === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return false
    if (schema.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value)))) return false
  }
  return true
}
export function extractionErrors(extraction, goldenUnits, semantics = null, assets = new Map()) {
  const errors = [], ids = extraction.blocks.map(b=>b.id), units = extraction.coverage.map(c=>c.unit_id)
  if (new Set(ids).size !== ids.length) errors.push('duplicate-block')
  if (new Set(units).size !== units.length) errors.push('duplicate-unit')
  if (JSON.stringify([...units].sort()) !== JSON.stringify([...goldenUnits].sort())) errors.push('golden-coverage')
  for (const row of extraction.coverage) if (row.block_ids.some(id=>!ids.includes(id))) errors.push('dangling-coverage')
  for (const block of extraction.blocks) {
    if (!extraction.coverage.some(row=>row.block_ids.includes(block.id))) errors.push('unaccounted-block')
    if (hash(block.content) !== block.content_sha256) errors.push('content-hash')
    if (block.relations.some(relation=>!ids.includes(relation.target))) errors.push('dangling-relation')
    if (block.asset_path && (!assets.has(block.asset_path) || hash(assets.get(block.asset_path)) !== block.asset_sha256)) errors.push('asset-integrity')
    const loc = block.locator, bounds = loc.bounds
    if (loc.format === 'markdown' && loc.line_end < loc.line_start) errors.push('line-order')
    if (bounds && (bounds.x + bounds.width > bounds.page_width || bounds.y + bounds.height > bounds.page_height)) errors.push('page-bounds')
  }
  if (extraction.coverage.some(row=>row.disposition !== 'extracted') && !extraction.limitations.length) errors.push('hidden-gap')
  if (semantics) {
    const blocksFor = unit => extraction.coverage.find(row=>row.unit_id===unit)?.block_ids || []
    for (const [unit,type,target] of semantics.relations) {
      const related = extraction.blocks.filter(b=>blocksFor(unit).includes(b.id)).flatMap(b=>b.relations.filter(r=>r.type===type).map(r=>r.target))
      const wanted = blocksFor(target)
      if (!related.length || !wanted.length || related.some(id=>!wanted.includes(id))) errors.push('golden-relation')
    }
    for (const [unit,role,label] of semantics.attributions) {
      const found=extraction.blocks.filter(b=>blocksFor(unit).includes(b.id)).flatMap(b=>(b.attributions || []).filter(a=>a.role===role))
      if (!found.length || found.some(a=>a.label!==label)) errors.push('golden-attribution')
    }
    if (semantics.limitations.some(limit=>!extraction.limitations.includes(limit))) errors.push('golden-limitation')
  }
  return errors
}
export function referenceValid(ref, extraction, policyRevision) {
  const block = extraction.blocks.find(item=>item.id === ref.block_id)
  return Boolean(block && ref.source_id === extraction.source_id && ref.revision_id === extraction.revision_id && ref.extraction_id === extraction.id && ref.block_sha256 === block.content_sha256 && ref.asset_sha256 === block.asset_sha256 && JSON.stringify(ref.locator) === JSON.stringify(block.locator) && extraction.policy_revision === policyRevision && !['pending','failed','stale'].includes(extraction.state))
}
export function coachingErrors(record) {
  const allowed = {question:['question_state'],session:['observations','method_ids'],action:['session_id','action_state','confirmation'],review:['action_id','execution_report','outcome_state','verification']}
  const optional = Object.values(allowed).flat(), errors = []
  for (const key of optional) if (key in record && !allowed[record.kind].includes(key)) errors.push('wrong-kind-field')
  if (record.kind === 'question' && record.question_id !== record.id) errors.push('question-identity')
  for (const field of ['confirmation','verification']) if (record[field]) {
    const {confirmation,verification,...body} = record
    if (record[field].record_sha256 !== hash(JSON.stringify(body))) errors.push('stale-decision')
  }
  return errors
}
export function attachmentValid(attachment, proposal, interpretation) {
  const changes = proposal.changes || [{change_id:'claim',claim:proposal.claim}]
  if (attachment.proposal_id !== proposal.proposal_id || attachment.proposal_sha256 !== hash(JSON.stringify(proposal)) || attachment.interpretation_id !== interpretation.id) return false
  if (interpretation.state !== 'proposed' || interpretation.proposal_id !== proposal.proposal_id) return false
  if (attachment.changes.length !== changes.length || new Set(attachment.changes.map(c=>c.change_id)).size !== changes.length) return false
  return attachment.changes.every(binding => {
    const change=changes.find(c=>c.change_id===binding.change_id), claim=interpretation.claims.find(c=>c.id===binding.claim_id)
    return change && claim && change.claim === claim.text && JSON.stringify(binding.references) === JSON.stringify(claim.references) && JSON.stringify(binding.limitations) === JSON.stringify(interpretation.limitations)
  })
}
export function coachingCycleErrors(records) {
  const errors=[], byId=new Map(records.map(r=>[r.id,r]))
  if(byId.size!==records.length)errors.push('duplicate-record')
  for(const record of records) {
    errors.push(...coachingErrors(record))
    const question=byId.get(record.question_id)
    if(!question || question.kind!=='question')errors.push('question-parent')
    const parentField={action:'session_id',review:'action_id'}[record.kind]
    if(parentField) {
      const parent=byId.get(record[parentField]), kind=record.kind==='action'?'session':'action'
      if(!parent || parent.kind!==kind)errors.push('cycle-parent')
      else if(parent.question_id!==record.question_id)errors.push('question-ancestry')
    }
  }
  return errors
}
