import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, rmdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_LENSES, loadLensRegistry } from './lenses.mjs'
import { normalizeProjectPath, readBindings } from './bindings.mjs'

const sha=value=>createHash('sha256').update(value).digest('hex')
const slash=value=>value.replaceAll('\\','/')
export const renamedLens=id=>({career:'professional',publishing:'public-voice'}[id]||id)
function pathExists(path){try{lstatSync(path);return true}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return false;throw error}}
function safePath(root,rel){
 if(typeof rel!=='string'||!rel||isAbsolute(rel)||rel.includes('\\')||rel.split('/').some(part=>['','..','.'].includes(part)))throw new Error(`invalid maintenance path: ${rel}`)
 let rootAncestor=root;while(true){if(pathExists(rootAncestor)&&lstatSync(rootAncestor).isSymbolicLink())throw new Error('unsafe maintenance root ancestor');const parent=dirname(rootAncestor);if(parent===rootAncestor)break;rootAncestor=parent}
 const path=resolve(root,rel),local=relative(root,path);if(local==='..'||local.startsWith(`..${sep}`)||isAbsolute(local))throw new Error('maintenance path escapes root')
 let current=path;while(true){if(pathExists(current)&&lstatSync(current).isSymbolicLink())throw new Error(`unsafe maintenance path: ${rel}`);if(current===root)break;const parent=dirname(current);if(parent===current)throw new Error('maintenance root mismatch');current=parent}
 if(pathExists(path)&&!lstatSync(path).isFile())throw new Error(`maintenance target is not a file: ${rel}`)
 return path
}
const editableMarkdown=rel=>/^(?:profile|context|topics|history|reference|me)\/.*\.md$/.test(rel)||/^contribs\/local\/.*\.md$/.test(rel)
function authorized(rel,kind){if(kind==='instruction-replacement')return /^(?:AGENTS|CLAUDE)\.md$/.test(rel);return editableMarkdown(rel)||(kind==='lens-migration'&&(/^(?:AGENTS|CLAUDE|README)\.md$/.test(rel)||/^contribs\/default\/.*\.md$/.test(rel)||/^lenses\/(?:instructions\/)?[a-z][a-z0-9-]*\.json$/.test(rel)||rel==='.holoself/links.json'))}
function currentText(path){return existsSync(path)?readFileSync(path,'utf8'):null}
export function buildTransformationPlan(root,changes,{kind='section-replacement',now=new Date().toISOString()}={}){
 root=resolve(root);if(!['section-replacement','instruction-replacement','lens-migration'].includes(kind)||!Array.isArray(changes))throw new Error('invalid maintenance transformation')
 const seen=new Set(),operations=[]
 for(const change of changes){const rel=change.path;if(!authorized(rel,kind))throw new Error(`protected maintenance target: ${rel}`);const path=safePath(root,rel),key=process.platform==='win32'?rel.toLowerCase():rel;if(seen.has(key))throw new Error(`duplicate maintenance target: ${rel}`);seen.add(key)
  const before=currentText(path),after=change.after;if(after!==null&&typeof after!=='string')throw new Error('maintenance after must be exact text or null')
  if(kind!=='lens-migration'&&(before===null||after===null))throw new Error('section replacement requires an existing Markdown document')
  if(before===after)continue
  operations.push({operation:'transform',path:rel,before,after,before_sha256:before===null?null:sha(before),after_sha256:after===null?null:sha(after),reason:change.reason||kind})
 }
 operations.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 const body={schema_version:1,kind,root:slash(root),created_at:now,operations};return {...body,digest:sha(JSON.stringify(body))}
}
function renamedTokens(value){return value.replace(/\b(career|publishing)\b/g,id=>renamedLens(id))}
export function renameLensMetadata(text){
 let value=text.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/,(all,start,meta,end)=>{
  let listKey=null,mapKey=null
  const next=meta.split(/(?<=\n)/).map(line=>{
   const field=line.match(/^([a-zA-Z0-9_-]+):/)
   if(field){listKey=['access_lenses','exclude_lenses'].includes(field[1])?field[1]:null;mapKey=field[1]==='field_visibility'?'field_visibility':null
    if(['access_lenses','exclude_lenses','visibility'].includes(field[1]))return renamedTokens(line)
    if(mapKey)return line.replace(/(:\s*["']?)(career|publishing)(["']?\s*[,}])/g,(_,a,id,b)=>a+renamedLens(id)+b)
   }
   if(listKey&&/^\s+-\s*/.test(line))return line.replace(/^(\s+-\s*["']?)(career|publishing)(["']?\s*)$/,(_,a,id,b)=>a+renamedLens(id)+b)
   if(mapKey&&/^\s+[^:]+:/.test(line))return line.replace(/(:\s*["']?)(career|publishing)(["']?\s*)$/,(_,a,id,b)=>a+renamedLens(id)+b)
   return line
  }).join('')
  return start+next+end
 })
 value=value.replace(/<!-- holoself-claim visibility=(career|publishing) -->[\s\S]*?<!-- \/holoself-claim -->/g,block=>block.replace(/(visibility=)(career|publishing)/,(_,prefix,id)=>prefix+renamedLens(id)).replace(/^(- Visibility: )(career|publishing)$/gm,(_,prefix,id)=>prefix+renamedLens(id)))
 return value
}
export function buildLensMigrationPlan(root,options={}){
 root=resolve(root);const changes=[],future=new Map(),lensDir=join(root,'lenses')
 const set=(path,after,reason)=>{const existing=changes.find(item=>item.path===path);if(existing&&existing.after!==after)throw new Error(`conflicting migration targets: ${path}`);if(!existing)changes.push({path,after,reason})}
 for(const top of ['profile','context','topics','history','reference','me','contribs/local','contribs/default']){
  const base=join(root,top);if(!existsSync(base))continue;safePath(root,`${top}/.probe`)
  const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error(`unsafe migration entry: ${slash(relative(root,path))}`);if(entry.isDirectory())walk(path);else if(entry.isFile()&&entry.name.endsWith('.md')){const rel=slash(relative(root,path));set(rel,renameLensMetadata(readFileSync(path,'utf8')),'rename lens metadata and claim visibility')}}};walk(base)
 }
 for(const name of ['AGENTS.md','CLAUDE.md','README.md']){const path=safePath(root,name);if(existsSync(path))set(name,renameLensMetadata(readFileSync(path,'utf8')),'rename root metadata')}
 if(existsSync(lensDir)){
  safePath(root,'lenses/.probe')
  for(const name of readdirSync(lensDir).filter(name=>name.endsWith('.json')&&name!=='bindings.json')){
   const rel=`lenses/${name}`,path=safePath(root,rel),value=JSON.parse(readFileSync(path,'utf8')),id=renamedLens(value.id),base=DEFAULT_LENSES.find(lens=>lens.id===renamedLens(value.base_lens)),modern={schema_version:1,id,title:value.title,sensitivity_access:value.sensitivity_access||base?.sensitivity_access||[],instructions:value.instructions||base?.instructions||{purpose:''}}
   if(future.has(id))throw new Error(`conflicting lens definitions: ${id}`);future.set(id,modern)
   if(name!==`${id}.json`){set(rel,null,'retire renamed lens definition');if(existsSync(join(lensDir,`${id}.json`)))throw new Error(`renamed lens destination exists: ${id}`)}
   set(`lenses/${id}.json`,JSON.stringify(modern,null,2)+'\n','uniform lens definition')
  }
 }
 for(const lens of DEFAULT_LENSES)if(!future.has(lens.id)){future.set(lens.id,lens);set(`lenses/${lens.id}.json`,JSON.stringify(lens,null,2)+'\n','seed default lens definition')}
 const instructions=join(lensDir,'instructions');if(existsSync(instructions)){safePath(root,'lenses/instructions/.probe');for(const name of readdirSync(instructions).filter(name=>name.endsWith('.json'))){const rel=`lenses/instructions/${name}`,path=safePath(root,rel),id=renamedLens(name.slice(0,-5)),lens=future.get(id);if(!lens)throw new Error(`instructions for unknown lens: ${id}`);const next={...lens,instructions:JSON.parse(readFileSync(path,'utf8'))};future.set(id,next);const target=`lenses/${id}.json`,existing=changes.find(item=>item.path===target);if(existing)existing.after=JSON.stringify(next,null,2)+'\n';else set(target,JSON.stringify(next,null,2)+'\n','merge lens instructions');set(rel,null,'retire separate instructions override')}}
 const bindingFile=safePath(root,'lenses/bindings.json');if(existsSync(bindingFile)){
  const value=JSON.parse(readFileSync(bindingFile,'utf8'));if(value.schema_version!==1||!value.bindings||typeof value.bindings!=='object'||Array.isArray(value.bindings))throw new Error('invalid lens bindings for migration');const bindings=Object.create(null)
  for(const [project,choice] of Object.entries(value.bindings)){const key=normalizeProjectPath(project);if(Object.hasOwn(bindings,key))throw new Error(`conflicting normalized lens bindings: ${key}`);bindings[key]={default_lens:renamedLens(choice.default_lens),secondary_lenses:choice.secondary_lenses.map(renamedLens)}}
  set('lenses/bindings.json',JSON.stringify({schema_version:1,bindings},null,2)+'\n','rename bindings')
 }
 const linksFile=safePath(root,'.holoself/links.json');if(existsSync(linksFile)){const value=JSON.parse(readFileSync(linksFile,'utf8'));if(value.schema_version!==1||!Array.isArray(value.links))throw new Error('invalid attestation registry');value.links=value.links.map(entry=>({...entry,allowed_lenses:entry.allowed_lenses.map(renamedLens)}));set('.holoself/links.json',JSON.stringify(value,null,2)+'\n','rename attestation grants; preserve salts')}
 return buildTransformationPlan(root,changes,{...options,kind:'lens-migration'})
}
function writeExact(path,text,createdDirs){
 let dir=dirname(path),missing=[];while(!existsSync(dir)){missing.push(dir);dir=dirname(dir)};mkdirSync(dirname(path),{recursive:true});createdDirs.push(...missing.reverse())
 if(text===null){if(existsSync(path))rmSync(path);return}
 const temporary=`${path}.maintenance-${process.pid}`;try{writeFileSync(temporary,text,{flag:'wx'});renameSync(temporary,path)}finally{if(existsSync(temporary))rmSync(temporary)}
}
export function applyTransformationPlan(root,plan,{expectedDigest,validate,afterWrite}={}){
 root=resolve(root);const body={...plan};delete body.digest;const digest=sha(JSON.stringify(body))
 if(!expectedDigest||expectedDigest!==digest||plan.digest!==digest)throw new Error('maintenance plan digest mismatch')
 if(plan.schema_version!==1||resolve(plan.root)!==root||!['section-replacement','instruction-replacement','lens-migration'].includes(plan.kind)||!Array.isArray(plan.operations))throw new Error('invalid maintenance plan')
 const receiptRel=`.holoself/maintenance-receipts/${digest}.json`,receiptPath=safePath(root,receiptRel),targets=new Set(),ops=[]
 for(const op of plan.operations){if(op.operation!=='transform'||!authorized(op.path,plan.kind))throw new Error(`protected maintenance target: ${op.path}`);const path=safePath(root,op.path),key=process.platform==='win32'?op.path.toLowerCase():op.path;if([...targets].some(target=>target===key||target.startsWith(key+'/')||key.startsWith(target+'/')))throw new Error('duplicate or overlapping maintenance target');targets.add(key)
  for(const field of ['before','after'])if(op[field]!==null&&typeof op[field]!=='string')throw new Error('invalid transformation text')
  if(op.before_sha256!==(op.before===null?null:sha(op.before))||op.after_sha256!==(op.after===null?null:sha(op.after)))throw new Error('maintenance content hash mismatch')
  if(plan.kind!=='lens-migration'&&(op.before===null||op.after===null))throw new Error('section replacement requires existing Markdown')
  ops.push({...op,absolute:path})
 }
 if(existsSync(receiptPath)){const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));if(receipt.plan_digest!==digest||ops.some(op=>currentText(op.absolute)!==op.after))throw new Error('maintenance replay state differs from receipt');return {...receipt,receipt_path:slash(receiptPath),replayed:true}}
 for(const op of ops)if(currentText(op.absolute)!==op.before)throw new Error(`maintenance plan is stale: ${op.path}`)
 const lock=safePath(root,'.holoself/links.json.lock'),createdDirs=[];mkdirSync(dirname(lock),{recursive:true});try{writeFileSync(lock,String(process.pid),{flag:'wx'})}catch{throw new Error('maintenance authority is busy')}
 const applied=[];let receiptCreated=false
 try{
  for(const op of ops){safePath(root,op.path);if(currentText(op.absolute)!==op.before)throw new Error(`maintenance plan is stale: ${op.path}`);writeExact(op.absolute,op.after,createdDirs);applied.push(op);afterWrite?.(op)}
  loadLensRegistry(root);readBindings(root);validate?.()
  const receipt={schema_version:1,plan_digest:digest,kind:plan.kind,applied_at:new Date().toISOString(),operations:ops.map(({path,before_sha256,after_sha256,reason})=>({path,before_sha256,after_sha256,reason}))};safePath(root,receiptRel);const receiptDir=dirname(receiptPath);if(!existsSync(receiptDir)){mkdirSync(receiptDir,{recursive:true});createdDirs.push(receiptDir)};const fd=openSync(receiptPath,'wx');receiptCreated=true;try{writeFileSync(fd,JSON.stringify(receipt,null,2)+'\n')}finally{closeSync(fd)};return {...receipt,receipt_path:slash(receiptPath),replayed:false}
 }catch(error){for(const op of applied.reverse()){safePath(root,op.path);writeExact(op.absolute,op.before,[])};if(receiptCreated){safePath(root,receiptRel);rmSync(receiptPath)};rmSync(lock);for(const dir of createdDirs.reverse())try{rmdirSync(dir)}catch{};throw error}finally{if(existsSync(lock))rmSync(lock)}
}

export { safePath as safeMaintenancePath }
