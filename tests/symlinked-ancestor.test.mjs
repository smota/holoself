import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { loadLensRegistry } from '../src/lenses.mjs'
import { readBindings } from '../src/bindings.mjs'
import { readDocument } from '../src/documents.mjs'
import { buildTransformationPlan } from '../src/maintenance.mjs'
import { canonicalPath, linkBelow } from '../src/path-guard.mjs'

// Reproduces macOS, where os.tmpdir() lives under /var -> /private/var: the
// self root and project sit below a symlinked ancestor the user did not choose.
async function capture(fn){const old=console.log;let out='';console.log=(...x)=>{out+=x.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}
function linkedParent(){
  const base=mkdtempSync(join(tmpdir(),'holoself-symlinked-ancestor-')),real=join(base,'real'),link=join(base,'link');mkdirSync(real)
  try{symlinkSync(real,link,'junction')}catch(error){if(error.code==='EPERM')return null;throw error}
  return {base,real,link}
}

test('self root and linked project below a symlinked ancestor work end to end',async t=>{
  const env=linkedParent();if(!env)return t.skip('symlinks unavailable')
  const self=join(env.link,'self'),project=join(env.link,'proj');mkdirSync(project)
  writeFileSync(join(project,'README.md'),'# Project\n\nSymlinked ancestor workspace.\n')
  await capture(()=>run(['init','--root',self]))
  assert.equal(existsSync(join(env.real,'self','profile')),true)
  writeFileSync(join(self,'context','career.md'),'---\nvisibility: professional\npublic_safe: false\n---\n# Career\n\nLed 20 engineers in regulated AI.\n')
  assert.ok(loadLensRegistry(self))
  await capture(()=>run(['lens','validate','--root',self]))
  await capture(()=>run(['link','add','--project',project,'--self',self,'--lens','professional','--install-skill','none','--yes']))
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project])))
  assert.equal(status.state,'activated');assert.equal(status.self_exists,true)
  await capture(()=>run(['link','deactivate','--project',project,'--yes']))
  await capture(()=>run(['link','activate','--project',project,'--install-skill','none','--yes']))
  assert.equal(JSON.parse(await capture(()=>run(['link','status','--project',project]))).state,'activated')
  // The same project reached by its canonical spelling resolves the same binding.
  for(const spelling of [project,realpathSync(project)]){
    const packet=JSON.parse(await capture(()=>run(['context','--project',spelling,'--lens','professional','--json'])))
    assert.equal(packet.lens,'professional');assert.ok(packet.self.documents.some(doc=>doc.content.includes('Led 20 engineers')))
  }
  const made=JSON.parse(await capture(()=>run(['propose','--project',project,'--claim','Prefers evidence-first writing.','--source-file','README.md','--target-file','context/claims.md','--proposal-type','fact_update','--confidence','confirmed','--visibility','private'])))
  const listed=await capture(()=>run(['proposals','list','--project',project]));assert.match(listed,new RegExp(made.proposal_id))
  await capture(()=>run(['proposals','approve',made.proposal_id,'--project',project,'--yes']))
  assert.match(readFileSync(join(env.real,'self','context','claims.md'),'utf8'),/Prefers evidence-first writing/)
  assert.match(readDocument(self,'context/career.md').content,/Led 20 engineers/)
  assert.ok(buildTransformationPlan(self,[{path:'context/career.md',after:'# Career\n\nUpdated.\n'}]))
  rmSync(env.base,{recursive:true,force:true})
})

test('symlinks at or below the trust boundary still fail closed under a symlinked ancestor',async t=>{
  const env=linkedParent();if(!env)return t.skip('symlinks unavailable')
  const self=join(env.link,'self'),outside=mkdtempSync(join(tmpdir(),'holoself-symlinked-outside-'))
  await capture(()=>run(['init','--root',self]))
  writeFileSync(join(outside,'secret.md'),'# Outside\n')
  // context/ replaced by a link below the root
  rmSync(join(self,'context'),{recursive:true});symlinkSync(outside,join(self,'context'),'junction')
  assert.throws(()=>readDocument(self,'context/secret.md'),/symlink/)
  assert.throws(()=>buildTransformationPlan(self,[{path:'context/secret.md',after:'x'}]),/unsafe maintenance path/)
  assert.equal(linkBelow(self,join(self,'context','secret.md')),join(self,'context'))
  // a symlinked lens registry and bindings file below the root
  const lensesOutside=join(outside,'lenses');mkdirSync(lensesOutside);rmSync(join(self,'lenses'),{recursive:true,force:true});symlinkSync(lensesOutside,join(self,'lenses'),'junction')
  assert.throws(()=>loadLensRegistry(self),/unsafe lens registry directory/)
  assert.throws(()=>readBindings(self,{registry:{}}),/unsafe bindings path/)
  // the boundary itself as a link still fails closed
  const aliased=join(env.base,'self-alias');symlinkSync(join(env.real,'self'),aliased,'junction')
  assert.throws(()=>loadLensRegistry(aliased),/unsafe lens root/)
  // canonicalisation tolerates roots that do not exist yet
  assert.equal(canonicalPath(join(env.link,'missing','child')),join(realpathSync(env.real),'missing','child'))
  rmSync(env.base,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})
})
