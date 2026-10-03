import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LENS_IDS, loadLensRegistry, saveCustomLens, removeCustomLens, saveLensInstructions, seedLensDefinitions } from '../src/lenses.mjs'
import { normalizeProjectPath, readBindings, writeBinding, resolveBinding } from '../src/bindings.mjs'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
const temp=()=>mkdtemp(join(tmpdir(),'holoself-lens-'))
const definition=id=>({schema_version:1,id,title:id,sensitivity_access:[],instructions:{purpose:'Synthetic perspective'}})
async function capture(fn){const old=console.log;let out='';console.log=(...args)=>out+=args.join(' ')+'\n';try{await fn();return out}finally{console.log=old}}
async function fixture(){const root=await temp(),project=await temp();await capture(()=>run(['init','--root',root]));await capture(()=>run(['link','add','--self',root,'--project',project,'--lens','general','--secondary-lenses','professional,public-voice','--yes','--no-activate']));return {root,project}}

test('reads never seed; init seeds uniform definitions and every definition can be edited',async()=>{
 const root=await temp();assert.deepEqual(loadLensRegistry(root).lenses,[]);seedLensDefinitions(root);const registry=loadLensRegistry(root);assert.deepEqual([...registry.byId.keys()].sort(),[...DEFAULT_LENS_IDS].sort());assert.ok(registry.lenses.every(lens=>!Object.hasOwn(lens,'source')&&!Object.hasOwn(lens,'base_lens')))
 const changed=saveLensInstructions(root,'professional',{purpose:'Reviewed purpose'},registry.registry_hash);assert.equal(changed.byId.get('professional').instructions.purpose,'Reviewed purpose');assert.notEqual(changed.registry_hash,registry.registry_hash)
 saveCustomLens(root,'general',definition('general'),changed.registry_hash);assert.equal(loadLensRegistry(root).byId.get('general').title,'general')
})
test('definitions validate fields, storage names, filenames, categories, duplicate IDs and stale edits',async()=>{
 const root=await temp();seedLensDefinitions(root);const registry=loadLensRegistry(root)
 for(const value of [{...definition('Bad_ID')},{...definition('bindings')},{...definition('spiritual'),base_lens:'general'},{...definition('spiritual'),sensitivity_access:['restricted']}])assert.throws(()=>saveCustomLens(root,value.id,value,registry.registry_hash))
 assert.throws(()=>saveCustomLens(root,'spiritual',definition('spiritual'),'stale'),/changed/)
 await writeFile(join(root,'lenses','wrong.json'),JSON.stringify(definition('spiritual')));assert.throws(()=>loadLensRegistry(root),/filename must match/)
})
test('bindings normalize Windows paths and reject malformed stores, collisions and private grants',async()=>{
 const root=await temp();seedLensDefinitions(root);assert.equal(normalizeProjectPath('C:\\Example\\Domain\\..\\Domain\\'),'c:/example/domain');assert.equal(normalizeProjectPath('C:/EXAMPLE/DOMAIN'),'c:/example/domain');assert.throws(()=>normalizeProjectPath('relative'),/absolute/)
 writeBinding(root,'C:/Example/Domain',{default_lens:'general',secondary_lenses:[]});assert.equal(resolveBinding(root,'c:\\example\\DOMAIN').default_lens,'general');assert.ok(!loadLensRegistry(root).byId.has('bindings'))
 assert.throws(()=>writeBinding(root,'C:/Example/Private',{default_lens:'private',secondary_lenses:[]}),/owner-exclusive/)
 assert.throws(()=>writeBinding(root,'C:/Example/Duplicates',{default_lens:'general',secondary_lenses:['general']}),/duplicate/)
 assert.throws(()=>writeBinding(root,'C:/Example/Unknown',{default_lens:'unknown',secondary_lenses:[]}),/unknown/)
 for(const value of ['{',JSON.stringify({schema_version:2,bindings:{}}),JSON.stringify({schema_version:1,bindings:{'C:/Example/Domain':{default_lens:'general',secondary_lenses:[]},'c:/example/domain':{default_lens:'professional',secondary_lenses:[]}}})]){await writeFile(join(root,'lenses','bindings.json'),value);assert.throws(()=>readBindings(root),/malformed|schema|conflicting/)}
})
test('binding CRUD controls context and attestation grants; unbound execution fails closed',async()=>{
 const {root,project}=await fixture();await capture(()=>run(['lens','bind','--root',root,'--project',project,'--lens','professional','--yes']));assert.equal(contextData({project,noCache:true}).lens,'professional');assert.deepEqual(readBindings(root).bindings[normalizeProjectPath(project)].secondary_lenses,[])
 assert.throws(()=>removeCustomLens(root,'professional',loadLensRegistry(root).registry_hash),/bound/)
 await capture(()=>run(['lens','unbind','--root',root,'--project',project,'--yes']));assert.throws(()=>contextData({project}),error=>error.code==='LENS_BINDING_REQUIRED'&&error.message.includes('lens bind'))
 const cwd=process.cwd();process.chdir(root);try{assert.equal(contextData({root,rootExplicit:true,lens:'private'}).lens,'private')}finally{process.chdir(cwd)}
})
test('repair migrates legacy choices, removes legacy fields and refuses a conflicting self choice',async()=>{
 const {root,project}=await fixture(),file=join(project,'.holoself','link.yaml'),original=await readFile(file,'utf8');writeBinding(root,project,null);await writeFile(file,original.replace('  access:', '  default_lens: career\n  secondary_lenses: [publishing]\n  access:'))
 await capture(()=>run(['link','repair','--project',project,'--yes','--no-activate']));assert.equal(resolveBinding(root,project).default_lens,'professional');assert.deepEqual(resolveBinding(root,project).secondary_lenses,['public-voice']);assert.doesNotMatch(await readFile(file,'utf8'),/default_lens|secondary_lenses/);assert.equal(contextData({project}).lens,'professional')
 await writeFile(file,original.replace('  access:','  default_lens: general\n  access:'));const before=await readFile(join(root,'lenses','bindings.json'),'utf8');await assert.rejects(run(['link','repair','--project',project,'--yes','--no-activate']),/conflicts/);assert.equal(await readFile(join(root,'lenses','bindings.json'),'utf8'),before)
})
test('public voice retrieves compensation and unapproved evidence; explicit private markers stay private',async()=>{
 const {root,project}=await fixture();await writeFile(join(root,'context','voice-evidence.md'),'---\naccess_lenses: [public-voice, private]\ndisclosure: review-required\nsensitivity: compensation-confidential\ndocument_role: evidence\n---\n# Salary evidence\n\nSalary: 123456.\n\n<!-- holoself-claim visibility=private -->\nPrivate claim sentinel.\n<!-- /holoself-claim -->\n');const data=contextData({project,lens:'public-voice',noCache:true});const doc=data.self.documents.find(doc=>doc.path==='context/voice-evidence.md');assert.ok(doc);assert.match(doc.content,/123456/);assert.doesNotMatch(doc.content,/Private claim sentinel/);assert.equal(doc.metadata.publication_allowed,false);assert.ok(!data.restrictions.some(r=>/compensation content|not publish-approved/.test(r.reason)))
})
test('bindings and definitions reject symlink storage',async()=>{
 const root=await temp(),outside=await temp();seedLensDefinitions(root);await writeFile(join(outside,'bindings.json'),'{}');try{await symlink(join(outside,'bindings.json'),join(root,'lenses','bindings.json'));assert.throws(()=>readBindings(root),/unsafe/)}catch(error){if(error.code!=='EPERM')throw error}
})

test('explicit attestation approves an existing binding and backfill writes missing salt to the project link',async()=>{
 const {root,project}=await fixture(),registryFile=join(root,'.holoself','links.json'),linkFile=join(project,'.holoself','link.yaml'),original=await readFile(linkFile,'utf8'),salt=original.match(/binding_salt: "([a-f0-9]+)"/)[1]
 await writeFile(registryFile,JSON.stringify({schema_version:1,links:[]}));assert.throws(()=>contextData({project}),/not attested/);await capture(()=>run(['link','approve','--project',project,'--self',root,'--yes']));let registry=JSON.parse(await readFile(registryFile,'utf8'));assert.equal(registry.links[0].binding_salt,salt);assert.deepEqual(registry.links[0].allowed_lenses,['general','professional','public-voice']);assert.ok(contextData({project}).self.documents.length>0);assert.doesNotMatch(await readFile(linkFile,'utf8'),/default_lens|secondary_lenses/)
 await writeFile(linkFile,original.replace(/^\s*binding_salt:.*\n/m,''));await capture(()=>run(['link','backfill','--project',project,'--self',root,'--yes']));registry=JSON.parse(await readFile(registryFile,'utf8'));assert.match(await readFile(linkFile,'utf8'),new RegExp(registry.links[0].binding_salt));assert.ok(contextData({project}).self.documents.length>0)
})
