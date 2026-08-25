import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { run } from '../src/cli.mjs'
import { startWebServer } from '../src/web-server.mjs'

const temp=()=>mkdtemp(join(tmpdir(),'holoself-web-project-'))

test('Workbench can derive root and lens from optional linked project',async()=>{
  const self=await temp(),project=await temp()
  await run(['init','--root',self])
  await run(['link','add','--project',project,'--self',self,'--lens','career','--no-activate','--yes'])
  const app=await startWebServer({project,port:0})
  try{
    const session=await (await fetch(`${app.url}/api/session`)).json()
    assert.equal(session.data.mode,'linked-project')
    assert.equal(session.data.project,resolve(project))
    assert.equal(session.data.root,resolve(self))
    assert.equal(session.data.lens,'career')
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

test('Workbench exposes dynamic annotation schema and policy validation',async()=>{const self=await temp();await run(['init','--root',self]);const app=await startWebServer({root:self,port:0});try{const session=(await(await fetch(`${app.url}/api/session`)).json()).data,schema=(await(await fetch(`${app.url}/api/annotations/schema`)).json()).data;assert.equal(schema.fields.access_lenses.type,'multi-select');assert.ok(schema.fields.access_lenses.options.some(option=>option.value==='career'));const response=await fetch(`${app.url}/api/annotations/validate`,{method:'POST',headers:{'content-type':'application/json','x-holoself-token':session.token},body:JSON.stringify({metadata:{access_lenses:['career'],disclosure:'publish-approved',sensitivity:'compensation-confidential',document_role:'content'}})}),result=(await response.json()).data;assert.equal(response.status,200);assert.equal(result.valid,false);assert.match(result.errors.join(' '),/publish-approved/)}finally{await new Promise(resolveClose=>app.server.close(resolveClose))}})

test('Workbench discovers canonical linked projects and lazily browses local folders',async()=>{
  const self=await temp(),project=await temp(),productCwd=await temp()
  await mkdir(join(project,'nested-folder'))
  await run(['init','--root',self])
  await run(['link','add','--project',project,'--self',self,'--lens','career','--no-activate','--yes'])
  await writeFile(join(self,'context','linked-projects.md'),`# Linked projects\n\n## Career-Assistant\n\n- Path: \`${project}\`\n- Lens: career\n`)
  const app=await startWebServer({project:productCwd,root:self,port:0})
  try{
    const spaces=await (await fetch(`${app.url}/api/spaces`)).json()
    const discovered=spaces.data.find(space=>resolve(space.path)===resolve(project))
    assert.equal(discovered.discoveredFrom,'context/linked-projects.md')
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
