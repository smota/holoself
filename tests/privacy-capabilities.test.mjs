import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { ecosystemValidationErrors } from '../src/ecosystem.mjs'
import { activationPlan } from '../src/adapters.mjs'

async function temp(){return mkdtemp(join(tmpdir(),'holoself-policy-'))}
async function capture(fn){const old=console.log;let out='';console.log=(...x)=>{out+=x.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}
const frontmatter=({accessLenses=['publishing','private'],disclosure='internal-only',sensitivity='personal',role='content'})=>`---\naccess_lenses: [${accessLenses.join(', ')}]\ndisclosure: ${disclosure}\nsensitivity: ${sensitivity}\ndocument_role: ${role}\n---\n`

async function linkedFixture(){
  const self=await temp(),project=await temp()
  await run(['init','--root',self])
  await mkdir(join(project,'Context'),{recursive:true})
  await run(['link','add','--project',project,'--self',self,'--lens','publishing','--yes'])
  return {self,project}
}

test('publishing context includes internal policy but excludes unapproved evidence',async()=>{
  const {self,project}=await linkedFixture()
  await writeFile(join(self,'context','public-disclosure.md'),frontmatter({role:'policy',sensitivity:'employer-confidential'})+'# Disclosure policy\n\nNever name confidential employers.\n')
  await writeFile(join(self,'context','unapproved-evidence.md'),frontmatter({role:'evidence',disclosure:'review-required'})+'# Evidence\n\nInternal metric 47 percent.\n')
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])))
  const policy=data.self.documents.find(x=>x.path==='context/public-disclosure.md')
  assert.ok(policy)
  assert.equal(policy.metadata.document_role,'policy')
  assert.equal(policy.metadata.disclosure,'internal-only')
  assert.equal(policy.metadata.publication_allowed,false)
  assert.ok(!data.self.documents.some(x=>x.path==='context/unapproved-evidence.md'))
  assert.ok(data.restrictions.some(x=>x.source==='context/unapproved-evidence.md'&&x.reason.includes('not publish-approved')))
})

test('linked readability is not publication approval and personal sensitivity is not a read block',async()=>{
  const {self,project}=await linkedFixture()
  await writeFile(join(self,'context','legacy-linked.md'),'---\nvisibility: linked-projects\nsensitivity: personal\n---\n# Linked\n\nReadable internal guidance.\n')
  await writeFile(join(self,'context','approved-personal.md'),frontmatter({role:'content',disclosure:'publish-approved',sensitivity:'personal'})+'# Approved\n\nApproved personal wording.\n')
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])))
  const linked=data.self.documents.find(x=>x.path==='context/legacy-linked.md')
  const approved=data.self.documents.find(x=>x.path==='context/approved-personal.md')
  assert.ok(linked)
  assert.equal(linked.metadata.publication_allowed,false)
  assert.equal(linked.metadata.disclosure,'internal-only')
  assert.ok(data.restrictions.some(x=>x.source==='context/legacy-linked.md'&&x.reason.includes('not publication-approved')))
  assert.ok(approved)
  assert.equal(approved.metadata.sensitivity,'personal')
  assert.equal(approved.metadata.publication_allowed,true)
})

test('untagged canonical documents fail closed and validation reports them',async()=>{
  const {self,project}=await linkedFixture()
  await writeFile(join(self,'context','untagged.md'),'# Untagged\n\nMust not enter context.\n')
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])))
  assert.ok(!data.self.documents.some(x=>x.path==='context/untagged.md'))
  assert.ok(data.warnings.some(x=>x.includes('context/untagged.md: canonical privacy metadata missing')))
  assert.ok(ecosystemValidationErrors(self,project).some(x=>x.includes('canonical privacy metadata missing access_lenses or legacy visibility: context/untagged.md')))
})

test('incomplete or invalid canonical privacy metadata is excluded from context, index, and search',async()=>{
  const {self,project}=await linkedFixture()
  const cases=[
    ['missing-disclosure','access_lenses: [publishing, private]\nsensitivity: personal\ndocument_role: content'],
    ['missing-sensitivity','access_lenses: [publishing, private]\ndisclosure: publish-approved\ndocument_role: content'],
    ['missing-role','access_lenses: [publishing, private]\ndisclosure: publish-approved\nsensitivity: personal'],
    ['invalid-disclosure','access_lenses: [publishing, private]\ndisclosure: public\nsensitivity: personal\ndocument_role: content'],
    ['invalid-sensitivity','access_lenses: [publishing, private]\ndisclosure: publish-approved\nsensitivity: confidential\ndocument_role: content'],
    ['invalid-role','access_lenses: [publishing, private]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: claim']
  ]
  for(const [name,metadata] of cases)await writeFile(join(self,'context',`${name}.md`),`---\n${metadata}\n---\n# Quarantine marker\n\nquarantinemarker ${name}\n`)
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])))
  for(const [name] of cases){
    assert.ok(!data.self.documents.some(document=>document.path===`context/${name}.md`),name)
    assert.ok(data.warnings.some(warning=>warning.includes(`context/${name}.md`)),`${name} warning`)
  }
  await run(['index','rebuild','--project',project])
  const index=JSON.parse(await readFile(join(project,'.holoself','index','index.json'),'utf8'))
  assert.equal(index.privacy_policy_version,1)
  for(const [name] of cases){
    assert.ok(!index.entries.some(entry=>entry.source_kind==='self'&&entry.file===`context/${name}.md`),`${name} index`)
    assert.ok(index.warnings.some(warning=>warning.includes(`self:context/${name}.md`)),`${name} index warning`)
  }
  const search=JSON.parse(await capture(()=>run(['search','quarantinemarker','--project',project,'--lens','publishing'])))
  assert.deepEqual(search.results,[])
})

test('explicit public_safe false overrides and quarantines conflicting public-safe legacy metadata',async()=>{
  const {self,project}=await linkedFixture()
  await writeFile(join(self,'context','legacy-conflict.md'),'---\nvisibility: public-safe\npublic_safe: false\n---\n# Legacy conflict\n\nlegacyconflictmarker must stay private.\n')
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])))
  assert.ok(!data.self.documents.some(document=>document.path==='context/legacy-conflict.md'))
  assert.ok(data.warnings.some(warning=>warning.includes('conflicting legacy privacy metadata')))
  await run(['index','rebuild','--project',project])
  const index=JSON.parse(await readFile(join(project,'.holoself','index','index.json'),'utf8'))
  assert.ok(!index.entries.some(entry=>entry.file==='context/legacy-conflict.md'))
  assert.ok(index.warnings.some(warning=>warning.includes('conflicting legacy privacy metadata')))
  const search=JSON.parse(await capture(()=>run(['search','legacyconflictmarker','--project',project,'--lens','publishing'])))
  assert.deepEqual(search.results,[])
  assert.ok(ecosystemValidationErrors(self,project).some(error=>error.includes('conflicting legacy privacy metadata: visibility public-safe with public_safe false')))
})

test('startup adapters expose honest capability evidence in plans and runtime',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self])
  const plan=activationPlan(project,{activate:'all',installSkill:'none'})
  assert.ok(plan.adapters.length>0)
  for(const adapter of plan.adapters){
    assert.ok(['file','skill','manual-project-config','snapshot'].includes(adapter.delivery))
    assert.ok(['verified','configured','generated-only','unsupported'].includes(adapter.discovery))
    assert.ok(adapter.tested_product)
    assert.equal(typeof adapter.evidence,'string')
    assert.ok(adapter.evidence.length>20)
    assert.ok(Object.hasOwn(adapter,'tested_version'))
    assert.ok(Object.hasOwn(adapter,'last_verified'))
    assert.notEqual(adapter.support,'native')
  }
  await run(['link','add','--project',project,'--self',self,'--activate','all','--install-skill','none','--yes'])
  const runtime=JSON.parse(await readFile(join(project,'.holoself','runtime.json'),'utf8'))
  for(const adapter of runtime.activatedAdapters)for(const field of ['delivery','discovery','tested_product','tested_version','evidence','last_verified'])assert.ok(Object.hasOwn(adapter,field),`${adapter.id} missing ${field}`)
  await access(join(project,'AGENTS.md'))
})
