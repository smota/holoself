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
  assert.equal(index.privacy_policy_version,3)
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

test('explicit sensitivity categories and task selectors narrow context fail closed',async()=>{
  const {self,project}=await linkedFixture()
  const categories=[
    ['compensation-confidential','Compensation marker'],
    ['third-party-personal','Third party marker'],
    ['recruiter-confidential','Recruiter marker'],
    ['employer-confidential','Employer marker'],
    ['application-private','Application marker']
  ]
  for(const [sensitivity,marker] of categories)await writeFile(join(self,'context',`${sensitivity}.md`),frontmatter({accessLenses:['general','career','publishing','technical','leadership','interview','private'],disclosure:'publish-approved',sensitivity})+`# ${marker}\n\n${marker}.\n`)
  await writeFile(join(self,'context','task-only.md'),'---\naccess_lenses: [career, private]\ndisclosure: review-required\nsensitivity: application-private\ndocument_role: content\ntask_include: [draft application]\ntask_exclude: [salary negotiation]\n---\n# Task only\n\ntaskonlymarker tailored material.\n')
  await writeFile(join(project,'Context','task-match.md'),'# Draft application\n\nProject-specific draft application evidence.\n');await writeFile(join(project,'Context','unrelated.md'),'# Unrelated\n\nOffice maintenance schedule.\n')
  const publishing=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])))
  for(const [sensitivity] of categories)assert.ok(!publishing.sources.some(source=>source.path===`context/${sensitivity}.md`),sensitivity)
  const career=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','career','--task','draft application','--json'])))
  for(const sensitivity of ['compensation-confidential','recruiter-confidential','employer-confidential','application-private'])assert.ok(career.sources.some(source=>source.path===`context/${sensitivity}.md`),sensitivity)
  assert.ok(!career.sources.some(source=>source.path==='context/third-party-personal.md'))
  assert.ok(career.sources.some(source=>source.path==='context/task-only.md'));assert.ok(career.sources.some(source=>source.path==='Context/task-match.md'));assert.ok(!career.sources.some(source=>source.path==='Context/unrelated.md'))
  const blocked=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','career','--task','salary negotiation','--json'])))
  assert.ok(!blocked.sources.some(source=>source.path==='context/task-only.md'));assert.equal(blocked.sources.filter(source=>source.kind==='project').length,0)
  assert.ok(blocked.restrictions.some(item=>item.source==='context/task-only.md'&&item.reason.includes('task selector')))
})

test('index schema tracks freshness and enforces post-build include/exclude assertions',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'Context'),{recursive:true});await mkdir(join(project,'Private'),{recursive:true})
  await writeFile(join(project,'Context','keep.md'),'# Keep\n\nfreshnessmarker one.\n');await writeFile(join(project,'Private','omit.md'),'# Omit\n\nforbiddenindexmarker.\n')
  await run(['link','add','--project',project,'--self',self,'--yes','--project-include','Context/**/*.md,Private/**/*.md','--project-exclude','Private/**','--project-assert-include','Context/**','--project-assert-exclude','Private/**'])
  await run(['index','rebuild','--project',project]);let index=JSON.parse(await readFile(join(project,'.holoself','index','index.json'),'utf8'))
  assert.equal(index.schema_version,4);assert.equal(index.privacy_policy_version,3);assert.equal(index.build_assertions.status,'passed');assert.ok(index.input_state_hash);assert.ok(!index.entries.some(entry=>entry.file==='Private/omit.md'))
  await writeFile(join(project,'Context','keep.md'),'# Keep\n\nfreshnessmarker two.\n')
  const stale=JSON.parse(await capture(()=>run(['index','status','--project',project])));assert.equal(stale.status,'stale');assert.equal(stale.fresh,false)
  const search=JSON.parse(await capture(()=>run(['search','freshnessmarker two','--project',project,'--lens','general'])));assert.ok(search.results.some(result=>result.source_file==='Context/keep.md'))
  index=JSON.parse(await readFile(join(project,'.holoself','index','index.json'),'utf8'));assert.notEqual(index.input_state_hash,stale.input_state_hash)
  const missing=await temp();await run(['link','add','--project',missing,'--self',self,'--yes','--project-assert-include','Required/**/*.md']);await assert.rejects(run(['index','rebuild','--project',missing]),/post-build assertions failed: assert_include unmatched/)
})

test('restricted-host snapshots carry expiry, source hashes, and leakage validation',async()=>{
  const {self,project}=await linkedFixture()
  await writeFile(join(self,'context','host-safe.md'),frontmatter({disclosure:'publish-approved',sensitivity:'public',role:'content'})+'# Host safe\n\nrestrictedhostmarker approved.\n')
  await writeFile(join(self,'context','host-private.md'),frontmatter({disclosure:'review-required',sensitivity:'application-private',role:'content'})+'# Host private\n\nrestrictedhostprivate marker.\n')
  const result=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json','--snapshot','--restricted-host','--expires-hours','2','--yes'])))
  assert.equal(result.packet_metadata.host_mode,'restricted-host-snapshot');assert.equal(result.validation.status,'passed')
  const snapshot=JSON.parse(await readFile(join(project,'.holoself','runtime','context-packet.md'),'utf8'))
  assert.match(snapshot.packet_metadata.packet_id,/^[0-9a-f-]{36}$/);assert.ok(Date.parse(snapshot.packet_metadata.expires_at)>Date.parse(snapshot.packet_metadata.generated_at));assert.equal(snapshot.packet_metadata.source_hash_algorithm,'sha256');assert.ok(snapshot.packet_metadata.source_hashes.every(source=>/^[0-9a-f]{64}$/.test(source.sha256)))
  assert.ok(snapshot.self.documents.some(document=>document.path==='context/host-safe.md'));assert.ok(!snapshot.self.documents.some(document=>document.path==='context/host-private.md'))
  await assert.rejects(run(['context','--project',project,'--snapshot','--expires-hours','0','--yes']),/expires-hours/)
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
