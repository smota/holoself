import { planSpaceAction, applySpaceAction } from '../src/space-actions.mjs'
import { readdirSync, lstatSync, readFileSync, readlinkSync, realpathSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs'
import { normalizeProjectPath, writeBinding } from '../src/bindings.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, lstat, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { run } from '../src/cli.mjs'
import { startWebServer as startServer, scrubMessage } from '../src/web-server.mjs'

const BIN=fileURLToPath(new URL('../bin/holoself.mjs',import.meta.url))

const temp=()=>mkdtemp(join(tmpdir(),'holoself-web-project-'))
// Every Workbench API route requires the session token and mutations require a loopback Origin, as the served page sends them.
const tokens=new Map()
async function startWebServer(options){const app=await startServer(options);tokens.set(app.url,app.token);return app}
const fetch=(url,options={})=>{const origin=new URL(url).origin;return globalThis.fetch(url,{...options,headers:{'x-holoself-token':tokens.get(origin),origin,...options.headers}})}

test('Workbench can derive root and lens from optional linked project',async()=>{
  const self=await temp(),project=await temp()
  await run(['init','--root',self])
  await run(['link','add','--project',project,'--self',self,'--lens','professional','--no-activate','--yes'])
  const app=await startWebServer({project,port:0})
  try{
    const session=await (await fetch(`${app.url}/api/session`)).json()
    assert.equal(session.data.mode,'linked-project')
    assert.equal(realpathSync(session.data.project),realpathSync(project))
    assert.equal(realpathSync(session.data.root),realpathSync(self))
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

test('Workbench exposes dynamic annotation schema and policy validation',async()=>{const self=await temp();await run(['init','--root',self]);const app=await startWebServer({root:self,port:0});try{const session=(await(await fetch(`${app.url}/api/session`)).json()).data,schema=(await(await fetch(`${app.url}/api/annotations/schema`)).json()).data;assert.equal(schema.fields.access_lenses.type,'multi-select');assert.ok(schema.fields.access_lenses.options.some(option=>option.value==='professional'));const response=await fetch(`${app.url}/api/annotations/validate`,{method:'POST',headers:{'content-type':'application/json','x-holoself-token':app.token},body:JSON.stringify({metadata:{access_lenses:['professional'],disclosure:'publish-approved',sensitivity:'compensation-confidential',document_role:'content'}})}),result=(await response.json()).data;assert.equal(response.status,200);assert.equal(result.valid,false);assert.match(result.errors.join(' '),/publish-approved/)}finally{await new Promise(resolveClose=>app.server.close(resolveClose))}})

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
      headers: { 'content-type': 'application/json', 'x-holoself-token': app.token }
    })
    assert.equal(migrateRes.status, 200)
    const migrationPreview=(await migrateRes.json()).data.preview,canonicalBefore=tree(self)
    assert.equal((await lstat(join(project,'.holoself'))).isSymbolicLink(),true)
    const applied=await fetch(`${app.url}/api/spaces/${space.id}/setup`,{method:'POST',headers:{'content-type':'application/json','x-holoself-token':app.token},body:JSON.stringify({apply:true,plan_hash:migrationPreview.plan_hash})})
    assert.equal(applied.status,200,JSON.stringify(await applied.json()))
    const canonicalAfter=tree(self);for(const key of Object.keys(canonicalBefore))if(!key.startsWith('/.holoself')&&key!=='/lenses/bindings.json')assert.deepEqual(canonicalAfter[key],canonicalBefore[key],key)

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
 try{const session=(await(await fetch(app.url+'/api/session')).json()).data,headers={'content-type':'application/json','x-holoself-token':app.token},store=(await(await fetch(app.url+'/api/bindings')).json()).data
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
    const session=(await(await fetch(`${app.url}/api/session`)).json()).data,headers={'content-type':'application/json','x-holoself-token':app.token}
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

function tree(path){const result={};function visit(current,key){const info=lstatSync(current);if(info.isSymbolicLink()){result[key]=['link',readlinkSync(current)];return}if(info.isDirectory()){result[key]=['directory'];for(const name of readdirSync(current).sort())visit(join(current,name),key+'/'+name)}else result[key]=['file',readFileSync(current).toString('base64')]}visit(path,'');return result}
async function actionFixture({legacy=false}={}){
  const self=await temp(),project=await temp();await run(['init','--root',self])
  if(legacy){writeBinding(self,project,{default_lens:'general',secondary_lenses:[]});await run(['link','--root',self,'--target',project,'--yes'])}
  else await run(['link','add','--project',project,'--self',self,'--lens','professional','--secondary-lenses','general','--project-include','src/**','--activate','agents','--install-skill','none','--yes'])
  const app=await startWebServer({root:self,port:0}),session=(await(await fetch(app.url+'/api/session')).json()).data,headers={'content-type':'application/json','x-holoself-token':app.token},space=(await(await fetch(app.url+'/api/spaces')).json()).data.find(item=>normalizeProjectPath(item.path)===normalizeProjectPath(project))
  return {self,project,app,space,post:(action,payload={})=>fetch(`${app.url}/api/spaces/${space.id}/${action}`,{method:'POST',headers,body:JSON.stringify(payload)}),close:()=>new Promise(done=>app.server.close(done))}
}
test('space action previews write nothing',async()=>{
 const f=await actionFixture();try{const before=[tree(f.self),tree(f.project)];for(const action of ['activate','deactivate','relink','setup']){const response=await f.post(action),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.match(value.data.preview.plan_hash,/^[a-f0-9]{64}$/);assert.deepEqual([tree(f.self),tree(f.project)],before)}}finally{await f.close()}
 const f2=await actionFixture({legacy:true});try{const before=[tree(f2.self),tree(f2.project)];assert.equal((await f2.post('setup')).status,200);assert.deepEqual([tree(f2.self),tree(f2.project)],before)}finally{await f2.close()}
})
test('space actions reject missing and stale plan hashes',async()=>{
 const f=await actionFixture();try{
 for(const action of ['activate','deactivate','relink','setup']){
  const p=(await(await f.post(action)).json()).data.preview,before=[tree(f.self),tree(f.project)]
  for(const payload of [{apply:true},{apply:true,plan_hash:'0'.repeat(64)}])assert.equal((await f.post(action,payload)).status,409)
  assert.deepEqual([tree(f.self),tree(f.project)],before)
  const file=join(f.project,'AGENTS.md'),old=readFileSync(file);writeFileSync(file,Buffer.concat([old,Buffer.from('\nUser content changed.\n')]))
  const drift=[tree(f.self),tree(f.project)];assert.equal((await f.post(action,{apply:true,plan_hash:p.plan_hash})).status,409);assert.deepEqual([tree(f.self),tree(f.project)],drift);writeFileSync(file,old)
 }
 const activate=(await(await f.post('activate')).json()).data.preview
 assert.equal((await f.post('deactivate',{apply:true,plan_hash:activate.plan_hash})).status,409)
 const other=await temp();await run(['link','add','--project',other,'--self',f.self,'--no-activate','--yes']);await assert.rejects(applySpaceAction({root:f.self,project:other,action:'activate'},activate.plan_hash),{code:'PLAN_CHANGED'})
 }finally{await f.close()}
})
test('space actions apply matching plans',async()=>{
 for(const action of ['activate','deactivate','relink','setup']){
 const f=await actionFixture();try{
  const metadata=join(f.project,'.holoself');for(const [file,value] of [['README.md','Custom README'],['proposals/preserved.md','proposal evidence'],['reports/preserved.md','report evidence'],['index/preserved.md','legacy index']]){mkdirSync(join(metadata,file,'..'),{recursive:true});writeFileSync(join(metadata,file),value)}
  const before=tree(f.project),rootBefore=tree(f.self),originalLink=readFileSync(join(metadata,'link.yaml'),'utf8'),p=(await(await f.post(action)).json()).data.preview
  const result=await f.post(action,{apply:true,plan_hash:p.plan_hash});assert.equal(result.status,200,JSON.stringify(await result.json()))
  for(const file of ['README.md','proposals/preserved.md','reports/preserved.md','index/preserved.md'])assert.deepEqual(tree(f.project)['/.holoself/'+file],before['/.holoself/'+file])
  assert.equal(readFileSync(join(metadata,'link.yaml'),'utf8'),originalLink)
  const after=tree(f.project),rootAfter=tree(f.self),listed=new Set(p.plan.files.map(x=>normalizeProjectPath(resolve(x.path))))
  for(const [base,old,next] of [[f.project,before,after],[f.self,rootBefore,rootAfter]])for(const key of new Set([...Object.keys(old),...Object.keys(next)]))if(JSON.stringify(old[key])!==JSON.stringify(next[key]))assert.ok(listed.has(normalizeProjectPath(resolve(realpathSync(base)+key))),`unlisted mutation: ${base}${key}`)
  if(action==='deactivate')assert.ok(!after['/.holoself/runtime.json']);else{const runtime=JSON.parse(readFileSync(join(metadata,'runtime.json')));assert.deepEqual(runtime.activatedAdapters.map(x=>x.id),['agents']);assert.equal(runtime.skillInstallPolicy,'none')}
 }finally{await f.close()}
 }
})
test('space setup preserves junction on failed preflight and restores it after apply failure',async()=>{
 const f=await actionFixture({legacy:true});try{
  writeFileSync(join(f.project,'AGENTS.md'),'<!-- holoself-link-start schema=1 --> malformed')
  // Use the actual generated marker to force an unambiguous malformed-marker collision.
  const {LINK_START}=await import('../src/adapters.mjs');writeFileSync(join(f.project,'AGENTS.md'),LINK_START)
  const before=[tree(f.self),tree(f.project)];assert.equal((await f.post('setup')).status,400);assert.deepEqual([tree(f.self),tree(f.project)],before)
  unlinkSync(join(f.project,'AGENTS.md'));const request={root:f.self,project:f.project,action:'setup'},plan=planSpaceAction(request),clean=[tree(f.self),tree(f.project)]
  await assert.rejects(applySpaceAction(request,plan.plan_hash,{afterConfigure(){throw new Error('injected post-configuration failure')}}),/injected/)
  assert.deepEqual([tree(f.self),tree(f.project)],clean);assert.ok(lstatSync(join(f.project,'.holoself')).isSymbolicLink())
 }finally{await f.close()}
})
test('space plans reject unsafe root metadata and wrong legacy targets',async()=>{
 const f=await actionFixture({legacy:true});try{
  const other=await temp();unlinkSync(join(f.project,'.holoself'));symlinkSync(other,join(f.project,'.holoself'),process.platform==='win32'?'junction':'dir');const before=[tree(f.self),tree(f.project),tree(other)];assert.equal((await f.post('setup')).status,400);assert.deepEqual([tree(f.self),tree(f.project),tree(other)],before)
 }finally{await f.close()}
 const f2=await actionFixture();try{const registry=join(f2.self,'.holoself','links.json'),outside=join(await temp(),'links.json');writeFileSync(outside,readFileSync(registry));unlinkSync(registry);symlinkSync(outside,registry,'file');const before=[tree(f2.self),tree(f2.project)];assert.equal((await f2.post('relink')).status,400);assert.deepEqual([tree(f2.self),tree(f2.project)],before)}finally{await f2.close()}
})


test('space relink repairs a missing root in place and preserves recorded activation',async()=>{
 const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'.claude'))
 await run(['link','add','--project',project,'--self',self,'--lens','professional','--secondary-lenses','general','--project-exclude','private/**','--project-assert-include','src/**','--activate','agents','--instructions','CUSTOM.md','--install-skill','none','--yes'])
 const file=join(project,'.holoself','link.yaml'),original=readFileSync(file,'utf8'),missing=join(self,'missing-self').replaceAll('\\','/');writeFileSync(file,original.replace(self.replaceAll('\\','/'),missing))
 writeFileSync(join(project,'.holoself','proposals','keep.md'),'Preserve proposal')
 const request={root:self,project,action:'relink'},before=[tree(self),tree(project)],preview=planSpaceAction(request);assert.deepEqual([tree(self),tree(project)],before)
 assert.equal(preview.options.instructions,'CUSTOM.md');assert.equal(preview.options.installSkill,'none');assert.equal(preview.options.activate,'agents')
 await applySpaceAction(request,preview.plan_hash)
 assert.equal(readFileSync(file,'utf8'),original);assert.equal(readFileSync(join(project,'.holoself','proposals','keep.md'),'utf8'),'Preserve proposal')
 assert.equal(lstatSync(join(project,'CUSTOM.md')).isFile(),true);await assert.rejects(lstat(join(project,'CLAUDE.md')))
 const runtime=JSON.parse(readFileSync(join(project,'.holoself','runtime.json')));assert.deepEqual(runtime.activatedAdapters.map(x=>[x.id,x.file]),[['agents','CUSTOM.md']]);assert.equal(runtime.skillInstallPolicy,'none')
})
test('space plan binds absent adapter dependencies and restores regular setup after failure',async()=>{
 const self=await temp(),project=await temp();await run(['init','--root',self]);const request={root:self,project,action:'setup'},preview=planSpaceAction(request),before=[tree(self),tree(project)]
 await assert.rejects(applySpaceAction(request,preview.plan_hash,{afterConfigure(){throw new Error('injected setup failure')}}),/injected setup failure/);assert.deepEqual([tree(self),tree(project)],before)
 mkdirSync(join(project,'.claude'));const drift=[tree(self),tree(project)];await assert.rejects(applySpaceAction(request,preview.plan_hash),{code:'PLAN_CHANGED'});assert.deepEqual([tree(self),tree(project)],drift)
 const current=planSpaceAction(request);await applySpaceAction(request,current.plan_hash);assert.ok(lstatSync(join(project,'.holoself','link.yaml')).isFile())
})

test('scrubMessage preserves URLs and relative tokens while redacting local paths with spaces',()=>{
 assert.equal(scrubMessage('See https://example.com/x for details'),'See https://example.com/x for details')
 assert.equal(scrubMessage('invalid pair key:/value in config'),'invalid pair key:/value in config')
 assert.equal(scrubMessage('use and/or /api/lenses endpoint'),'use and/or /api/lenses endpoint')
 assert.equal(scrubMessage('missing file C:\\Users\\John Smith\\x: not found'),'missing file <local-path>: not found')
 const homeDoc=join(homedir(),'My Docs','x.md'),tmpDoc=join(tmpdir(),'My Docs','x.md')
 assert.equal(scrubMessage(`cannot read ${homeDoc}: permission denied`),'cannot read <local-path>: permission denied')
 assert.equal(scrubMessage(`cannot read ${tmpDoc}`),'cannot read <local-path>')
 assert.equal(scrubMessage('cannot read /home/jane/My Docs/x.md: missing'),'cannot read <local-path>: missing')
})

test('bin/holoself.mjs emits structured JSON on stderr when HOLOSELF_ERROR_FORMAT=json and human format otherwise',()=>{
 const refusal=spawnSync(process.execPath,[BIN,'unknown-subcommand'],{env:{...process.env,HOLOSELF_ERROR_FORMAT:'json'},encoding:'utf8'})
 assert.equal(refusal.status,1)
 const refusalLines=refusal.stderr.trim().split(/\r?\n/)
 assert.equal(refusalLines.length,1)
 const refusalJson=JSON.parse(refusalLines[0])
 assert.equal(refusalJson.holoself_error.kind,'refusal')
 assert.equal(refusalJson.holoself_error.name,'Error')
 assert.match(refusalJson.holoself_error.message,/unknown command/i)

 const internal=spawnSync(process.execPath,[BIN,'version'],{env:{...process.env,HOLOSELF_ERROR_FORMAT:'json',HOLOSELF_TEST_FORCE_INTERNAL:'1'},encoding:'utf8'})
 assert.equal(internal.status,1)
 const internalLines=internal.stderr.trim().split(/\r?\n/)
 assert.equal(internalLines.length,1)
 const internalJson=JSON.parse(internalLines[0])
 assert.equal(internalJson.holoself_error.kind,'internal')
 assert.equal(internalJson.holoself_error.name,'TypeError')

 const humanEnv={...process.env};delete humanEnv.HOLOSELF_ERROR_FORMAT;delete humanEnv.HOLOSELF_TEST_FORCE_INTERNAL
 const human=spawnSync(process.execPath,[BIN,'unknown-subcommand'],{env:humanEnv,encoding:'utf8'})
 assert.equal(human.status,1)
 assert.match(human.stderr,/^\[!!\] unknown command:/im)
})

test('Workbench maps validation and CLI refusals to 400/413, stale hashes to 409, and internal failures to 500 without leaking absolute paths',async()=>{
 const self=await temp(),project=await temp(),missingDir=join(self,'missing-folder')
 await run(['init','--root',self])
 await run(['link','add','--project',project,'--self',self,'--lens','professional','--no-activate','--yes'])
 const app=await startServer({root:self,port:0})
 try{
  const shell=await (await globalThis.fetch(app.url)).text(),meta=shell.match(/<meta name="holoself-token" content="([^"]+)">/)
  assert.ok(meta?.[1])
  const token=meta[1],origin=new URL(app.url).origin
  const call=async(path,{method='GET',body,rawBody}={},expectedStatus)=>{
   const headers={'x-holoself-token':token,...(method==='GET'?{}:{origin,'content-type':'application/json'})}
   const res=await globalThis.fetch(`${app.url}${path}`,{method,headers,body:rawBody??(body!==undefined?JSON.stringify(body):undefined)})
   const text=await res.text()
   assert.equal(res.status,expectedStatus,`${method} ${path}: ${text}`)
   for(const leaked of [self,project,tmpdir(),homedir()])assert.equal(text.includes(leaked),false,`leaked ${leaked} in ${text}`)
   assert.doesNotMatch(text,/(?:^|[\s("'=])\/(?:tmp|home|var|usr|etc|opt|root|Users|private)\b|(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!\/)/)
   return JSON.parse(text)
  }

  const {port}=new URL(app.url)
  const badHostStatus=await new Promise((ok,no)=>{const req=request({host:'127.0.0.1',port,path:'/api/session',method:'GET',headers:{host:`evil.example.com:${port}`,'x-holoself-token':token}},res=>{res.resume();res.on('end',()=>ok(res.statusCode))});req.on('error',no);req.end()})
  assert.equal(badHostStatus,421)
  const noToken=await globalThis.fetch(`${app.url}/api/session`)
  assert.equal(noToken.status,403)
  const badOrigin=await globalThis.fetch(`${app.url}/api/spaces/discover`,{method:'POST',headers:{'x-holoself-token':token,origin:'http://evil.example.com'}})
  assert.equal(badOrigin.status,403)
  const notFound=await call('/api/unknown-endpoint',{},404)
  assert.equal(notFound.error.code,'not_found')

  const badJson=await call('/api/spaces',{method:'POST',rawBody:'{not-json'},400)
  assert.equal(badJson.ok,false);assert.equal(badJson.error.code,'INVALID_JSON')
  const multiByteOverflow=JSON.stringify({text:'é'.repeat(1024*1024+32)})
  assert.ok(multiByteOverflow.length<2*1024*1024&&Buffer.byteLength(multiByteOverflow)>2*1024*1024)
  const tooLarge=await call('/api/spaces',{method:'POST',rawBody:multiByteOverflow},413)
  assert.equal(tooLarge.ok,false);assert.equal(tooLarge.error.code,'PAYLOAD_TOO_LARGE')
  await call('/api/filesystem/folders?path=relative/path',{},400)
  await call(`/api/filesystem/folders?path=${encodeURIComponent(missingDir)}`,{},400)
  const missingSpaceRefusal=await call('/api/spaces',{method:'POST',body:{path:missingDir,lens:'general'}},400)
  assert.match(missingSpaceRefusal.error.message,/project not found: <local-path>/)
  await call('/api/spaces/nonexistent-space',{method:'DELETE'},400)
  await call('/api/document?path=..%2Fsecret.md',{},400)
  await call('/api/document?path=profile%2Fmissing.md',{},400)
  const lensesData=(await (await globalThis.fetch(`${app.url}/api/lenses`,{headers:{'x-holoself-token':token}})).json()).data
  await call('/api/lenses/INVALID_ID',{method:'PUT',body:{definition:{schema_version:1,id:'INVALID_ID',title:'Bad'},expectedHash:lensesData.registry_hash}},400)

  const currentBindings=(await (await globalThis.fetch(`${app.url}/api/bindings`,{headers:{'x-holoself-token':token}})).json()).data
  const invalidLensBind=await call('/api/bindings',{method:'PUT',body:{project,default_lens:'nonexistent-lens',secondary_lenses:[],expectedHash:currentBindings.hash}},400)
  assert.match(invalidLensBind.error.message,/unknown lens: nonexistent-lens/)

  const spaces=(await (await globalThis.fetch(`${app.url}/api/spaces`,{headers:{'x-holoself-token':token}})).json()).data
  const space=spaces.find(item=>normalizeProjectPath(item.path)===normalizeProjectPath(project))
  assert.equal((await call('/api/bindings',{method:'PUT',body:{project,default_lens:'general',secondary_lenses:[],expectedHash:'0'.repeat(64)}},409)).error.code,'STALE_BINDINGS')
  assert.equal((await call('/api/document',{method:'PUT',body:{path:'profile/identity.md',content:'# Identity\n',expectedHash:'0'.repeat(64)}},409)).error.code,'STALE_DOCUMENT')
  assert.equal((await call('/api/lenses/general/instructions',{method:'PUT',body:{instructions:{purpose:'Test'},expectedHash:'0'.repeat(64)}},409)).error.code,'STALE_REGISTRY')
  assert.equal((await call(`/api/spaces/${space.id}/repair`,{method:'POST',body:{apply:true,plan_hash:'0'.repeat(64)}},409)).error.code,'PLAN_CHANGED')
  assert.equal((await call('/api/proposals/00000000-0000-4000-8000-000000000000/approve',{method:'POST',body:{project}},409)).error.code,'STALE_PREVIEW')
  const badSourceProposal=await call('/api/proposals',{method:'POST',body:{project,claim:'Prefers concise review feedback',sourceFile:'missing-source.md',target:'profile/identity.md',evidence:'review'}},400)
  assert.match(badSourceProposal.error.message,/source file not found or unsafe: missing-source\.md/)
  const missingProposalApprove=await call('/api/proposals/00000000-0000-4000-8000-000000000000/approve',{method:'POST',body:{project,previewHash:'0'.repeat(64)}},400)
  assert.match(missingProposalApprove.error.message,/proposal not found/i)
  writeFileSync(join(project,'notes.md'),'# Notes\nPrefers concise review feedback.\n')
  const createdProposal=(await (await globalThis.fetch(`${app.url}/api/proposals`,{method:'POST',headers:{'x-holoself-token':token,origin,'content-type':'application/json'},body:JSON.stringify({project,claim:'Prefers concise review feedback',sourceFile:'notes.md',target:'profile/identity.md',evidence:'review'})})).json()).data
  const wrongPreviewApprove=await call(`/api/proposals/${createdProposal.proposal_id}/approve`,{method:'POST',body:{project,previewHash:'0'.repeat(64)}},409)
  assert.equal(wrongPreviewApprove.error.code,'STALE_PREVIEW')
  assert.match(wrongPreviewApprove.error.message,/proposal preview is stale/i)

  const bindingsFile=join(self,'lenses','bindings.json'),originalBindings=readFileSync(bindingsFile,'utf8')
  writeFileSync(bindingsFile,'{corrupt-bindings')
  try{
   const err1=await call('/api/bindings',{},500)
   assert.deepEqual(err1,{ok:false,error:{code:'INTERNAL',message:'internal error'}})
   const err2=await call('/api/overview',{},500)
   assert.deepEqual(err2,{ok:false,error:{code:'INTERNAL',message:'internal error'}})
  }finally{writeFileSync(bindingsFile,originalBindings)}

  const lensFile=join(self,'lenses','general.json'),originalLens=readFileSync(lensFile,'utf8')
  writeFileSync(lensFile,'{corrupt-lens')
  try{
   const err3=await call('/api/annotations/schema',{},500)
   assert.deepEqual(err3,{ok:false,error:{code:'INTERNAL',message:'internal error'}})
  }finally{writeFileSync(lensFile,originalLens)}

  process.env.HOLOSELF_TEST_FORCE_INTERNAL='1'
  try{
   const err4=await call('/api/lenses',{},500)
   assert.deepEqual(err4,{ok:false,error:{code:'INTERNAL',message:'internal error'}})
  }finally{delete process.env.HOLOSELF_TEST_FORCE_INTERNAL}
 }finally{await new Promise(done=>app.server.close(done))}
})
