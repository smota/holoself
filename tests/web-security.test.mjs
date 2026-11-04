import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { startWebServer } from '../src/web-server.mjs'

const temp=()=>mkdtemp(join(tmpdir(),'holoself-web-security-'))
// node:http lets the test set Host and Origin exactly as a rebinding page or foreign site would.
function call(app,path,{method='GET',headers={},body}={}){const {port}=new URL(app.url);return new Promise((ok,no)=>{const req=request({host:'127.0.0.1',port,path,method,headers:{host:`127.0.0.1:${port}`,...headers}},res=>{let data='';res.setEncoding('utf8');res.on('data',x=>{data+=x});res.on('end',()=>ok({status:res.statusCode,headers:res.headers,body:data}))});req.on('error',no);req.end(body)})}
async function withServer(fn){const self=await temp();await run(['init','--root',self]);const app=await startWebServer({root:self,port:0});try{await fn(app,new URL(app.url).port)}finally{await new Promise(done=>app.server.close(done))}}

test('Workbench rejects a rebinding Host for static and API routes',()=>withServer(async(app,port)=>{
  for(const path of ['/','/app.mjs','/api/session','/api/documents']){const result=await call(app,path,{headers:{host:`evil.example:${port}`,'x-holoself-token':app.token}});assert.equal(result.status,421,path);assert.equal(result.body,'',path)}
  assert.equal((await call(app,'/',{headers:{host:'127.0.0.1:1'}})).status,421)
  assert.equal((await call(app,'/',{headers:{host:`localhost:${port}`}})).status,200)
}))

test('Workbench API GET routes require the session token',()=>withServer(async app=>{
  for(const path of ['/api/session','/api/documents','/api/overview','/api/filesystem/folders?path=%2F','/api/unknown']){const result=await call(app,path);assert.equal(result.status,403,path);assert.doesNotMatch(result.body,new RegExp(app.token))}
}))

test('Workbench API rejects a wrong session token',()=>withServer(async app=>{
  for(const token of ['0'.repeat(app.token.length),'short',`${app.token}0`]){const result=await call(app,'/api/documents',{headers:{'x-holoself-token':token}});assert.equal(result.status,403,token)}
}))

test('Workbench API accepts the correct session token and session omits it',()=>withServer(async app=>{
  const session=await call(app,'/api/session',{headers:{'x-holoself-token':app.token}});assert.equal(session.status,200);assert.equal(JSON.parse(session.body).data.token,undefined);assert.doesNotMatch(session.body,new RegExp(app.token))
  assert.equal((await call(app,'/api/documents',{headers:{'x-holoself-token':app.token}})).status,200)
}))

test('Workbench injects the session token into an uncached index.html',()=>withServer(async app=>{
  for(const path of ['/','/index.html']){const result=await call(app,path);assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');assert.ok(result.body.includes(`<meta name="holoself-token" content="${app.token}">`));assert.doesNotMatch(result.body,/__HOLOSELF_TOKEN__/);assert.match(result.headers['content-security-policy'],/script-src 'self';/)}
}))

test('Workbench rejects mutations with a foreign or missing Origin',()=>withServer(async(app,port)=>{
  const headers={'content-type':'application/json','x-holoself-token':app.token},body=JSON.stringify({metadata:{}})
  for(const origin of ['http://evil.example',`http://evil.example:${port}`,`https://127.0.0.1:${port}`,'null',undefined]){const result=await call(app,'/api/annotations/validate',{method:'POST',headers:origin?{...headers,origin}:headers,body});assert.equal(result.status,403,String(origin))}
  for(const origin of [`http://127.0.0.1:${port}`,`http://localhost:${port}`])assert.equal((await call(app,'/api/annotations/validate',{method:'POST',headers:{...headers,origin},body})).status,200,origin)
}))

test('Workbench static serving rejects paths outside the web directory',()=>withServer(async app=>{
  for(const path of ['/%2e%2e/package.json','/..%2fpackage.json','/%2e%2e%2f%2e%2e%2fetc%2fpasswd']){const result=await call(app,path);assert.ok([400,404].includes(result.status),path);assert.doesNotMatch(result.body,/holoself-ai/)}
  assert.equal((await call(app,'/%2Fetc%2Fpasswd')).status,404)
}))

test('Workbench token gate is case-insensitive and covers every API method',()=>withServer(async app=>{
  for(const path of ['/API/session','/Api/documents','/API/conversations/00000000-0000-0000-0000-000000000000?project=%2Ftmp','/api']){const result=await call(app,path);assert.equal(result.status,403,path)}
  assert.equal((await call(app,'/api/session',{method:'HEAD'})).status,403)
  assert.equal((await call(app,'/api/session',{method:'OPTIONS',headers:{'x-holoself-token':app.token}})).status,403)
  assert.equal((await call(app,'/',{method:'OPTIONS'})).status,403)
  assert.equal((await call(app,'/API/conversations/00000000-0000-0000-0000-000000000000?project=%2Ftmp',{headers:{'x-holoself-token':app.token}})).status,404)
}))

test('Workbench answers directory and case-variant static paths with 404 and keeps serving',()=>withServer(async app=>{
  for(const path of ['/assets','/assets/','/INDEX.HTML','/Index.html']){const result=await call(app,path);assert.equal(result.status,404,path);assert.doesNotMatch(result.body,new RegExp(app.token))}
  assert.equal((await call(app,'/')).status,200)
}))

test('Workbench page sends the session token on every API request',async()=>{
  const {readFile}=await import('node:fs/promises'),source=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8')
  assert.match(source,/token=document\.querySelector\('meta\[name="holoself-token"\]'\)\.content/)
  assert.match(source,/async function api\(path,options=\{\}\)\{const r=await fetch\(path,\{\.\.\.options,headers:\{'content-type':'application\/json','x-holoself-token':token,/)
  const fetches=[...source.matchAll(/\bfetch\(([^,)]+)/g)].map(match=>match[1]);assert.deepEqual(fetches,['path',"'/api/session'"])
  assert.match(source,/fetch\('\/api\/session',\{headers:\{'x-holoself-token':token\}\}\)/)
})
