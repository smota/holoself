import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, rmdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { parseAnnotatedMarkdown } from './documents.mjs'
import { safeMaintenancePath } from './maintenance.mjs'

const digest=value=>createHash('sha256').update(value).digest('hex')
const slash=value=>value.replaceAll('\\','/')

function markdownFiles(root){const out=[];for(const top of ['profile','context','topics','reference','me']){const base=join(root,top);if(!existsSync(base))continue;safeMaintenancePath(root,`${top}/.probe`);const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error(`unsafe cleanup entry: ${path}`);if(entry.isDirectory())walk(path);else if(entry.isFile()&&entry.name.endsWith('.md'))out.push(path)}};walk(base)}return out.sort()}
export function buildCleanupPlan(root,{now=new Date().toISOString()}={}){
  root=resolve(root);const operations=[],review=[]
  for(const path of markdownFiles(root)){
    safeMaintenancePath(root,slash(relative(root,path)));const content=readFileSync(path,'utf8'),metadata=parseAnnotatedMarkdown(content).metadata,rel=slash(relative(root,path)),status=metadata.knowledge_status||'current',expired=metadata.valid_until&&Date.parse(metadata.valid_until)<Date.parse(now)
    if(metadata.review_after&&Date.parse(metadata.review_after)<Date.parse(now)&&status==='current'&&!expired)review.push({path:rel,code:'REVIEW_OVERDUE',reason:`review_after ${metadata.review_after}`})
    const historicalSignals=[/\bhistorical\s*\([^)]*(?:weeks?|months?|years?)[^)]*\)/i,/\b(?:retired|superseded|obsolete|legacy)\b/i,/\bnever deleted\b/i,/C:[/\\](?:Cowork|PersonalOS|old)[/\\]/i]
    if(status==='current'&&historicalSignals.some(pattern=>pattern.test(content)))review.push({path:rel,code:'MANUAL_SPLIT_REQUIRED',reason:'mixed document contains historical or legacy signals; classify sections before cleanup'})
    if(!['historical','superseded'].includes(status)&&!expired)continue
    const destination=`history/${rel}`,reason=status!=='current'?`knowledge_status ${status}`:`valid_until ${metadata.valid_until}`
    operations.push({operation:'move',path:rel,destination,expected_sha256:digest(content),reason})
  }
  const legacyContribs=join(root,'contribs','default');if(existsSync(legacyContribs)){safeMaintenancePath(root,'contribs/default/.probe');if(lstatSync(legacyContribs).isDirectory())for(const entry of readdirSync(legacyContribs,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.md'))review.push({path:`contribs/default/${entry.name}`,code:'LEGACY_PUBLIC_CONTRIB_COPY',reason:'public methods are package-owned; compare hashes before reviewed removal'})}
  const body={schema_version:1,root:slash(root),created_at:now,operations,review_only:review,protected:['proposals/approved/**','proposals/rejected/**','proposals/deferred/**','proposals/superseded/**','migration-manifest.json']}
  return {...body,digest:digest(JSON.stringify(body))}
}
export function applyCleanupPlan(root,plan,{expectedDigest,afterMove}={}){
  root=resolve(root);const clean={...plan};delete clean.digest;const actualDigest=digest(JSON.stringify(clean));if(!expectedDigest||expectedDigest!==actualDigest||plan.digest!==actualDigest)throw new Error('cleanup plan digest mismatch')
  if(resolve(plan.root)!==root)throw new Error('cleanup plan root mismatch')
  if(plan.schema_version!==1||!Array.isArray(plan.operations))throw new Error('invalid cleanup plan')
  const resolved=[],targets=new Set()
  for(const operation of plan.operations||[]){
    if(operation.operation!=='move')throw new Error(`unsupported cleanup operation: ${operation.operation}`)
    if(/^(?:proposals\/|migration-manifest\.json$)/i.test(operation.path))throw new Error(`cleanup target is protected: ${operation.path}`)
    if(!/^(?:profile|context|topics|reference|me)\/.*\.md$/.test(operation.path)||operation.destination!==`history/${operation.path}`)throw new Error(`unsupported cleanup target: ${operation.path}`)
    const from=safeMaintenancePath(root,operation.path),to=safeMaintenancePath(root,operation.destination)
    for(const path of [operation.path,operation.destination]){const key=process.platform==='win32'?path.toLowerCase():path;if([...targets].some(target=>target===key||target.startsWith(key+'/')||key.startsWith(target+'/')))throw new Error('duplicate or overlapping cleanup target');targets.add(key)}
    resolved.push({...operation,from,to})
  }
  const receiptRel=`.holoself/knowledge-cleanup-receipts/${actualDigest}.json`,receiptPath=safeMaintenancePath(root,receiptRel)
  if(existsSync(receiptPath)){const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));if(receipt.plan_digest!==actualDigest||resolved.some(item=>existsSync(item.from)||!existsSync(item.to)||digest(readFileSync(item.to,'utf8'))!==item.expected_sha256))throw new Error('cleanup replay state differs from receipt');return {...receipt,receipt_path:slash(receiptPath),replayed:true}}
  const check=item=>{safeMaintenancePath(root,item.path);safeMaintenancePath(root,item.destination);if(!existsSync(item.from))throw new Error(`cleanup source is missing or unsafe: ${item.path}`);if(digest(readFileSync(item.from,'utf8'))!==item.expected_sha256)throw new Error(`cleanup plan is stale: ${item.path}`);if(existsSync(item.to))throw new Error(`cleanup destination exists: ${item.destination}`)}
  for(const item of resolved)check(item)
  const lock=safeMaintenancePath(root,'.holoself/links.json.lock');mkdirSync(dirname(lock),{recursive:true});try{writeFileSync(lock,String(process.pid),{flag:'wx'})}catch{throw new Error('cleanup authority is busy')}
  const moved=[],createdDirs=[];let receiptCreated=false
  const makeDir=path=>{const missing=[];for(let current=path;!existsSync(current);current=dirname(current))missing.push(current);mkdirSync(path,{recursive:true});createdDirs.push(...missing.reverse())}
  try{
    for(const item of resolved){check(item);makeDir(dirname(item.to));safeMaintenancePath(root,item.destination);safeMaintenancePath(root,item.path);renameSync(item.from,item.to);moved.push(item);afterMove?.(item)}
    const receipt={schema_version:1,plan_digest:actualDigest,applied_at:new Date().toISOString(),operations:resolved.map(({path,destination,expected_sha256,reason})=>({path,destination,expected_sha256,reason}))}
    safeMaintenancePath(root,receiptRel);makeDir(dirname(receiptPath));const fd=openSync(receiptPath,'wx');receiptCreated=true;try{writeFileSync(fd,JSON.stringify(receipt,null,2)+'\n')}finally{closeSync(fd)}
    return {...receipt,receipt_path:slash(receiptPath),replayed:false}
  }catch(error){
    for(const item of moved.reverse()){safeMaintenancePath(root,item.destination);safeMaintenancePath(root,item.path);if(existsSync(item.from)||!existsSync(item.to)||digest(readFileSync(item.to,'utf8'))!==item.expected_sha256)throw new Error(`unsafe cleanup rollback: ${item.path}`);renameSync(item.to,item.from)}
    if(receiptCreated){safeMaintenancePath(root,receiptRel);rmSync(receiptPath)}
    for(const dir of createdDirs.reverse())try{rmdirSync(dir)}catch{}
    throw error
  }finally{safeMaintenancePath(root,'.holoself/links.json.lock');rmSync(lock)}
}
