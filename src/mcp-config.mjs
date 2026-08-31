import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { holoselfMcpStatus } from './ecosystem.mjs'

const PLATFORMS=['codex','agy','claude']
const START='# holoself-mcp-managed-start'
const END='# holoself-mcp-managed-end'
const TOOLS=['holoself_status','holoself_context_manifest','holoself_context_get','holoself_search','holoself_proposal_create','holoself_proposal_preview']
const hash=text=>createHash('sha256').update(text).digest('hex')
const slash=path=>path.replaceAll('\\','/')
function atomicWrite(path,content){mkdirSync(dirname(path),{recursive:true});const temp=`${path}.tmp-${process.pid}-${Date.now()}`;writeFileSync(temp,content,'utf8');renameSync(temp,path)}
function safeConfigPath(project,path){
  const boundary=resolve(project),target=resolve(path),rel=relative(boundary,target)
  if(!existsSync(boundary)||lstatSync(boundary).isSymbolicLink()||!lstatSync(boundary).isDirectory())throw new Error('MCP project must be a safe local directory')
  if(rel.startsWith('..')||isAbsolute(rel))throw new Error('MCP configuration path escapes project')
  let current=target;while(current!==boundary){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error(`MCP configuration path traverses a symlink: ${current}`);current=dirname(current)}
  return target
}
function safeFile(path){if(!existsSync(path))return '';if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error(`${path} is not a safe regular file`);return readFileSync(path,'utf8')}
function parseJson(path,text){if(!text.trim())return {};try{const value=JSON.parse(text);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('root must be an object');return value}catch(error){throw new Error(`${path} is invalid JSON: ${error.message}`)}}
function sameJson(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function jsonPlan(project,platform){
  const relative=platform==='agy'?join('.agents','mcp_config.json'):'.mcp.json',path=safeConfigPath(project,join(project,relative)),existed=existsSync(path),before=safeFile(path),config=parseJson(path,before),servers=config.mcpServers
  if(servers!==undefined&&(!servers||Array.isArray(servers)||typeof servers!=='object'))throw new Error(`${path} mcpServers must be an object`)
  const desired=platform==='claude'?{type:'stdio',command:'holoself',args:['mcp','--claude-project-dir']}:{command:'holoself',args:['mcp','--project',slash(project)],cwd:slash(project)}
  const existing=servers?.holoself
  if(existing&&!sameJson(existing,desired))throw new Error(`${path} has an unmanaged or divergent holoself MCP server; refusing to overwrite`)
  const next={...config,mcpServers:{...(servers||{}),holoself:desired}},after=JSON.stringify(next,null,2)+'\n'
  return {platform,path,relative:slash(relative),existed,before,after,action:before===after?'unchanged':before?'update':'create',sha256:hash(after),server:desired}
}
function codexPlan(project){
  const relative=join('.codex','config.toml'),path=safeConfigPath(project,join(project,relative)),existed=existsSync(path),before=safeFile(path),starts=(before.match(new RegExp(START,'g'))||[]).length,ends=(before.match(new RegExp(END,'g'))||[]).length
  if(starts!==ends||starts>1)throw new Error(`${path} has malformed Holoself MCP markers`)
  const outside=before.replace(new RegExp(`${START}[\\s\\S]*?${END}\\r?\\n?`),'')
  const semanticCollision=/(?:^|\n)\s*\[\s*["']?mcp_servers["']?\s*\.\s*["']?holoself["']?\s*\]|(?:^|\n)\s*["']?mcp_servers["']?\s*\.\s*["']?holoself["']?\s*=|(?:^|\n)\s*\[\s*["']?mcp_servers["']?\s*\][\s\S]*?(?:^|\n)\s*["']?holoself["']?\s*=|(?:^|\n)\s*["']?mcp_servers["']?\s*=\s*\{[\s\S]*?\bholoself\b/m.test(outside)
  if(semanticCollision)throw new Error(`${path} has an unmanaged holoself MCP server; refusing to overwrite`)
  const projectArg=slash(project).replaceAll('"','\\"'),toolList=TOOLS.map(tool=>`"${tool}"`).join(', ')
  const block=`${START}\n[mcp_servers.holoself]\ncommand = "holoself"\nargs = ["mcp", "--project", "${projectArg}"]\nrequired = false\nenabled_tools = [${toolList}]\ndefault_tools_approval_mode = "writes"\n${END}\n`
  const after=starts?before.replace(new RegExp(`${START}[\\s\\S]*?${END}\\r?\\n?`),block):(before.trimEnd()?`${before.trimEnd()}\n\n`:'' )+block
  return {platform:'codex',path,relative:slash(relative),existed,before,after,action:before===after?'unchanged':before?'update':'create',sha256:hash(after),server:{command:'holoself',args:['mcp','--project',slash(project)],required:false,enabled_tools:TOOLS,default_tools_approval_mode:'writes'}}
}

export function mcpConfigurationPlan(projectInput,{platforms=PLATFORMS}={}){
  const project=resolve(projectInput);holoselfMcpStatus(project)
  const selected=[...new Set(platforms.length?platforms:PLATFORMS)]
  for(const platform of selected)if(!PLATFORMS.includes(platform))throw new Error(`unsupported MCP platform: ${platform}`)
  const changes=selected.map(platform=>platform==='codex'?codexPlan(project):jsonPlan(project,platform))
  return {schema_version:1,project:slash(project),authority:'.holoself/link.yaml',transport:'stdio',command_requirement:'holoself on client PATH',local_only:true,commit_warning:'Codex and AGY configuration embeds this host project path; keep it uncommitted unless explicitly reviewed.',changes:changes.map(({before,after,...change})=>change),_changes:changes}
}
export function applyMcpConfiguration(projectInput,options={},io={}){
  const plan=mcpConfigurationPlan(projectInput,options),written=[]
  const write=io.write||atomicWrite,remove=io.remove||((path)=>rmSync(path,{force:true}))
  try{for(const change of plan._changes)if(change.action!=='unchanged'){write(change.path,change.after);written.push(change)}}catch(error){for(const change of written.reverse()){if(change.existed)atomicWrite(change.path,change.before);else remove(change.path)}throw error}
  return {...plan,changes:plan.changes.map(change=>({...change,result:change.action==='unchanged'?'unchanged':'configured'})),_changes:undefined,status:'configured'}
}
export function mcpConfigurationStatus(projectInput,{platforms=PLATFORMS}={}){
  const plan=mcpConfigurationPlan(projectInput,{platforms})
  return {schema_version:1,project:plan.project,authority:plan.authority,transport:plan.transport,state:plan.changes.every(change=>change.action==='unchanged')?'configured':'degraded',platforms:plan.changes.map(change=>({platform:change.platform,file:change.relative,state:change.action==='unchanged'?'configured':'missing-or-drifted',expected_sha256:change.sha256}))}
}

export { PLATFORMS as MCP_PLATFORMS }
