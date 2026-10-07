import { normalizeProjectPath, writeBinding } from '../src/bindings.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, lstat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { run } from '../src/cli.mjs'
import { startWebServer } from '../src/web-server.mjs'

const temp=()=>mkdtemp(join(tmpdir(),'holoself-web-project-'))

test('Workbench can derive root and lens from optional linked project',async()=>{
  const self=await temp(),project=await temp()
  await run(['init','--root',self])
  await run(['link','add','--project',project,'--self',self,'--lens','professional','--no-activate','--yes'])
  const app=await startWebServer({project,port:0})
  try{
    const session=await (await fetch(`${app.url}/api/session`)).json()
    assert.equal(session.data.mode,'linked-project')
    assert.equal(session.data.project,resolve(project))
    assert.equal(session.data.root,resolve(self))
    assert.equal(session.data.lens,'professional')
  }finally{await new Promise(resolveClose=>app.server.close(resolveClose))}
})

test('Workbench launches from product cwd with explicit canonical root',async()=>{
  const self=await temp(),productCwd=await temp()
  await run(['init','--root',self])
  const app=await startWebServer({project:productCwd,root:self,port:0})
  try{
    const session=await (await fetch(`${app.url}/api/session`)).json()
    assert.equal(session.data.mode,'canonical-root')
    assert.equal(session.data.project,null)
    assert.equal(session.data.root,resolve(self))
    assert.equal(session.data.lens,null)
    assert.equal(session.data.rootExists,true)
  }finally{await new Promise(resolveClose=>app.server.close(resolveClose))}
})

test('Workbench exposes dynamic annotation schema and policy validation',async()=>{const self=await temp();await run(['init','--root',self]);const app=await startWebServer({root:self,port:0});try{const session=(await(await fetch(`${app.url}/api/session`)).json()).data,schema=(await(await fetch(`${app.url}/api/annotations/schema`)).json()).data;assert.equal(schema.fields.access_lenses.type,'multi-select');assert.ok(schema.fields.access_lenses.options.some(option=>option.value==='professional'));const response=await fetch(`${app.url}/api/annotations/validate`,{method:'POST',headers:{'content-type':'application/json','x-holoself-token':session.token},body:JSON.stringify({metadata:{access_lenses:['professional'],disclosure:'publish-approved',sensitivity:'compensation-confidential',document_role:'content'}})}),result=(await response.json()).data;assert.equal(response.status,200);assert.equal(result.valid,false);assert.match(result.errors.join(' '),/publish-approved/)}finally{await new Promise(resolveClose=>app.server.close(resolveClose))}})

test('Workbench discovers canonical linked projects and lazily browses local folders',async()=>{
  const self=await temp(),project=await temp(),productCwd=await temp()
  await mkdir(join(project,'nested-folder'))
  await run(['init','--root',self])
  await run(['link','add','--project',project,'--self',self,'--lens','professional','--no-activate','--yes'])
  await writeFile(join(self,'context','linked-projects.md'),`# Linked projects\n\n## Career-Assistant\n\n- Path: \`${project}\`\n- Lens: career\n`)
  const app=await startWebServer({project:productCwd,root:self,port:0})
  try{
    const spaces=await (await fetch(`${app.url}/api/spaces`)).json()
    const discovered=spaces.data.find(space=>normalizeProjectPath(space.path)===normalizeProjectPath(project))
    assert.equal(discovered.discoveredFrom,'lenses/bindings.json')
    assert.ok(['configured','activated','active'].includes(discovered.status.state))
    const listing=await (await fetch(`${app.url}/api/filesystem/folders?path=${encodeURIComponent(project)}`)).json()
    assert.ok(listing.data.folders.some(folder=>folder.name==='nested-folder'&&resolve(folder.path)===resolve(join(project,'nested-folder'))))
    const roots=await (await fetch(`${app.url}/api/filesystem/roots`)).json()
    assert.equal(roots.data.suggested[0].path,resolve(self))
  }finally{await new Promise(resolveClose=>app.server.close(resolveClose))}
})

test('Workbench requires explicit root when cwd has no project link',async()=>{
  const productCwd=await temp()
  await assert.rejects(startWebServer({project:productCwd,port:0}),/requires --root/)
})
test('Workbench detects legacy mount, suggests migration setup, and migrates to metadata link', async () => {
  const self = await temp(), project = await temp(), productCwd = await temp()
  await run(['init', '--root', self])
  writeBinding(self,project,{default_lens:'general',secondary_lenses:[]})
  await run(['link', '--root', self, '--target', project, '--yes'])
  assert.equal((await lstat(join(project, '.holoself'))).isSymbolicLink(), true)

  await writeFile(join(self, 'context', 'linked-projects.md'), `# Linked projects\n\n## Legacy-Project\n\n- Path: \`${project}\`\n- Lens: general\n`)

  const app = await startWebServer({ project: productCwd, root: self, port: 0 })
  try {
    const session = (await (await fetch(`${app.url}/api/session`)).json()).data
    const spacesRes = await (await fetch(`${app.url}/api/spaces`)).json()
    const space = spacesRes.data.find(s => normalizeProjectPath(s.path) === normalizeProjectPath(project))
    assert.ok(space)
    assert.equal(space.status.state, 'legacy-mount')
    assert.equal(space.status.mode, 'legacy-mount')
    assert.ok(space.corrections.some(c => c.id === 'setup'))

    const migrateRes = await fetch(`${app.url}/api/spaces/${space.id}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-holoself-token': session.token }
    })
    assert.equal(migrateRes.status, 200)

    assert.equal((await lstat(join(project, '.holoself'))).isSymbolicLink(), false)
    assert.equal((await lstat(join(project, '.holoself'))).isDirectory(), true)

    const updatedSpaces = await (await fetch(`${app.url}/api/spaces`)).json()
    const updated = updatedSpaces.data.find(s => normalizeProjectPath(s.path) === normalizeProjectPath(project))
    assert.equal(updated.status.mode, 'metadata-link')
  } finally {
    await new Promise(resolveClose => app.server.close(resolveClose))
  }
})

test('Workbench binding CRUD uses optimistic hashes and prunes the catalog after unbinding',async()=>{
 const self=await temp(),project=await temp();await run(['init','--root',self]);await run(['link','add','--project',project,'--self',self,'--lens','professional','--no-activate','--yes']);const app=await startWebServer({root:self,port:0})
 try{const session=(await(await fetch(app.url+'/api/session')).json()).data,headers={'content-type':'application/json','x-holoself-token':session.token},store=(await(await fetch(app.url+'/api/bindings')).json()).data
 const changed=await fetch(app.url+'/api/bindings',{method:'PUT',headers,body:JSON.stringify({project,default_lens:'public-voice',secondary_lenses:['general'],expectedHash:store.hash})});assert.equal(changed.status,200);const current=(await changed.json()).data;assert.equal(current.bindings[normalizeProjectPath(project)].default_lens,'public-voice')
 const stale=await fetch(app.url+'/api/bindings',{method:'DELETE',headers,body:JSON.stringify({project,expectedHash:store.hash})});assert.equal(stale.status,409);assert.equal((await(await fetch(app.url+'/api/spaces')).json()).data.length,1)
 const removed=await fetch(app.url+'/api/bindings',{method:'DELETE',headers,body:JSON.stringify({project,expectedHash:current.hash})});assert.equal(removed.status,200);assert.deepEqual((await(await fetch(app.url+'/api/spaces')).json()).data,[])
 }finally{await new Promise(done=>app.server.close(done))}
})

test('Workbench repair previews the plan and applies only a matching plan hash',async()=>{
  const self=await temp(),project=await temp()
  await run(['init','--root',self]);await mkdir(join(project,'.claude'))
  await run(['link','add','--project',project,'--self',self,'--activate','agents','--install-skill','none','--yes'])
  const app=await startWebServer({root:self,port:0})
  try{
    const session=(await(await fetch(`${app.url}/api/session`)).json()).data,headers={'content-type':'application/json','x-holoself-token':session.token}
    const space=(await(await fetch(`${app.url}/api/spaces`,{headers})).json()).data.find(item=>normalizeProjectPath(item.path)===normalizeProjectPath(project))
    const post=payload=>fetch(`${app.url}/api/spaces/${space.id}/repair`,{method:'POST',headers,body:JSON.stringify(payload)})
    const runtimeBefore=await readFile(join(project,'.holoself','runtime.json'),'utf8')
    const preview=(await(await post({})).json()).data.preview
    assert.equal(preview.plan.activation_plan.source,'recorded');assert.deepEqual(preview.plan.activation_plan.adapter_ids,['agents']);assert.match(preview.plan_hash,/^[0-9a-f]{64}$/)
    assert.equal(await readFile(join(project,'.holoself','runtime.json'),'utf8'),runtimeBefore);await assert.rejects(lstat(join(project,'CLAUDE.md')))
    const stale=await post({apply:true,plan_hash:'0'.repeat(64)});assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'PLAN_CHANGED')
    const missing=await post({apply:true});assert.equal(missing.status,409)
    const applied=await post({apply:true,plan_hash:preview.plan_hash});assert.equal(applied.status,200);assert.match((await applied.json()).data.output,/agents: AGENTS\.md/)
    await assert.rejects(lstat(join(project,'CLAUDE.md')))
  }finally{await new Promise(resolveClose=>app.server.close(resolveClose))}
})
