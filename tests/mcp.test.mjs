import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run } from '../src/cli.mjs'
import { createMcpSession, HARVEST_PROMPT_NAME, HARVEST_PROMPT_TEXT, HARVEST_PROMPT_VERSION, harvestPromptText, MCP_PROMPTS, MCP_TOOLS, resolveBoundProject } from '../src/mcp-server.mjs'
import { applyMcpConfiguration, mcpConfigurationPlan, mcpConfigurationStatus } from '../src/mcp-config.mjs'

async function temp(){return mkdtemp(join(tmpdir(),'holoself-mcp-'))}
async function capture(fn){const old=console.log;let out='';console.log=(...x)=>{out+=x.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}
async function fixture(){
  const self=await temp(),project=await temp();await capture(()=>run(['init','--root',self]))
  await writeFile(join(self,'profile','identity.md'),'---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Identity\n\nMCP parity marker.\n')
  await mkdir(join(project,'Context'),{recursive:true});await writeFile(join(project,'Context','evidence.md'),'# Evidence\n\nProject-bound marker.\n')
  await capture(()=>run(['link','add','--project',project,'--self',self,'--lens','professional','--no-activate','--yes']))
  return {self,project}
}
function session(project){
  const output=[],accept=createMcpSession({project,write:line=>output.push(JSON.parse(line))})
  accept(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}}))
  return {output,accept,call(id,name,args={}){accept(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}}));return output.at(-1)}}
}

test('MCP handshake, tool discovery, stdout framing, and annotations are deterministic',async()=>{
  const {project}=await fixture(),m=session(project)
  assert.equal(m.output[0].result.protocolVersion,'2025-11-25');assert.equal(m.output[0].result.capabilities.tools.listChanged,false);assert.equal(m.output[0].result.capabilities.prompts.listChanged,false)
  m.accept(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}));const tools=m.output.at(-1).result.tools
  assert.deepEqual(tools.map(tool=>tool.name),MCP_TOOLS.map(tool=>tool.name));assert.equal(tools.length,7)
  assert.ok(tools.every(tool=>tool.inputSchema.additionalProperties===false&&tool.annotations.openWorldHint===false))
  assert.ok(tools.every(tool=>!/approve|accept|commit/i.test(tool.name)))
  m.accept('{bad json');assert.equal(m.output.at(-1).error.code,-32700)
})

test('spawned MCP keeps stdout protocol-only and exits cleanly at EOF',async()=>{
  const {project}=await fixture(),server=new URL('../bin/holoself.mjs',import.meta.url)
  const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'holoself_status',arguments:{}}}].map(JSON.stringify).join('\n')+'\n'
  const result=spawnSync(process.execPath,[server.pathname.replace(/^\/(?:([A-Za-z]:))/,'$1'),'mcp','--project',project],{input,encoding:'utf8',shell:false,windowsHide:true})
  assert.equal(result.status,0);assert.equal(result.stderr,'');const lines=result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(lines.length,2);assert.ok(lines.every(line=>line.jsonrpc==='2.0'));assert.equal(lines[1].result.structuredContent.data.project.linked,true)
})

test('Claude project-bound startup fails closed when its trusted root signal is absent',async()=>{
  const server=new URL('../bin/holoself.mjs',import.meta.url),env={...process.env};delete env.CLAUDE_PROJECT_DIR
  const result=spawnSync(process.execPath,[server.pathname.replace(/^\/(?:([A-Za-z]:))/,'$1'),'mcp','--claude-project-dir'],{input:'',encoding:'utf8',env,shell:false,windowsHide:true})
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/CLAUDE_PROJECT_DIR is required/)
})

test('MCP status and context preserve link authority without exposing absolute private roots',async()=>{
  const {self,project}=await fixture(),m=session(project),status=m.call(2,'holoself_status').result.structuredContent.data
  assert.equal(status.project.name,project.split(/[\\/]/).at(-1));assert.equal(status.link.default_lens,'professional');assert.equal(status.self.access,'read')
  const manifest=m.call(3,'holoself_context_manifest',{task:'parity marker',budget:'small'}).result.structuredContent.data,text=JSON.stringify(manifest)
  assert.doesNotMatch(text,new RegExp(self.replaceAll('\\','\\\\'),'i'));assert.doesNotMatch(text,/absolute_path|source_project_path/)
  const source=manifest.sources.find(item=>item.path==='profile/identity.md');assert.ok(source?.source_id);assert.ok(manifest.self.documents.every(document=>document.content===''))
  const selected=m.call(4,'holoself_context_get',{task:'parity marker',budget:'small',source_ids:[source.source_id]}).result.structuredContent.data
  assert.match(selected.self.documents.find(document=>document.source_id===source.source_id).content,/MCP parity marker/)
  const cli=JSON.parse(await capture(()=>run(['context','--project',project,'--task','parity marker','--budget','small','--source',source.source_id,'--json'])))
  assert.equal(selected.context_receipt.context_hash,cli.context_receipt.context_hash);assert.deepEqual(selected.restrictions,cli.restrictions)
  const direct=m.call(5,'holoself_context',{task:'career parity marker',budget:'standard'}).result.structuredContent.data
  assert.equal(direct.status,'complete')
  assert.ok(direct.self.documents.length>0)
  assert.ok(direct.self.documents.some(doc=>doc.content.includes('MCP parity marker')))
  const mechanical=m.call(6,'holoself_context',{task:'format this JSON object: {"x":1}',budget:'small'}).result.structuredContent.data
  assert.equal(mechanical.status,'not-needed')
  assert.equal(mechanical.selection.need_reason,'matched:mechanical:format')
  assert.equal(mechanical.context_receipt.need,'not-needed')
  assert.equal(mechanical.context_receipt.need_reason,'matched:mechanical:format')
  assert.ok(mechanical.self.documents.length>0)
  assert.ok(mechanical.self.documents.every(doc=>doc.path.startsWith('profile/')))
  const strictNotNeeded=m.call(61,'holoself_context',{task:'format this JSON object: {"x":1}',budget:'small',need:'not-needed'}).result.structuredContent.data
  assert.equal(strictNotNeeded.status,'not-needed')
  assert.equal(strictNotNeeded.selection.need_reason,'explicit')
  assert.equal(strictNotNeeded.context_receipt.need,'not-needed')
  assert.equal(strictNotNeeded.context_receipt.need_reason,'explicit')
  assert.equal(strictNotNeeded.self.documents.length,0)
  const forcedRequired=m.call(62,'holoself_context',{task:'format this JSON object: {"x":1}',budget:'small',need:'required'}).result.structuredContent.data
  assert.equal(forcedRequired.status,'complete')
  assert.equal(forcedRequired.selection.context_need,'required')
  assert.equal(forcedRequired.selection.need_reason,'explicit')
  assert.equal(forcedRequired.context_receipt.need,'required')
  const forcedManifest=m.call(63,'holoself_context_manifest',{task:'format this JSON object: {"x":1}',budget:'small',need:'not-needed'}).result.structuredContent.data
  assert.equal(forcedManifest.selection.context_need,'not-needed')
  assert.equal(forcedManifest.selection.need_reason,'explicit')
  assert.equal(forcedManifest.self.documents.length,0)
  const badNeed=m.call(64,'holoself_context',{task:'format this JSON object: {"x":1}',need:'bogus'}).result
  assert.equal(badNeed.isError,true)
  assert.equal(badNeed.structuredContent.error.code,'INVALID_ARGUMENT')
  const escalated=m.call(7,'holoself_context_manifest',{lens:'private'}).result;assert.equal(escalated.isError,true);assert.match(escalated.structuredContent.error.message,/not granted/)
  for(const lens of ['/srv/private/self','\\\\server\\share\\private']){const shaped=m.call(8,'holoself_context_manifest',{lens}).result;assert.equal(shaped.isError,true);assert.doesNotMatch(shaped.structuredContent.error.message,/srv|server|share/)}
})

test('MCP broken-state diagnostics redact bound private paths on successful and failed tools',async()=>{
  const {self,project}=await fixture(),m=session(project);await rm(self,{recursive:true,force:true})
  const status=m.call(2,'holoself_status').result.structuredContent.data,search=m.call(3,'holoself_search',{query:'marker'}).result
  assert.equal(status.context.state,'broken');assert.doesNotMatch(JSON.stringify(status),new RegExp(self.replaceAll('\\','\\\\'),'i'))
  assert.doesNotMatch(JSON.stringify(search),new RegExp(self.replaceAll('\\','\\\\'),'i'));if(search.isError)assert.match(search.structuredContent.error.message,/failed closed|lens bind/)
})

test('MCP read tools do not create cache or index state',async()=>{
  const {project}=await fixture(),m=session(project),cache=join(project,'.holoself','runtime','context-cache'),index=join(project,'.holoself','index','index.json')
  assert.equal(existsSync(cache),false);assert.equal(existsSync(index),false)
  assert.equal(m.call(2,'holoself_status').result.isError,undefined);assert.equal(m.call(3,'holoself_context_manifest',{budget:'small'}).result.isError,undefined);assert.equal(m.call(4,'holoself_search',{query:'marker'}).result.isError,undefined)
  assert.equal(existsSync(cache),false);assert.equal(existsSync(index),false)
})

test('MCP validates bounded arguments and proposal writes remain project-local pending review',async()=>{
  const {self,project}=await fixture(),before=await readFile(join(self,'profile','identity.md'),'utf8'),m=session(project)
  const invalid=m.call(2,'holoself_context_get',{source_ids:['../../private']}).result;assert.equal(invalid.isError,true);assert.equal(invalid.structuredContent.error.code,'INVALID_ARGUMENT')
  const created=m.call(3,'holoself_proposal_create',{claim:'Review the project marker.',source_files:['Context/evidence.md'],proposal_type:'new_fact',visibility:'private'}).result.structuredContent.data
  assert.equal(created.status,'pending');assert.equal(created.source_project_path,undefined);assert.equal(await readFile(join(self,'profile','identity.md'),'utf8'),before)
  const stored=await readFile(join(project,'.holoself','proposals',`${created.proposal_id}.yaml`),'utf8');assert.match(stored,/status: "pending"/)
  const preview=m.call(4,'holoself_proposal_preview',{proposal_id:created.proposal_id}).result.structuredContent.data
  assert.equal(preview.canonical_write_performed,false);assert.equal(preview.requires_human_approval,true);assert.match(preview.preview_hash,/^[a-f0-9]{64}$/)
})

test('MCP project binding fails closed on missing or ambiguous links',async()=>{
  const {project}=await fixture(),other=await temp()
  assert.throws(()=>resolveBoundProject(undefined,{},other),/no safe .holoself\/link.yaml/)
  assert.throws(()=>resolveBoundProject(project,{CLAUDE_PROJECT_DIR:other},project),/ambiguous project binding/)
  const bound=resolveBoundProject(undefined,{CLAUDE_PROJECT_DIR:project},other);assert.equal(bound.source,'CLAUDE_PROJECT_DIR')
})

test('MCP client configuration is previewable, idempotent, and collision-aware',async()=>{
  const {project}=await fixture(),preview=mcpConfigurationPlan(project)
  assert.deepEqual(preview.changes.map(change=>change.platform),['codex','agy','claude']);assert.ok(preview.changes.every(change=>change.action==='create'))
  const applied=applyMcpConfiguration(project);assert.equal(applied.status,'configured');assert.equal(mcpConfigurationStatus(project).state,'configured')
  assert.match(await readFile(join(project,'.codex','config.toml'),'utf8'),/holoself-mcp-managed-start/)
  assert.equal(JSON.parse(await readFile(join(project,'.agents','mcp_config.json'),'utf8')).mcpServers.holoself.command,'holoself')
  assert.deepEqual(JSON.parse(await readFile(join(project,'.mcp.json'),'utf8')).mcpServers.holoself.args,['mcp','--claude-project-dir'])
  await writeFile(join(project,'.mcp.json'),JSON.stringify({mcpServers:{holoself:{command:'other'}}}))
  assert.throws(()=>mcpConfigurationPlan(project),/refusing to overwrite/)
})

test('MCP configuration rejects semantic TOML collisions and symlink parents',async()=>{
  const {project}=await fixture();await mkdir(join(project,'.codex'),{recursive:true})
  for(const text of ['["mcp_servers"."holoself"]\ncommand="other"\n','mcp_servers.holoself = { command = "other" }\n','[mcp_servers]\nholoself = { command = "other" }\n']){await writeFile(join(project,'.codex','config.toml'),text);assert.throws(()=>mcpConfigurationPlan(project,{platforms:['codex']}),/refusing to overwrite/)}
  const outside=await temp();await mkdir(join(outside,'redirect'),{recursive:true});await rm(join(project,'.codex'),{recursive:true,force:true});await symlink(join(outside,'redirect'),join(project,'.codex'),'junction')
  assert.throws(()=>mcpConfigurationPlan(project,{platforms:['codex']}),/traverses a symlink/)
})

test('MCP configuration rollback removes newly created files exactly',async()=>{
  const {project}=await fixture();let writes=0
  assert.throws(()=>applyMcpConfiguration(project,{platforms:['codex','agy']},{write(path,content){writes++;if(writes===2)throw new Error('injected write failure');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content,'utf8')}}),/injected write failure/)
  assert.equal(existsSync(join(project,'.codex','config.toml')),false);assert.equal(existsSync(join(project,'.agents','mcp_config.json')),false)
})

test('MCP configuration rollback restores an existing file byte-for-byte',async()=>{
  const {project}=await fixture(),path=join(project,'.codex','config.toml'),original='# user-owned config\nmodel = "example"\n';await mkdir(dirname(path),{recursive:true});await writeFile(path,original);let writes=0
  assert.throws(()=>applyMcpConfiguration(project,{platforms:['codex','agy']},{write(target,content){writes++;if(writes===2)throw new Error('injected later failure');mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content,'utf8')}}),/injected later failure/)
  assert.equal(await readFile(path,'utf8'),original);assert.equal(existsSync(join(project,'.agents','mcp_config.json')),false)
})

test('opt-in MCP audit log records only event, tool or prompt name, and outcome',async()=>{
  const {self,project}=await fixture(),dir=await temp(),log=join(dir,'audit.ndjson'),output=[]
  const accept=createMcpSession({project,write:line=>output.push(JSON.parse(line)),auditLog:log})
  const send=(id,method,params)=>accept(JSON.stringify({jsonrpc:'2.0',id,method,params}))
  send(1,'initialize',{protocolVersion:'2025-11-25'});send(2,'tools/list',{})
  send(3,'tools/call',{name:'holoself_search',arguments:{query:'secret-argument-marker'}})
  send(4,'tools/call',{name:'holoself_context_get',arguments:{source_ids:['../../private']}})
  send(5,'tools/call',{name:'/srv/private/tool-name-marker',arguments:{}})
  send(6,'prompts/list',{})
  send(7,'prompts/get',{name:'holoself_session_harvest',arguments:{focus:'secret-focus-marker'}})
  send(8,'prompts/get',{name:'holoself_session_harvest',arguments:{focus:'<!-- holoself-claim visibility=private -->'}})
  send(9,'prompts/get',{name:'/srv/private/prompt-name-marker',arguments:{}})
  const text=await readFile(join(log),'utf8'),lines=text.trim().split('\n').map(line=>JSON.parse(line))
  assert.deepEqual(lines.map(({at,...rest})=>rest),[
    {event:'tools/list',tools:7},
    {event:'tools/call',tool:'holoself_search',ok:true,error_code:null},
    {event:'tools/call',tool:'holoself_context_get',ok:false,error_code:'INVALID_ARGUMENT'},
    {event:'tools/call',tool:'unknown',ok:false,error_code:'TOOL_NOT_FOUND'},
    {event:'prompts/list',prompts:1},
    {event:'prompts/get',prompt:'holoself_session_harvest',name:'holoself_session_harvest',ok:true,error_code:null},
    {event:'prompts/get',prompt:'holoself_session_harvest',name:'holoself_session_harvest',ok:false,error_code:'INVALID_ARGUMENT'},
    {event:'prompts/get',prompt:'unknown',name:'unknown',ok:false,error_code:'PROMPT_NOT_FOUND'}
  ])
  for(const marker of [self,project,'secret-argument-marker','secret-focus-marker','private','tool-name-marker','prompt-name-marker','MCP parity marker'])assert.ok(!text.includes(marker),`audit log leaked ${marker}`)
  assert.equal(output.length,9)
  const silent=[],quiet=createMcpSession({project,write:line=>silent.push(line),auditLog:'relative/audit.ndjson'})
  quiet(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}}));quiet(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}))
  assert.equal(existsSync(join(process.cwd(),'relative')),false)
})

test('MCP prompts/list, prompts/get, argument validation, safety rules, and CLI harvest parity',async()=>{
  const {self,project}=await fixture(),m=session(project)
  const send=(id,method,params)=>{m.accept(JSON.stringify({jsonrpc:'2.0',id,method,params}));return m.output.at(-1)}
  const listed=send(2,'prompts/list',{}).result.prompts
  assert.equal(listed.length,1);assert.deepEqual(listed,MCP_PROMPTS)
  assert.equal(listed[0].name,HARVEST_PROMPT_NAME)
  assert.deepEqual(listed[0].arguments.map(item=>({name:item.name,required:item.required})),[{name:'focus',required:false}])

  const base=send(3,'prompts/get',{name:HARVEST_PROMPT_NAME}).result
  assert.equal(typeof base.description,'string');assert.equal(base.messages.length,1)
  assert.equal(base.messages[0].role,'user');assert.equal(base.messages[0].content.type,'text')
  const text=base.messages[0].content.text
  assert.equal(text,HARVEST_PROMPT_TEXT);assert.equal(text,harvestPromptText());assert.equal(HARVEST_PROMPT_VERSION,1)
  assert.match(text,/v1/);assert.match(text,/at most 3/i);assert.match(text,/propose nothing/i)
  assert.match(text,/Never infer sensitive identity attributes or invent facts/)
  assert.match(text,/holoself_proposal_preview/);assert.match(text,/holoself_proposal_create/)
  assert.match(text,/append_claim/);assert.match(text,/replace_claim/);assert.match(text,/supersede_claim/);assert.match(text,/retire_claim/);assert.match(text,/claim_id/)
  assert.match(text,/holoself proposals approve/);assert.match(text,/Workbench/)
  assert.doesNotMatch(text,new RegExp(self.replaceAll('\\','\\\\'),'i'));assert.doesNotMatch(text,new RegExp(project.replaceAll('\\','\\\\'),'i'))

  const focused=send(4,'prompts/get',{name:HARVEST_PROMPT_NAME,arguments:{focus:'testing preferences'}}).result
  assert.equal(focused.messages[0].content.text,`${HARVEST_PROMPT_TEXT}\n\nFocus area: testing preferences`)

  const badName=send(5,'prompts/get',{name:'/srv/private/unknown-prompt'}).error
  assert.equal(badName.code,-32602);assert.equal(badName.data.code,'PROMPT_NOT_FOUND');assert.doesNotMatch(badName.message,/srv|private/)

  for(const badParams of [
    null,
    [],
    {},
    {name:''},
    {name:HARVEST_PROMPT_NAME,extra:true},
    {name:HARVEST_PROMPT_NAME,arguments:[]},
    {name:HARVEST_PROMPT_NAME,arguments:'focus'},
    {name:HARVEST_PROMPT_NAME,arguments:{extra:'nope'}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:123}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:'   '}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:'x'.repeat(201)}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:'line one\nline two'}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:'<!-- holoself-claim visibility=private -->'}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:'<!-- /holoself-claim -->'}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:'<!-- holoself-link-start schema=1 -->'}},
    {name:HARVEST_PROMPT_NAME,arguments:{focus:'@@holoself-commit-time-deadbeef@@'}}
  ]){
    const err=send(6,'prompts/get',badParams).error
    assert.equal(err.code,-32602);assert.equal(err.data.code,'INVALID_ARGUMENT')
  }

  const cliRaw=(await capture(()=>run(['instructions','render','--harvest']))).trimEnd()
  assert.equal(cliRaw,text)
  const cliProject=(await capture(()=>run(['instructions','render','--project',project,'--harvest','--focus','testing preferences']))).trimEnd()
  assert.equal(cliProject,focused.messages[0].content.text)
  const cliJson=JSON.parse(await capture(()=>run(['instructions','render','--harvest','--focus','testing preferences','--json'])))
  assert.equal(cliJson.prompt,HARVEST_PROMPT_NAME);assert.equal(cliJson.content,focused.messages[0].content.text)
  await assert.rejects(()=>run(['instructions','render','--focus','testing preferences']),/--focus requires --harvest/)
  await assert.rejects(()=>run(['instructions','render','--harvest','--adapter','claude']),/--adapter cannot be combined with --harvest/)
  await assert.rejects(()=>run(['instructions','render','--harvest','--focus','x'.repeat(201)]),/max 200 chars/)
})

test('MCP status reports per-platform support from the verification matrix',async()=>{
  const {project}=await fixture(),{mcpPlatformSupport}=await import('../src/mcp-verification.mjs')
  const expected=Object.fromEntries(mcpPlatformSupport().map(item=>[item.platform,item]))
  for(const item of mcpConfigurationStatus(project).platforms){
    assert.equal(item.support,expected[item.platform].support);assert.equal(item.tested_version,expected[item.platform].tested_version);assert.equal(item.last_verified,expected[item.platform].last_verified)
  }
})
