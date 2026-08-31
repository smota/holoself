import { createInterface } from 'node:readline'
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  holoselfMcpContext,
  holoselfMcpCreateProposal,
  holoselfMcpPreviewProposal,
  holoselfMcpSearch,
  holoselfMcpStatus,
  PROPOSAL_TYPES,
  VISIBILITIES
} from './ecosystem.mjs'
import { VERSION } from './version.mjs'

const PROTOCOL_VERSIONS=['2025-11-25','2025-06-18','2025-03-26']
const TOOL_PREFIX='holoself_'
const MAX_LINE_BYTES=1024*1024
const MAX_RESULT_BYTES=512*1024
const TEMPORAL=['current','historical','superseded','all']
const BUDGETS=['small','standard','deep']

const baseContextProperties={
  task:{type:'string',minLength:1,maxLength:500,description:'The current task; used only for deterministic relevance selection.'},
  lens:{type:'string',minLength:1,maxLength:80,description:'A built-in or canonical custom lens ID.'},
  budget:{type:'string',enum:BUDGETS,default:'standard'},
  temporal:{type:'string',enum:TEMPORAL,default:'current'}
}
const objectSchema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const resultSchema=objectSchema({schema_version:{type:'integer'},data:{type:'object'},error:{type:'object'}})

export const MCP_TOOLS=[
  {name:`${TOOL_PREFIX}status`,title:'Holoself status',description:'Check the fixed linked project, explicit link authority, context health, and pending proposals without revealing private root paths.',inputSchema:objectSchema({}),outputSchema:resultSchema,annotations:{title:'Holoself status',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:`${TOOL_PREFIX}context_manifest`,title:'Holoself context manifest',description:'Return bounded source handles, metadata, restrictions, and a deterministic receipt. It does not return source bodies.',inputSchema:objectSchema(baseContextProperties),outputSchema:resultSchema,annotations:{title:'Holoself context manifest',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:`${TOOL_PREFIX}context_get`,title:'Holoself context get',description:'Resolve only the requested manifest source handles through the link, lens, lifecycle, and privacy gates.',inputSchema:objectSchema({...baseContextProperties,source_ids:{type:'array',minItems:1,maxItems:16,uniqueItems:true,items:{type:'string',pattern:'^hs-[A-Za-z0-9_-]{8,}$'}}},['source_ids']),outputSchema:resultSchema,annotations:{title:'Holoself context get',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:`${TOOL_PREFIX}search`,title:'Holoself search',description:'Search the deterministic local privacy-filtered index for the fixed linked project.',inputSchema:objectSchema({query:{type:'string',minLength:1,maxLength:500},lens:{type:'string',minLength:1,maxLength:80},temporal:{type:'string',enum:TEMPORAL,default:'current'},federated:{type:'boolean',default:false},limit:{type:'integer',minimum:1,maximum:20,default:10}},['query']),outputSchema:resultSchema,annotations:{title:'Holoself search',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:`${TOOL_PREFIX}proposal_create`,title:'Create Holoself proposal',description:'Create a project-local pending proposal backed by contained project evidence. It never writes canonical self.',inputSchema:objectSchema({claim:{type:'string',minLength:1,maxLength:4000},evidence:{type:'string',minLength:1,maxLength:4000},source_files:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'string',minLength:1,maxLength:500}},target:{type:'string',minLength:1,maxLength:500,default:'context/claims.md'},proposal_type:{type:'string',enum:PROPOSAL_TYPES,default:'new_fact'},confidence:{type:'string',minLength:1,maxLength:120,default:'unverified'},visibility:{type:'string',enum:VISIBILITIES,default:'private'}},['claim','source_files']),outputSchema:resultSchema,annotations:{title:'Create Holoself proposal',readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
  {name:`${TOOL_PREFIX}proposal_preview`,title:'Preview Holoself proposal',description:'Preview the exact canonical changes and digest for a pending proposal without applying or approving it.',inputSchema:objectSchema({proposal_id:{type:'string',pattern:'^[0-9a-fA-F-]{8,36}$'}},['proposal_id']),outputSchema:resultSchema,annotations:{title:'Preview Holoself proposal',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
]

function fail(message,code='INVALID_ARGUMENT'){const error=new Error(message);error.code=code;throw error}
function validateObject(value,schema,path='arguments'){
  if(!value||Array.isArray(value)||typeof value!=='object')fail(`${path} must be an object`)
  const allowed=new Set(Object.keys(schema.properties||{}));for(const key of Object.keys(value))if(!allowed.has(key))fail(`${path}.${key} is not allowed`)
  for(const key of schema.required||[])if(value[key]===undefined)fail(`${path}.${key} is required`)
  for(const [key,item] of Object.entries(value)){
    const rule=schema.properties[key],label=`${path}.${key}`
    if(rule.type==='string'){
      if(typeof item!=='string')fail(`${label} must be a string`);if(rule.minLength&&item.length<rule.minLength)fail(`${label} is too short`);if(rule.maxLength&&item.length>rule.maxLength)fail(`${label} is too long`);if(rule.enum&&!rule.enum.includes(item))fail(`${label} must be one of ${rule.enum.join(', ')}`);if(rule.pattern&&!new RegExp(rule.pattern).test(item))fail(`${label} has an invalid format`)
    }else if(rule.type==='boolean'&&typeof item!=='boolean')fail(`${label} must be a boolean`)
    else if(rule.type==='integer'){
      if(!Number.isInteger(item))fail(`${label} must be an integer`);if(rule.minimum!==undefined&&item<rule.minimum)fail(`${label} is too small`);if(rule.maximum!==undefined&&item>rule.maximum)fail(`${label} is too large`)
    }else if(rule.type==='array'){
      if(!Array.isArray(item))fail(`${label} must be an array`);if(rule.minItems&&item.length<rule.minItems)fail(`${label} has too few items`);if(rule.maxItems&&item.length>rule.maxItems)fail(`${label} has too many items`);if(rule.uniqueItems&&new Set(item).size!==item.length)fail(`${label} must contain unique items`)
      for(let i=0;i<item.length;i++)validateObject({value:item[i]},objectSchema({value:rule.items},['value']),`${label}[${i}]`)
    }
  }
  return value
}
function resolveBoundProject(projectInput,env=process.env,cwd=process.cwd()){
  const candidates=[]
  if(projectInput)candidates.push(['--project',projectInput])
  if(env.CLAUDE_PROJECT_DIR)candidates.push(['CLAUDE_PROJECT_DIR',env.CLAUDE_PROJECT_DIR])
  if(!candidates.length)candidates.push(['cwd',cwd])
  const resolved=[...new Map(candidates.map(([source,value])=>[resolve(value),source])).entries()]
  if(resolved.length!==1)fail(`ambiguous project binding from ${candidates.map(([source])=>source).join(' and ')}`,'PROJECT_BINDING_AMBIGUOUS')
  const [project,source]=resolved[0]
  if(!isAbsolute(project)||!existsSync(project)||lstatSync(project).isSymbolicLink()||!lstatSync(project).isDirectory())fail('project binding is not a safe local directory','PROJECT_BINDING_INVALID')
  const link=join(project,'.holoself','link.yaml')
  if(!existsSync(link)||lstatSync(link).isSymbolicLink()||!lstatSync(link).isFile())fail('fixed project has no safe .holoself/link.yaml','LINK_REQUIRED')
  holoselfMcpStatus(project)
  return {project,source}
}
function toolResult(data){
  const structuredContent={schema_version:1,data}
  const text=JSON.stringify(structuredContent)
  if(Buffer.byteLength(text)>MAX_RESULT_BYTES)fail('bounded MCP result exceeded 512 KiB','RESULT_TOO_LARGE')
  return {content:[{type:'text',text}],structuredContent}
}
function safeErrorMessage(error){
  if(!error?.code)return 'Holoself operation failed closed. Run holoself link doctor locally for path-safe diagnostics.'
  return String(error.message||error).replace(/\\\\[^\s;]+/g,'<local-path>').replace(/[A-Za-z]:[\\/][^\s;]+/g,'<local-path>').replace(/(^|[\s("'=])\/(?:[^\s;]+\/?)+/g,'$1<local-path>').slice(0,1000)
}
function toolError(error){
  const structuredContent={schema_version:1,error:{code:error.code||'HOLOSELF_ERROR',message:safeErrorMessage(error)}}
  return {content:[{type:'text',text:JSON.stringify(structuredContent)}],structuredContent,isError:true}
}
function callTool(project,name,args){
  const tool=MCP_TOOLS.find(item=>item.name===name);if(!tool)fail(`unknown tool: ${name}`,'TOOL_NOT_FOUND')
  validateObject(args||{},tool.inputSchema)
  if(name===`${TOOL_PREFIX}status`)return holoselfMcpStatus(project)
  if(name===`${TOOL_PREFIX}context_manifest`)return holoselfMcpContext(project,{...args,manifest:true})
  if(name===`${TOOL_PREFIX}context_get`)return holoselfMcpContext(project,{...args,manifest:false})
  if(name===`${TOOL_PREFIX}search`)return holoselfMcpSearch(project,args)
  if(name===`${TOOL_PREFIX}proposal_create`)return holoselfMcpCreateProposal(project,args)
  if(name===`${TOOL_PREFIX}proposal_preview`)return holoselfMcpPreviewProposal(project,args.proposal_id)
  fail(`unknown tool: ${name}`,'TOOL_NOT_FOUND')
}
function protocolError(code,message,data){return {code,message,...(data===undefined?{}:{data})}}
function response(id,result,error){return {jsonrpc:'2.0',id,...(error?{error}:{result})}}

export function createMcpSession({project,write=line=>process.stdout.write(`${line}\n`)}={}){
  let initialized=false,protocolVersion=null
  return raw=>{
    if(Buffer.byteLength(raw)>MAX_LINE_BYTES){write(JSON.stringify(response(null,null,protocolError(-32600,'Request exceeds 1 MiB'))));return}
    let request;try{request=JSON.parse(raw)}catch{write(JSON.stringify(response(null,null,protocolError(-32700,'Parse error'))));return}
    if(!request||Array.isArray(request)||request.jsonrpc!=='2.0'||typeof request.method!=='string'){write(JSON.stringify(response(request?.id??null,null,protocolError(-32600,'Invalid Request'))));return}
    if(request.id===undefined)return
    try{
      let result
      if(request.method==='initialize'){
        const requested=request.params?.protocolVersion
        protocolVersion=PROTOCOL_VERSIONS.includes(requested)?requested:PROTOCOL_VERSIONS[0];initialized=true
        result={protocolVersion,capabilities:{tools:{listChanged:false}},serverInfo:{name:'holoself',title:'Holoself local context',version:VERSION},instructions:'Use Holoself only when personal context can materially improve the task. The fixed project link controls access. Start with holoself_context_manifest, request only needed source handles, preserve provenance, and never treat readable content as publication approval. Durable self changes require a pending proposal and separate human approval outside MCP.'}
      }else if(request.method==='ping')result={}
      else if(!initialized)throw Object.assign(new Error('Server is not initialized'),{rpcCode:-32002})
      else if(request.method==='tools/list')result={tools:MCP_TOOLS}
      else if(request.method==='tools/call'){
        try{result=toolResult(callTool(project,request.params?.name,request.params?.arguments||{}))}catch(error){result=toolError(error)}
      }else throw Object.assign(new Error(`Method not found: ${request.method}`),{rpcCode:-32601})
      write(JSON.stringify(response(request.id,result)))
    }catch(error){write(JSON.stringify(response(request.id,null,protocolError(error.rpcCode||-32603,error.rpcCode?error.message:'Internal error'))))}
  }
}

export async function startMcpServer({project:projectInput,requireClaudeProject=false}={}){
  if(requireClaudeProject&&!process.env.CLAUDE_PROJECT_DIR)fail('CLAUDE_PROJECT_DIR is required for this project-scoped server','PROJECT_BINDING_INVALID')
  const binding=resolveBoundProject(projectInput)
  const session=createMcpSession({project:binding.project})
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false})
  for await(const line of lines)if(line.trim())session(line)
}

export { resolveBoundProject }
