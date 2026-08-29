import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseAnnotatedMarkdown } from './documents.mjs'

const digest=value=>createHash('sha256').update(value).digest('hex')
const slash=value=>value.replaceAll('\\','/')
function contained(root,path){const rel=relative(resolve(root),resolve(path));return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel))}
function markdownFiles(root){const out=[];for(const top of ['profile','context','topics']){const base=join(root,top);if(!existsSync(base))continue;const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())walk(path);else if(entry.isFile()&&entry.name.endsWith('.md'))out.push(path)}};walk(base)}return out.sort()}
export function buildCleanupPlan(root,{now=new Date().toISOString()}={}){
  root=resolve(root);const operations=[],review=[]
  for(const path of markdownFiles(root)){
    const content=readFileSync(path,'utf8'),metadata=parseAnnotatedMarkdown(content).metadata,rel=slash(relative(root,path)),status=metadata.knowledge_status||'current',expired=metadata.valid_until&&Date.parse(metadata.valid_until)<Date.parse(now)
    if(metadata.review_after&&Date.parse(metadata.review_after)<Date.parse(now)&&status==='current'&&!expired)review.push({path:rel,code:'REVIEW_OVERDUE',reason:`review_after ${metadata.review_after}`})
    const historicalSignals=[/\bhistorical\s*\([^)]*(?:weeks?|months?|years?)[^)]*\)/i,/\b(?:retired|superseded|obsolete|legacy)\b/i,/\bnever deleted\b/i,/C:[/\\](?:Cowork|PersonalOS|old)[/\\]/i]
    if(status==='current'&&historicalSignals.some(pattern=>pattern.test(content)))review.push({path:rel,code:'MANUAL_SPLIT_REQUIRED',reason:'mixed document contains historical or legacy signals; classify sections before cleanup'})
    if(!['historical','superseded'].includes(status)&&!expired)continue
    const destination=`history/${rel}`,reason=status!=='current'?`knowledge_status ${status}`:`valid_until ${metadata.valid_until}`
    operations.push({operation:'move',path:rel,destination,expected_sha256:digest(content),reason})
  }
  const legacyContribs=join(root,'contribs','default');if(existsSync(legacyContribs)&&lstatSync(legacyContribs).isDirectory())for(const entry of readdirSync(legacyContribs,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.md'))review.push({path:`contribs/default/${entry.name}`,code:'LEGACY_PUBLIC_CONTRIB_COPY',reason:'public methods are package-owned; compare hashes before reviewed removal'})
  const body={schema_version:1,root:slash(root),created_at:now,operations,review_only:review,protected:['proposals/approved/**','proposals/rejected/**','proposals/deferred/**','proposals/superseded/**','migration-manifest.json']}
  return {...body,digest:digest(JSON.stringify(body))}
}
export function applyCleanupPlan(root,plan,{expectedDigest}={}){
  root=resolve(root);const clean={...plan};delete clean.digest;const actualDigest=digest(JSON.stringify(clean));if(!expectedDigest||expectedDigest!==actualDigest||plan.digest!==actualDigest)throw new Error('cleanup plan digest mismatch')
  if(resolve(plan.root)!==root)throw new Error('cleanup plan root mismatch')
  const resolved=[]
  for(const operation of plan.operations||[]){
    if(operation.operation!=='move')throw new Error(`unsupported cleanup operation: ${operation.operation}`)
    if(/^(?:proposals\/|migration-manifest\.json$)/i.test(operation.path))throw new Error(`cleanup target is protected: ${operation.path}`)
    const from=resolve(root,operation.path),to=resolve(root,operation.destination);if(!contained(root,from)||!contained(root,to)||!slash(relative(root,to)).startsWith('history/'))throw new Error(`cleanup path escapes root: ${operation.path}`)
    if(!existsSync(from)||lstatSync(from).isSymbolicLink()||!lstatSync(from).isFile())throw new Error(`cleanup source is missing or unsafe: ${operation.path}`)
    if(digest(readFileSync(from,'utf8'))!==operation.expected_sha256)throw new Error(`cleanup plan is stale: ${operation.path}`)
    if(existsSync(to))throw new Error(`cleanup destination exists: ${operation.destination}`)
    resolved.push({...operation,from,to})
  }
  const moved=[]
  try{for(const item of resolved){mkdirSync(dirname(item.to),{recursive:true});renameSync(item.from,item.to);moved.push(item)}}catch(error){for(const item of moved.reverse())if(existsSync(item.to)){mkdirSync(dirname(item.from),{recursive:true});renameSync(item.to,item.from)}throw error}
  const receipt={schema_version:1,plan_digest:actualDigest,applied_at:new Date().toISOString(),operations:resolved.map(({path,destination,expected_sha256,reason})=>({path,destination,expected_sha256,reason}))},receiptPath=join(root,'.holoself','knowledge-cleanup-receipts',`${actualDigest}.json`)
  mkdirSync(dirname(receiptPath),{recursive:true});try{writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{encoding:'utf8',flag:'wx'})}catch(error){for(const item of moved.reverse())if(existsSync(item.to)){mkdirSync(dirname(item.from),{recursive:true});renameSync(item.to,item.from)}if(existsSync(receiptPath))rmSync(receiptPath,{force:true});throw error}
  return {...receipt,receipt_path:slash(receiptPath)}
}
