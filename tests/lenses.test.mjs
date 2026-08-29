import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_LENS_IDS, loadLensRegistry, resolveLens, saveLensInstructions } from '../src/lenses.mjs'
import { run } from '../src/cli.mjs'
import { ecosystemValidationErrors } from '../src/ecosystem.mjs'

const temp=()=>mkdtemp(join(tmpdir(),'holoself-lenses-'))
const definition=(id='spiritual',extra={})=>({schema_version:1,id,title:'Spiritual',base_lens:'general',...extra})
async function registryFile(root,name,value){await mkdir(join(root,'lenses'),{recursive:true});await writeFile(join(root,'lenses',name),typeof value==='string'?value:JSON.stringify(value))}
async function capture(fn){const old=console.log;let out='';console.log=(...args)=>{out+=args.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}

test('lens instruction overrides fine-tune built-ins without mutating definitions',async()=>{const root=await temp(),before=loadLensRegistry(root),career=before.byId.get('career');assert.match(career.instructions.purpose,/Career/);const next=saveLensInstructions(root,'career',{purpose:'Career decisions for regulated technology leadership',priorities:['evidence'],include:['leadership outcomes'],exclude:['unsupported claims'],response_guidance:['Use concise examples']},before.registry_hash);assert.equal(next.byId.get('career').source,'builtin');assert.equal(next.byId.get('career').instructions.purpose,'Career decisions for regulated technology leadership');assert.notEqual(next.registry_hash,before.registry_hash);await access(join(root,'lenses','instructions','career.json'))})

test('missing lens registry is valid, deterministic, and built-in only',async()=>{
  const a=loadLensRegistry(await temp()),b=loadLensRegistry(await temp())
  assert.deepEqual(a.lenses.map(x=>x.id),BUILTIN_LENS_IDS);assert.equal(a.registry_hash,b.registry_hash)
  assert.equal(resolveLens(a,'publishing').base_lens,'publishing');assert.throws(()=>resolveLens(a,'spiritual'),/unknown lens/)
})

test('custom lens registry resolves sorted definitions and hashes raw inputs',async()=>{
  const root=await temp();await registryFile(root,'z.json',definition('spiritual',{sensitivity_access:['employer-confidential']}));await registryFile(root,'a.json',definition('client-advisory',{title:'Client advisory',base_lens:'publishing'}))
  const first=loadLensRegistry(root);assert.deepEqual(first.custom.map(x=>x.id),['client-advisory','spiritual']);assert.equal(resolveLens(first,'spiritual').source,'registry')
  await registryFile(root,'z.json',JSON.stringify(definition('spiritual',{sensitivity_access:['employer-confidential']}),null,2));assert.notEqual(loadLensRegistry(root).registry_hash,first.registry_hash)
})

test('invalid custom lens definitions fail closed with file evidence',async()=>{
  const cases=[
    ['bad-json.json','{',/malformed JSON/],
    ['version.json',definition('versioned',{schema_version:2}),/schema_version/],
    ['id.json',definition('Bad_Id'),/lowercase kebab-case/],
    ['digit.json',definition('1bad'),/start with a letter/],
    ['long.json',definition(`a${'b'.repeat(40)}`),/at most 40/],
    ['reserved.json',definition('general'),/reserved/],
    ['title.json',definition('empty-title',{title:'  '}),/title/],
    ['base.json',definition('bad-base',{base_lens:'spiritual'}),/base_lens/],
    ['restricted.json',definition('restricted-lens',{sensitivity_access:['restricted']}),/restricted is not allowed/],
    ['unknown.json',definition('unknown-field',{extra:true}),/unknown field/]
  ]
  for(const [name,value,pattern] of cases){const root=await temp();await registryFile(root,name,value);assert.throws(()=>loadLensRegistry(root),pattern,name)}
})

test('duplicate ids and unsafe registry entries fail closed',async()=>{
  const duplicate=await temp();await registryFile(duplicate,'a.json',definition());await registryFile(duplicate,'b.json',definition());assert.throws(()=>loadLensRegistry(duplicate),/duplicate lens id/)
  const root=await temp(),outside=join(await temp(),'outside.json');await writeFile(outside,JSON.stringify(definition()));await mkdir(join(root,'lenses'));try{await symlink(outside,join(root,'lenses','linked.json'));assert.throws(()=>loadLensRegistry(root),/unsafe lens registry entry/)}catch(error){if(error.code!=='EPERM')throw error}
})

test('lens CLI is deterministic and read-only',async()=>{
  const root=await temp();await run(['init','--root',root]);await registryFile(root,'spiritual.json',definition());const before=(await readdir(root,{recursive:true})).sort()
  const listed=JSON.parse(await capture(()=>run(['lens','list','--root',root])));assert.equal(listed.lenses.at(-1).id,'spiritual');assert.equal(listed.lenses.length,8)
  const shown=JSON.parse(await capture(()=>run(['lens','show','spiritual','--root',root])));assert.equal(shown.lens.base_lens,'general')
  const valid=JSON.parse(await capture(()=>run(['lens','validate','--root',root])));assert.equal(valid.custom_lenses,1);assert.match(valid.registry_hash,/^[0-9a-f]{64}$/)
  await assert.rejects(run(['lens','show','unknown-lens','--root',root]),/unknown lens/)
  await assert.rejects(run(['lens','list','--root',join(await temp(),'missing')]),/invalid self root/)
  assert.deepEqual((await readdir(root,{recursive:true})).sort(),before)
})

test('custom context requires exact label and base publishing behavior still hardens output',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await registryFile(self,'client.json',definition('client-advisory',{title:'Client advisory',base_lens:'publishing'}))
  await writeFile(join(self,'context','base-only.md'),'---\naccess_lenses: [publishing]\ndisclosure: publish-approved\nsensitivity: public\ndocument_role: content\n---\n# Base only\n\nbaseonlymarker.\n')
  await writeFile(join(self,'context','custom.md'),'---\naccess_lenses: [client-advisory]\ndisclosure: publish-approved\nsensitivity: public\ndocument_role: content\n---\n# Custom\n\ncustommarker allowed.\nSalary: 123456.\n')
  await writeFile(join(self,'context','excluded.md'),'---\naccess_lenses: [client-advisory]\nexclude_lenses: [client-advisory]\ndisclosure: publish-approved\nsensitivity: public\ndocument_role: content\n---\n# Excluded\n\nexcludedcustommarker.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','client-advisory','--secondary-lenses','general','--no-activate','--yes'])
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.deepEqual(status.self_context.secondary_lenses,['general'])
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--json'])));assert.equal(data.lens,'client-advisory');assert.equal(data.lens_resolution.base_lens,'publishing');assert.equal(data.packet_metadata.schema_version,2)
  assert.ok(!data.self.documents.some(x=>x.path==='context/base-only.md'));assert.ok(!data.self.documents.some(x=>x.path==='context/excluded.md'));const custom=data.self.documents.find(x=>x.path==='context/custom.md');assert.ok(custom);assert.doesNotMatch(custom.content,/123456/)
  const packet=await capture(()=>run(['context','--project',project,'--format','packet']));assert.match(packet,/Lens base: publishing/)
})

test('semantic unknown lens references fail before writes and quarantine canonical metadata',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await writeFile(join(self,'context','unknown.md'),'---\naccess_lenses: [unknown-shaped]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Unknown\n\nunknownmarker.\n')
  await assert.rejects(run(['link','add','--project',project,'--self',self,'--lens','unknown-shaped','--no-activate','--yes']),/invalid default lens/);await assert.rejects(access(join(project,'.holoself')))
  await registryFile(self,'spiritual.json',definition());await run(['link','add','--project',project,'--self',self,'--lens','general','--secondary-lenses','spiritual','--no-activate','--yes'])
  await assert.rejects(run(['context','--project',project,'--lens','unknown-shaped','--json']),/unknown lens/);await assert.rejects(run(['search','unknownmarker','--project',project,'--lens','unknown-shaped']),/unknown lens/)
  const errors=ecosystemValidationErrors(self,project);assert.ok(errors.some(error=>error.includes('invalid access_lenses value')&&error.includes('context/unknown.md')))
})

test('invalid registry blocks link creation before project writes',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await registryFile(self,'bad.json','{')
  await assert.rejects(run(['link','add','--project',project,'--self',self,'--no-activate','--yes']),/malformed JSON/);await assert.rejects(access(join(project,'.holoself')))
})

test('custom sensitivity is explicit, restricted denied, and registry changes stale the index',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);const def=definition('spiritual',{sensitivity_access:['employer-confidential']});await registryFile(self,'spiritual.json',def)
  const meta=sensitivity=>`---\naccess_lenses: [spiritual]\ndisclosure: internal-only\nsensitivity: ${sensitivity}\ndocument_role: content\n---\n`
  await writeFile(join(self,'context','employer.md'),meta('employer-confidential')+'# Employer\n\nemployermarker.\n');await writeFile(join(self,'context','restricted.md'),meta('restricted')+'# Restricted\n\nrestrictedmarker.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','spiritual','--no-activate','--yes']);const data=JSON.parse(await capture(()=>run(['context','--project',project,'--json'])));assert.ok(data.self.documents.some(x=>x.path==='context/employer.md'));assert.ok(!data.self.documents.some(x=>x.path==='context/restricted.md'))
  await registryFile(self,'default-sensitive.json',definition('default-sensitive'));await writeFile(join(self,'context','default-policy.md'),'---\naccess_lenses: [default-sensitive]\ndisclosure: internal-only\nsensitivity: employer-confidential\ndocument_role: policy\n---\n# Default policy\n\ndefaultsensitivepolicy.\n')
  const denied=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','default-sensitive','--json'])));assert.ok(!denied.self.documents.some(x=>x.path==='context/default-policy.md'));assert.ok(denied.restrictions.some(x=>x.source==='context/default-policy.md'&&x.reason.includes('sensitivity employer-confidential')))
  await run(['index','rebuild','--project',project]);let index=JSON.parse(await readFile(join(project,'.holoself','index','index.json'),'utf8'));assert.equal(index.schema_version,5);assert.equal(index.privacy_policy_version,4);const prior=index.lens_registry_hash
  await registryFile(self,'spiritual.json',JSON.stringify(def,null,2));const status=JSON.parse(await capture(()=>run(['index','status','--project',project])));assert.equal(status.status,'stale');assert.notEqual(status.lens_registry_hash,prior)
  await capture(()=>run(['search','employermarker','--project',project,'--lens','spiritual']));index=JSON.parse(await readFile(join(project,'.holoself','index','index.json'),'utf8'));assert.notEqual(index.lens_registry_hash,prior)
})
