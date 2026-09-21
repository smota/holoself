import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync, openSync, closeSync
} from 'node:fs'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { activateProject, activationPlan, activationStatus, auditInstructions, bootstrapText, deactivateProject, globalSkillStatus, installGlobalSkills, migrateProjectSkillsToGlobal, preflightActivation, readRuntime } from './adapters.mjs'
import { BUILTIN_LENS_IDS, lensIdStructurallyValid, loadLensRegistry, resolveLens } from './lenses.mjs'
import { DISCLOSURES, DOCUMENT_ROLES, SENSITIVITIES, VISIBILITIES } from './annotations.mjs'
import {
  buildCursor,
  cachedSelection,
  selectContextRecords,
  dateValue,
  ENVELOPE_BYTE_CAPS,
  CONTEXT_BUDGETS,
  contextNeed,
  relevanceScore,
  estimateTokens,
  sourceId,
  excerpt,
  contradictionDigest,
  KNOWLEDGE_STATUSES,
  TEMPORAL_SCOPES,
  temporalDisposition
} from './context-selection.mjs'
import {
  CATALOG_SCHEMA_VERSION,
  CACHE_SCHEMA_VERSION,
  SOURCE_ID_RE,
  atomicWriteFile,
  purgeLegacyIndex,
  cleanupStaleTempFiles,
  getStatTuple,
  readSourceWithStat,
  sourceRef,
  slugHeading,
  canonicalSort,
  canonicalJson,
  decisionCacheDir,
  validateCatalogSchema,
  validateDecisionCacheSchema,
  computeDecisionCacheKey,
  getDecisionCacheLimits,
  purgeInvalidDecisionCache,
  evictDecisionCache,
  readDecisionCache,
  writeDecisionCache
} from './catalog.mjs'
import {
  planPolicyMigration,
  applyPolicyMigration,
  revertPolicyMigration
} from './migration.mjs'

export { DISCLOSURES, DOCUMENT_ROLES, SENSITIVITIES, VISIBILITIES }
export const LENSES = BUILTIN_LENS_IDS
const SENSITIVITY_LENSES={
  'compensation-confidential':['career','interview','private'],
  'third-party-personal':['leadership','private'],
  'recruiter-confidential':['career','interview','private'],
  'employer-confidential':['career','technical','leadership','interview','private'],
  'application-private':['career','interview','private'],
  restricted:['private']
}
export const PROPOSAL_TYPES = ['new_fact','fact_update','fact_correction','new_story','new_preference','preference_update','new_decision','privacy_warning','conflict_resolution']
export const PROPOSAL_STATES = ['pending','approved','rejected','deferred','superseded']
const SKIP_DIRS = new Set(['.git','node_modules','.holoself','proposals','exports','.agents','.claude','.codex','.pi','.agy','.gemini','.cursor','.github','skills','Generated','generated'])
const DEFAULT_PROJECT_EXCLUDES=['.git/**','node_modules/**','.holoself/**','.agents/**','.claude/**','.codex/**','.pi/**','.agy/**','.gemini/**','.cursor/**','.github/**','skills/**','**/Generated/**','**/generated/**']
const SECRET_RE = /(-----BEGIN [A-Z ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:api[_-]?key|client[_-]?secret|password|passwd|secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?)\s*[:=]\s*["']?(?:bearer\s+)?[^\s"']{8,}|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|sk-(?:proj-)?|npm_)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s]+:[^\s]+@|(?:sig|signature|se|sp|sv)=[^&\s]{8,}(?:&|$))/i
const SECRET_FILE_RE = /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|password|private[-_]?key|access[-_]?token)[^/]*|[^/]+\.(?:pem|p12|pfx|key))(?:\.md)?$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_PREFIX_RE = /^[0-9a-f-]{8,36}$/i
const COMPENSATION_RE = /(?:\b(?:compensation|salary|base\s+pay|pay\s+(?:band|range|package)|remuneration|annual\s+pay|total\s+comp|bonus|equity|stock\s+options?|negotiat(?:e|ion))\b|[$€£]\s?\d[\d,.]*(?:\s?(?:k|m|usd|eur|gbp))?)/i
const PACKAGE_ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)))

function pathExists(path){try{lstatSync(path);return true}catch{return false}}
function safeRealpath(p){try{return realpathSync(p)}catch{return resolve(p)}}
function ensureDir(path){ mkdirSync(path,{recursive:true}) }
function atomicWrite(path, content){
  atomicWriteFile(path, content)
}
function slash(path){ return path.replaceAll('\\','/') }
function hash(text){ return createHash('sha256').update(text).digest('hex') }
function projectPath(o){ return resolve(o.project || o.target || process.cwd()) }
function assertContainedPath(root,target,label='path'){
  const rootReal=safeRealpath(root),targetReal=safeRealpath(target)
  const normRoot=slash(rootReal).replace(/\/+$/,''),normTarget=slash(targetReal)
  const cmpRoot=process.platform==='win32'?normRoot.toLowerCase():normRoot
  const cmpTarget=process.platform==='win32'?normTarget.toLowerCase():normTarget
  if(cmpTarget!==cmpRoot&&!cmpTarget.startsWith(cmpRoot+'/'))throw new Error(`${label} escapes root`)
  let current=targetReal
  while(current!==rootReal){
    if(pathExists(current)&&lstatSync(current).isSymbolicLink())throw new Error(`${label} traverses symlink: ${current}`)
    const parent=dirname(current)
    if(parent===current)break
    current=parent
  }
  return targetReal
}
function isCanonicalSelf(path){
  if(!pathExists(path))return false
  const real=safeRealpath(path)
  try{const st=lstatSync(real);if(!st.isDirectory()||st.isSymbolicLink())return false}catch{return false}
  return existsSync(join(real,'config.json'))&&existsSync(join(real,'profile'))&&existsSync(join(real,'context'))
}
function findLinkUpwards(startDir){
  let current=resolve(startDir)
  while(true){
    const holoselfDir=join(current,'.holoself')
    if(existsSync(holoselfDir)){
      try{
        if(lstatSync(holoselfDir).isSymbolicLink()){
          const parent=dirname(current)
          if(parent===current)break
          current=parent
          continue
        }
      }catch{}
    }
    const candidate=linkPath(current)
    if(pathExists(candidate))return {projectDir:current,linkFilePath:candidate}
    const parent=dirname(current)
    if(parent===current)break
    current=parent
  }
  return null
}
function getOrCreateCursorSecret(selfRoot){
  const keyPath=join(selfRoot,'.holoself','runtime','.cursor.key')
  try{if(existsSync(keyPath))return readFileSync(keyPath)}catch{}
  if(!globalThis.__HOLOSELF_CURSOR_KEY__)globalThis.__HOLOSELF_CURSOR_KEY__=randomBytes(32)
  return globalThis.__HOLOSELF_CURSOR_KEY__
}
function getIdentityId(identity,cursorSecret){
  const raw=`${identity.kind}:${identity.project||''}:${[...(identity.allowedLenses||[])].sort().join(',')}`
  return createHmac('sha256',cursorSecret).update(raw).digest('hex').slice(0,16)
}
function linkPath(project){ return join(project,'.holoself','link.yaml') }
function canonicalSpaceId(projectDir){
  const real=safeRealpath(projectDir)
  const norm=slash(real).normalize('NFC')
  const canonical=process.platform==='win32'?norm.toLowerCase():norm
  return 'hs-space-'+hash('project\0'+canonical).slice(0,16)
}
function canonicalProjectPath(projectDir){
  const real=safeRealpath(projectDir)
  const norm=slash(real).normalize('NFC')
  return process.platform==='win32'?norm.toLowerCase():norm
}
function registryLockPath(selfRoot){ return join(selfRoot,'.holoself','links.json.lock') }
function registryFilePath(selfRoot){ return join(selfRoot,'.holoself','links.json') }
function isPidAlive(pid){
  if(!pid||typeof pid!=='number')return false
  try{process.kill(pid,0);return true}catch(err){return err.code==='EPERM'}
}
async function withRegistryLock(selfRoot,fn){
  const lockPath=registryLockPath(selfRoot)
  ensureDir(dirname(lockPath))
  const backoffs=[50,150,450]
  let acquired=false
  for(let attempt=0;attempt<=backoffs.length;attempt++){
    try{
      const fd=openSync(lockPath,'wx')
      const payload=JSON.stringify({pid:process.pid,timestamp:Date.now()})+'\n'
      writeFileSync(fd,payload,'utf8')
      closeSync(fd)
      acquired=true
      break
    }catch(err){
      if(err.code==='EEXIST'){
        let isStale=false
        try{
          const raw=readFileSync(lockPath,'utf8')
          const parsed=JSON.parse(raw)
          const age=Date.now()-(parsed.timestamp||0)
          if(age>5000||(parsed.pid&&!isPidAlive(parsed.pid)))isStale=true
        }catch{isStale=true}
        if(isStale){
          try{rmSync(lockPath,{force:true})}catch{}
          continue
        }
        if(attempt<backoffs.length){
          await new Promise(r=>setTimeout(r,backoffs[attempt]))
          continue
        }
      }else{throw err}
    }
  }
  if(!acquired){
    const err=new Error('Timeout acquiring links registry lock')
    err.code='REGISTRY_LOCK_TIMEOUT'
    throw err
  }
  try{return await fn()}finally{try{rmSync(lockPath,{force:true})}catch{}}
}
function readRegistry(selfRoot){
  const path=registryFilePath(selfRoot)
  if(!pathExists(path))return {raw:null,baseHash:'__ABSENT__',registry_hash:'__ABSENT__',links:[]}
  const raw=readFileSync(path,'utf8'),baseHash=hash(raw)
  let parsed
  try{parsed=JSON.parse(raw)}catch{const error=new Error(`corrupted links registry: ${path}`);error.code='REGISTRY_CORRUPT';throw error}
  if(!parsed||parsed.schema_version!==1||!Array.isArray(parsed.links)){const error=new Error(`invalid links registry schema: ${path}`);error.code='REGISTRY_SCHEMA_INVALID';throw error}
  return {raw,baseHash,registry_hash:baseHash,links:parsed.links}
}
function writeRegistry(selfRoot,linksOrFn,baseHash){
  const path=registryFilePath(selfRoot)
  const currentBaseHash=pathExists(path)?hash(readFileSync(path,'utf8')):'__ABSENT__'
  if(baseHash!==undefined&&currentBaseHash!==baseHash){const err=new Error('Concurrent modification detected in links registry');err.code='REGISTRY_CONCURRENT_MODIFICATION';throw err}
  let currentLinks=[]
  if(pathExists(path)){
    try{
      const parsed=JSON.parse(readFileSync(path,'utf8'))
      if(parsed&&Array.isArray(parsed.links))currentLinks=parsed.links
    }catch{}
  }
  const links=typeof linksOrFn==='function'?linksOrFn([...currentLinks]):linksOrFn
  const sortedLinks=[...links].sort((a,b)=>canonicalSort(a.project_id,b.project_id))
  const payload={schema_version:1,links:sortedLinks}
  ensureDir(dirname(path))
  atomicWriteFile(path,JSON.stringify(payload,null,2)+'\n')
  return hash(JSON.stringify(payload,null,2)+'\n')
}
function computeLinksRegisterHash(links){
  if(!links||!links.length)return hash('[]')
  const normalized=links.map(l=>({project_id:l.project_id,binding_salt:l.binding_salt,allowed_lenses:[...l.allowed_lenses].sort(canonicalSort),status:l.status})).sort((a,b)=>canonicalSort(a.project_id,b.project_id))
  return hash(canonicalJson(normalized))
}
function updateLinkBindingSaltInPlace(projectDir,salt){
  const filePath=assertContainedPath(projectDir,linkPath(projectDir),'link configuration')
  if(!pathExists(filePath)||lstatSync(filePath).isSymbolicLink()||!lstatSync(filePath).isFile())throw new Error(`cannot update link configuration in-place: invalid file ${filePath}`)
  const raw=readFileSync(filePath,'utf8')
  const lines=raw.split(/\r?\n/)
  let selfContextLine=-1,selfContextIndent=0,bindingSaltLine=-1,insertLine=-1
  for(let i=0;i<lines.length;i++){
    const line=lines[i]
    if(/^self_context:\s*$/.test(line.trimEnd())){selfContextLine=i;selfContextIndent=line.length-line.trimStart().length;continue}
    if(selfContextLine>=0&&i>selfContextLine){
      const indent=line.length-line.trimStart().length
      if(line.trim()&&!line.trimStart().startsWith('#')){
        if(indent<=selfContextIndent){if(insertLine<0)insertLine=i;break}
        if(/^binding_salt:\s*/.test(line.trimStart())){bindingSaltLine=i;break}
      }
    }
  }
  if(selfContextLine<0)throw new Error('Cannot update binding_salt: self_context section missing')
  if(bindingSaltLine>=0){
    const currentLine=lines[bindingSaltLine]
    const indent=currentLine.slice(0,currentLine.length-currentLine.trimStart().length)
    lines[bindingSaltLine]=`${indent}binding_salt: ${quote(salt)}`
  }else{
    const indent='  '
    if(insertLine>=0)lines.splice(insertLine,0,`${indent}binding_salt: ${quote(salt)}`)
    else lines.splice(selfContextLine+1,0,`${indent}binding_salt: ${quote(salt)}`)
  }
  atomicWriteFile(filePath,lines.join('\n')+(raw.endsWith('\n')?'':'\n'))
}
function quote(value){ return JSON.stringify(value ?? '') }
function stripYamlComment(value){let quote=null,escaped=false;for(let i=0;i<value.length;i++){const c=value[i];if(escaped){escaped=false;continue}if(c==='\\'&&quote==='"'){escaped=true;continue}if((c==='"'||c==="'")&&(!quote||quote===c)){quote=quote?null:c;continue}if(c==='#'&&!quote&&(i===0||/\s/.test(value[i-1])))return value.slice(0,i).trimEnd()}return value}
function parseScalar(value){
  const v=stripYamlComment(value).trim()
  if(!v || v==='null' || v==='~') return null
  if(v==='true') return true; if(v==='false') return false
  if(/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v)
  if(v.startsWith('[')){if(!v.endsWith(']'))throw new Error(`invalid YAML scalar: ${v}`);try{return JSON.parse(v)}catch{const inner=v.slice(1,-1).trim();return inner?inner.split(',').map(item=>parseScalar(item)):[]}}
  if(v.startsWith('{')||v.startsWith('"')){try{return JSON.parse(v)}catch{throw new Error(`invalid YAML scalar: ${v}`)}}
  if(v.startsWith("'")){if(!v.endsWith("'"))throw new Error(`invalid YAML scalar: ${v}`);return v.slice(1,-1).replaceAll("''", "'")}
  return v
}
function parseYaml(text){
  const lines=[]
  for(const [lineNumber,raw] of text.split(/\r?\n/).entries()){
    if(!raw.trim()||raw.trimStart().startsWith('#'))continue
    if(raw.includes('\t'))throw new Error(`invalid YAML indentation at line ${lineNumber+1}`)
    const text=stripYamlComment(raw.trim());if(!text)continue;lines.push({indent:raw.length-raw.trimStart().length,text,line:lineNumber+1})
  }
  if(!lines.length)return {}
  const parseBlock=(start,indent)=>{
    const array=lines[start].text.startsWith('- '),value=array?[]:Object.create(null);let i=start
    while(i<lines.length){
      const item=lines[i];if(item.indent<indent)break;if(item.indent>indent)throw new Error(`unexpected YAML indentation at line ${item.line}`)
      if(array){
        if(!item.text.startsWith('- '))throw new Error(`mixed YAML list and mapping at line ${item.line}`)
        const raw=item.text.slice(2).trim();if(!raw)throw new Error(`empty YAML list item at line ${item.line}`)
        value.push(parseScalar(raw));i++;continue
      }
      if(item.text.startsWith('- '))throw new Error(`unexpected YAML list item at line ${item.line}`)
      const match=item.text.match(/^([^:#][^:]*):(?:\s*(.*))?$/);if(!match)throw new Error(`invalid YAML mapping at line ${item.line}`)
      const key=match[1].trim(),raw=match[2]??'';if(['__proto__','prototype','constructor'].includes(key))throw new Error(`unsafe YAML key ${key} at line ${item.line}`);if(Object.hasOwn(value,key))throw new Error(`duplicate YAML key ${key} at line ${item.line}`)
      if(['>','>-','|','|-'].includes(raw)){
        const chunks=[];let j=i+1;while(j<lines.length&&lines[j].indent>indent){chunks.push(lines[j].text);j++}
        const folded=raw.startsWith('>'),keepNewline=!raw.endsWith('-');value[key]=(folded?chunks.join(' '):chunks.join('\n'))+(keepNewline?'\n':'');i=j;continue
      }
      if(raw!==''){value[key]=parseScalar(raw);i++;continue}
      const next=lines[i+1]
      if(!next||next.indent<=indent){value[key]=null;i++;continue}
      const child=parseBlock(i+1,next.indent);value[key]=child.value;i=child.next
    }
    return {value,next:i}
  }
  if(lines[0].indent!==0)throw new Error(`invalid YAML root indentation at line ${lines[0].line}`)
  const parsed=parseBlock(0,0);if(parsed.next!==lines.length)throw new Error(`invalid YAML at line ${lines[parsed.next].line}`);if(Array.isArray(parsed.value))throw new Error('YAML root must be a mapping');return parsed.value
}
function yamlObject(object, indent=''){
  let out=''
  for(const [key,value] of Object.entries(object)){
    if(Array.isArray(value)){
      if(!value.length)out+=`${indent}${key}: []\n`
      else {out+=`${indent}${key}:\n`;for(const item of value)out+=`${indent}  - ${quote(item)}\n`}
    } else if(value && typeof value==='object') out+=`${indent}${key}:\n${yamlObject(value,indent+'  ')}`
    else out+=`${indent}${key}: ${typeof value==='string'?quote(value):String(value)}\n`
  }
  return out
}
function linkSchemaErrors(link,registry=null){
  const errors=[],allowedKeys=new Set(['path','access','proposals','index','default_lens','secondary_lenses','binding_salt']),known=id=>registry?registry.byId.has(id):lensIdStructurallyValid(id)
  if(!link||Array.isArray(link)||typeof link!=='object')return ['self_context must be a mapping']
  for(const key of Object.keys(link))if(!allowedKeys.has(key))errors.push(`unknown self_context field: ${key}`)
  if(typeof link.path!=='string'||!link.path.trim())errors.push('self_context.path must be a non-empty string')
  if(link.access!=='read')errors.push('self_context.access must be read')
  if(!['enabled','disabled'].includes(link.proposals))errors.push('self_context.proposals must be enabled or disabled')
  if(link.index!=='local')errors.push('self_context.index must be local')
  if(link.default_lens==='private')errors.push('default_lens cannot be private: private is owner-exclusive')
  else if(!known(link.default_lens))errors.push(`invalid default lens: ${link.default_lens}`)
  if(link.secondary_lenses!==undefined){
    if(!Array.isArray(link.secondary_lenses)||link.secondary_lenses.some(x=>typeof x!=='string'||!known(x)))errors.push('secondary_lenses must contain only known lenses')
    else if(link.secondary_lenses.includes('private'))errors.push('secondary_lenses cannot include private: private is owner-exclusive')
    else if(new Set(link.secondary_lenses).size!==link.secondary_lenses.length)errors.push('secondary_lenses must contain unique lenses')
  }
  if(link.binding_salt!==undefined){
    if(typeof link.binding_salt!=='string'||!/^[0-9a-f]{32}$/.test(link.binding_salt))errors.push('binding_salt must be a 32-character hex string')
  }
  return errors
}
function projectContextErrors(value){const errors=[];if(value===undefined)return errors;if(!value||Array.isArray(value)||typeof value!=='object')return ['project_context must be a mapping'];for(const key of Object.keys(value))if(!['include','exclude','assert_include','assert_exclude'].includes(key))errors.push(`unknown project_context field: ${key}`);for(const key of ['include','exclude','assert_include','assert_exclude'])if(value[key]!==undefined&&(!Array.isArray(value[key])||value[key].some(x=>typeof x!=='string'||!x.trim())))errors.push(`project_context.${key} must be a string array`);return errors}
function readLink(project,{tolerant=false}={}){
  const holoselfDir=join(project,'.holoself')
  if(existsSync(holoselfDir)&&lstatSync(holoselfDir).isSymbolicLink()){
    const error=new Error(`legacy filesystem junction mount detected at ${holoselfDir}; run holoself link setup to migrate to a bounded link`)
    error.code='LEGACY_MOUNT_DETECTED'
    throw error
  }
  const path=assertContainedPath(project,linkPath(project),'link configuration');if(!pathExists(path))throw new Error(`link configuration missing: ${path}`)
  if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error(`link configuration is not a regular file: ${path}`)
  let parsed;try{parsed=parseYaml(readFileSync(path,'utf8'))}catch(error){throw new Error(`malformed link configuration ${path}: ${error.message}`)}
  if(!Object.hasOwn(parsed,'self_context'))throw new Error(`malformed link configuration ${path}: self_context mapping missing`)
  for(const key of Object.keys(parsed))if(!['self_context','project_context'].includes(key))throw new Error(`malformed link configuration ${path}: unknown root field ${key}`)
  const structuralErrors=[...linkSchemaErrors(parsed.self_context),...projectContextErrors(parsed.project_context)];if(structuralErrors.length&&!tolerant)throw new Error(`invalid link configuration ${path}: ${structuralErrors.join('; ')}`)
  const selfPath=resolve(project,parsed.self_context.path);let registry=null;try{registry=loadLensRegistry(selfPath)}catch(err){if(!tolerant)throw err}
  const errors=linkSchemaErrors(parsed.self_context,registry);if(errors.length&&!tolerant)throw new Error(`invalid link configuration ${path}: ${errors.join('; ')}`)
  return {...parsed.self_context,path:selfPath,secondary_lenses:[...(parsed.self_context.secondary_lenses||[])],binding_salt:parsed.self_context.binding_salt||null,project_context:{include:parsed.project_context?.include||['**/*.md'],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(parsed.project_context?.exclude||[])],assert_include:parsed.project_context?.assert_include||[],assert_exclude:parsed.project_context?.assert_exclude||[]},_schemaErrors:[...structuralErrors,...errors]}
}
function writeLink(project,self,lens='general',secondary=[],projectContext={},bindingSalt=null){
  const registry=loadLensRegistry(resolve(self))
  let salt=bindingSalt
  if(!salt){
    try{
      if(pathExists(linkPath(project))){
        const existing=readLink(project,{tolerant:true})
        if(existing.binding_salt&&/^[0-9a-f]{32}$/.test(existing.binding_salt))salt=existing.binding_salt
      }
    }catch{}
  }
  const selfContext={path:slash(resolve(self)),access:'read',proposals:'enabled',index:'local',default_lens:lens,secondary_lenses:secondary}
  if(salt)selfContext.binding_salt=salt
  const data={self_context:selfContext,project_context:{include:projectContext.include||['**/*.md'],exclude:projectContext.exclude||DEFAULT_PROJECT_EXCLUDES,assert_include:projectContext.assert_include||[],assert_exclude:projectContext.assert_exclude||[]}},errors=[...linkSchemaErrors(data.self_context,registry),...projectContextErrors(data.project_context)];if(errors.length)throw new Error(errors.join('; '))
  atomicWrite(linkPath(project),yamlObject(data));return {...data.self_context,project_context:data.project_context}
}
function managedReadme(){ return `# Linked Holoself context\n\nProject owns artifacts. Linked self owns approved reusable knowledge.\n\n- \`link.yaml\` grants read access and proposal delivery; it never copies self files.\n- \`index/\` is local, rebuildable acceleration data. Markdown remains source of truth.\n- \`proposals/\` and \`reports/\` are review artifacts.\n` }
function inspectLinkCollisions(project){
  const root=join(project,'.holoself'),collisions=[]
  if(pathExists(root)){
    const stat=lstatSync(root);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`${root} is not a regular metadata directory; refusing to replace`)
    const readme=join(root,'README.md');if(pathExists(readme)){const rs=lstatSync(readme);if(rs.isSymbolicLink()||!rs.isFile())throw new Error(`${readme} is not a regular file; refusing to replace`);if(readFileSync(readme,'utf8')!==managedReadme())collisions.push(readme)}
    const link=linkPath(project);if(pathExists(link))collisions.push(link)
    for(const dir of ['catalog','proposals','reports']){const path=join(root,dir);if(pathExists(path)&&(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory()))throw new Error(`${path} is not a regular directory; refusing to replace`)}
  }
  return collisions
}
function createLinkDirs(project,{preserveReadme=false}={}){
  const root=join(project,'.holoself');ensureDir(root)
  for(const dir of ['catalog','proposals','reports'])ensureDir(join(root,dir))
  try{purgeLegacyIndex(project)}catch{}
  const readme=join(root,'README.md');if(!pathExists(readme))atomicWrite(readme,managedReadme());else if(!preserveReadme&&readFileSync(readme,'utf8')!==managedReadme())throw new Error(`${readme} exists with user content; refusing to replace`)
}
function secretFile(path,root){return SECRET_FILE_RE.test(slash(relative(root,path)))}
function globRegex(pattern){const p=slash(pattern);let s='';for(let i=0;i<p.length;i++){const c=p[i];if(c==='*'&&p[i+1]==='*'){i++;if(p[i+1]==='/'){i++;s+='(?:.*/)?'}else s+='.*'}else if(c==='*')s+='[^/]*';else if(c==='?')s+='[^/]';else s+=/[.\\+^$(){}|[\]]/.test(c)?`\\${c}`:c}return new RegExp(`^${s}$`,'i')}
function matchesAny(path,patterns){return patterns.some(pattern=>globRegex(pattern).test(path))}
function markdownFiles(root,{includeHoloself=false,skipDirs=SKIP_DIRS}={}){
  const files=[]
  if(!existsSync(root)) return files
  const walk=dir=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink()) continue
      if(entry.isDirectory() && (skipDirs.has(entry.name) || (!includeHoloself && entry.name==='.holoself'))) continue
      const path=join(dir,entry.name)
      if(entry.isDirectory()) walk(path)
      else if(entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
    }
  }
  walk(root); return files.sort()
}
function projectMarkdownFiles(root,link){const config=link?.project_context||{include:['**/*.md'],exclude:DEFAULT_PROJECT_EXCLUDES};return markdownFiles(root,{skipDirs:new Set(['.git','node_modules','.holoself'])}).filter(path=>{const rel=slash(relative(root,path));return matchesAny(rel,config.include)&&!matchesAny(rel,config.exclude)})}
const PRIVACY_FIELDS=new Set(['access_lenses','disclosure','sensitivity','document_role','task_include','task_exclude','visibility','read_scope','public_safe','confidence','exclude_lenses','field_visibility','knowledge_status','temporal_scope','valid_from','valid_until','review_after','supersedes','superseded_by'])
function privacyValueValid(key,value,registry=null){
  const known=item=>typeof item==='string'&&(registry?registry.byId.has(item):lensIdStructurallyValid(item))
  if(key==='access_lenses')return Array.isArray(value)&&value.length>0&&value.every(known)&&new Set(value).size===value.length
  if(key==='disclosure')return typeof value==='string'&&DISCLOSURES.includes(value)
  if(key==='sensitivity')return typeof value==='string'&&SENSITIVITIES.includes(value)
  if(key==='document_role')return typeof value==='string'&&DOCUMENT_ROLES.includes(value)
  if(key==='task_include'||key==='task_exclude')return Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==='string'&&Boolean(item.trim()))&&new Set(value).size===value.length
  if(key==='visibility')return typeof value==='string'&&VISIBILITIES.includes(value)
  if(key==='read_scope')return typeof value==='string'&&['shared','local','restricted'].includes(value)
  if(key==='public_safe')return typeof value==='boolean'
  if(key==='confidence')return typeof value==='string'&&Boolean(value.trim())
  if(key==='exclude_lenses')return Array.isArray(value)&&value.every(known)
  if(key==='field_visibility')return value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(item=>typeof item==='string'&&VISIBILITIES.includes(item))
  if(key==='knowledge_status')return typeof value==='string'&&KNOWLEDGE_STATUSES.includes(value)
  if(key==='temporal_scope')return typeof value==='string'&&TEMPORAL_SCOPES.includes(value)
  if(['valid_from','valid_until','review_after'].includes(key))return typeof value==='string'&&/^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/.test(value)&&!Number.isNaN(Date.parse(value.includes('T')?value:value+'T00:00:00.000Z'))
  if(key==='supersedes')return Array.isArray(value)&&value.every(item=>typeof item==='string'&&Boolean(item.trim()))
  if(key==='superseded_by')return typeof value==='string'&&Boolean(item.trim())
  return true
}
function privacyMetadataErrors(metadata,registry=null){const errors=[];for(const key of PRIVACY_FIELDS)if(Object.hasOwn(metadata,key)&&!privacyValueValid(key,metadata[key],registry)){const value=typeof metadata[key]==='string'?metadata[key]:JSON.stringify(metadata[key]);errors.push(key==='visibility'?`invalid visibility ${value}`:`invalid ${key} value ${value}`)}return errors}
function canonicalPrivacyMetadataErrors(metadata,registry=null){
  const errors=privacyMetadataErrors(metadata,registry)
  if(!Object.hasOwn(metadata,'access_lenses')&&!Object.hasOwn(metadata,'visibility'))errors.push('canonical privacy metadata missing access_lenses or legacy visibility')
  if(Object.hasOwn(metadata,'access_lenses'))for(const key of ['disclosure','sensitivity','document_role']){
    if(!Object.hasOwn(metadata,key))errors.push(`canonical metadata missing ${key}`)
    else if(!privacyValueValid(key,metadata[key],registry)&&!errors.some(error=>error.startsWith(`invalid ${key} `)))errors.push(`invalid ${key} value`)
  }
  if(metadata.visibility==='public-safe'&&metadata.public_safe===false)errors.push('conflicting legacy privacy metadata: visibility public-safe with public_safe false')
  if(metadata.valid_from&&metadata.valid_until){
    const from=Date.parse(metadata.valid_from.includes('T')?metadata.valid_from:metadata.valid_from+'T00:00:00.000Z')
    const until=Date.parse(metadata.valid_until.includes('T')?metadata.valid_until:metadata.valid_until+'T23:59:59.999Z')
    if(from>until)errors.push('valid_from must not be after valid_until')
  }
  if(metadata.knowledge_status==='superseded'&&!metadata.superseded_by)errors.push('superseded knowledge must name superseded_by')
  return [...new Set(errors)]
}
function restrictPrivacyMetadata(metadata){metadata.access_lenses=['private'];metadata.disclosure='internal-only';metadata.document_role='content';metadata.visibility='private';metadata.read_scope='restricted';metadata.public_safe=false;metadata.sensitivity='restricted';return metadata}
function salvagePrivacyFrontmatter(raw,{forcePrivate=false,registry=null}={}){
  const metadata={},recognized=PRIVACY_FIELDS,seen=new Set(),lines=raw.split(/\r?\n/)
  let malformed=false,block=null
  const finishBlock=()=>{if(block&&!block.items)malformed=true;block=null}
  for(const line of lines){
    const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#'))continue
    const indent=line.length-line.trimStart().length
    if(indent===0){
      finishBlock();const match=trimmed.match(/^([^:#][^:]*):\s*(.*)$/);if(!match)continue
      const key=match[1].trim(),scalar=match[2].trim();if(!recognized.has(key))continue
      if(seen.has(key))malformed=true;seen.add(key)
      if((key==='access_lenses'||key==='exclude_lenses'||key==='task_include'||key==='task_exclude'||key==='field_visibility')&&!scalar){metadata[key]=key==='field_visibility'?{}:[];block={key,items:0};continue}
      if(!scalar){malformed=true;continue}
      try{const value=parseScalar(scalar);if(privacyValueValid(key,value,registry))metadata[key]=value;else malformed=true}catch{malformed=true}
      continue
    }
    if(!block)continue
    if(['exclude_lenses','access_lenses','task_include','task_exclude'].includes(block.key)){
      const item=trimmed.match(/^-\s+(.+)$/);if(!item){malformed=true;continue}
      try{const value=parseScalar(item[1]),valid=typeof value==='string'&&(block.key.startsWith('task_')?Boolean(value.trim()):(registry?registry.byId.has(value):lensIdStructurallyValid(value)));if(valid){metadata[block.key].push(value);block.items++}else malformed=true}catch{malformed=true}
    }else{
      const item=trimmed.match(/^([^:#][^:]*):\s*(.+)$/);if(!item){malformed=true;continue}
      try{const value=parseScalar(item[2]);if(typeof value==='string'&&VISIBILITIES.includes(value)){metadata.field_visibility[item[1].trim()]=value;block.items++}else malformed=true}catch{malformed=true}
    }
  }
  finishBlock();if(forcePrivate||malformed||privacyMetadataErrors(metadata,registry).length)restrictPrivacyMetadata(metadata);return metadata
}
function frontmatter(text,{tolerant=false,registry=null}={}){
  if(!text.startsWith('---\n') && !text.startsWith('---\r\n')) return {metadata:{},body:text,warnings:[]}
  const end=text.indexOf('\n---',4)
  if(end<0){if(!tolerant)throw new Error('unclosed frontmatter');return {metadata:salvagePrivacyFrontmatter(text.slice(4),{forcePrivate:true,registry}),body:text.slice(4),warnings:['unclosed project frontmatter restricted to private']}}
  const raw=text.slice(4,end),body=text.slice(end+4).replace(/^\r?\n/,'');let metadata
  try{metadata=parseYaml(raw)}catch(error){if(!tolerant)throw error;metadata=salvagePrivacyFrontmatter(raw,{registry});if(!Object.keys(metadata).length)restrictPrivacyMetadata(metadata);return {metadata,body,warnings:[`unsupported project frontmatter parsed conservatively: ${error.message}`]}}
  const privacyErrors=privacyMetadataErrors(metadata,registry)
  if(privacyErrors.length){if(!tolerant)throw new Error(privacyErrors.join('; '));restrictPrivacyMetadata(metadata);return {metadata,body,warnings:[`invalid project privacy metadata restricted: ${privacyErrors.join(', ')}`]}}
  return {metadata,body,warnings:[]}
}
function sections(text){
  const result=[]; let heading='(document)', lines=[]
  const flush=()=>{ const content=lines.join('\n').trim(); if(content) result.push({heading,content}) }
  for(const line of text.split(/\r?\n/)){
    const match=line.match(/^#{1,6}\s+(.+)$/)
    if(match){ flush(); heading=match[1].trim(); lines=[] } else lines.push(line)
  }
  flush(); return result
}
function links(text){ return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1]) }
function tags(text){ return [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map(m=>m[1]))].sort() }
function claims(text){
  return text.split(/\r?\n/).map(x=>x.replace(/^[-*]\s+/,'').trim()).filter(x=>x.length>=20 && !x.startsWith('#')).slice(0,50)
}
function canonicalClaims(text){
  const {body}=frontmatter(text),found=[]
  const blocks=[...body.matchAll(/<!-- holoself-claim visibility=[a-z-]+ -->([\s\S]*?)<!-- \/holoself-claim -->/g)]
  for(const [,block] of blocks){const lines=block.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')&&!/^[-*]\s+(?:Evidence|Confidence|Visibility|Provenance|Approved):/i.test(x));if(lines.length)found.push(lines.join(' '))}
  const withoutBlocks=body.replace(/<!-- holoself-claim visibility=[a-z-]+ -->[\s\S]*?<!-- \/holoself-claim -->/g,'')
  for(const section of sections(withoutBlocks)){
    if(!/^CLAIM(?:[- _]|$)/i.test(section.heading))continue
    const approved=section.content.split(/\r?\n/).map(line=>line.match(/^\s*[-*]?\s*\*\*Approved wording:\*\*\s*(.+?)\s*$/i)?.[1]).filter(Boolean)
    if(approved.length)found.push(...approved)
    else {const prose=section.content.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!/^[-*|]/.test(x)&&!/^\*\*[^*]+:\*\*/.test(x));if(prose.length)found.push(prose.join(' '))}
  }
  return found.map(x=>x.trim()).filter(Boolean)
}
function visibility(meta){ return meta.visibility || 'linked-projects' }
function legacyAccessLenses(meta){
  const v=visibility(meta)
  if(v==='private')return ['private']
  if(v==='career')return ['general','career','interview','private']
  if(v==='publishing')return ['general','publishing','private']
  return [...LENSES]
}
function accessLenses(meta){return Array.isArray(meta.access_lenses)?meta.access_lenses:legacyAccessLenses(meta)}
function disclosure(meta){
  if(meta.public_safe===false)return 'review-required'
  if(DISCLOSURES.includes(meta.disclosure))return meta.disclosure
  if(meta.public_safe===true||visibility(meta)==='public-safe')return 'publish-approved'
  return 'internal-only'
}
function documentRole(meta){return DOCUMENT_ROLES.includes(meta.document_role)?meta.document_role:'content'}
function publicationAllowed(meta){return disclosure(meta)==='publish-approved'&&!['compensation-confidential','third-party-personal','recruiter-confidential','employer-confidential','application-private','restricted'].includes(meta.sensitivity||'')}
function taskAllowed(meta,task){
  const include=Array.isArray(meta.task_include)?meta.task_include:[],exclude=Array.isArray(meta.task_exclude)?meta.task_exclude:[],value=(task||'').trim().toLowerCase()
  if(include.length&&(!value||!include.some(pattern=>value.includes(pattern.toLowerCase()))))return false
  return !value||!exclude.some(pattern=>value.includes(pattern.toLowerCase()))
}
function visibleUnderBehavior(visibility,behaviorLens,adapter='generic'){
  const v=VISIBILITIES.includes(visibility)?visibility:'private'
  if(['obsidian-public','public','restricted-host'].includes(adapter))return v==='public-safe'
  return legacyAccessLenses({visibility:v}).includes(behaviorLens)
}
function allowedDocument(meta,lens,adapter='generic',task=null,resolution=null,subject=null,sourceSpaceId=null){
  const subj=subject||{kind:'owner:direct',accessible_spaces:['self','contrib']}
  const srcSpace=sourceSpaceId||'self'
  const explicitReadScope=['shared','local','restricted'].includes(meta.read_scope)?meta.read_scope:null
  const readScope=explicitReadScope||(visibility(meta)==='private'?'restricted':'shared')
  if(explicitReadScope==='restricted'){
    if(!(subj.kind==='owner:direct'&&resolution?.source==='builtin'&&lens==='private')){
      return {allowed:false,reason:'restricted read_scope requires direct owner under private lens',phase:1}
    }
  }else if(readScope==='local'){
    const accSpaces=subj.accessible_spaces||[]
    if(!accSpaces.includes(srcSpace)){
      return {allowed:false,reason:`local read_scope not accessible from space ${srcSpace}`,phase:1}
    }
  }
  if(subj.kind==='client:linked'){
    if(lens==='private')return {allowed:false,reason:'private lens not granted to linked client',phase:2}
    if(subj.effective_allowed_lenses&&!subj.effective_allowed_lenses.has(lens)){
      return {allowed:false,reason:`lens ${lens} not in effective allowed lenses`,phase:2}
    }
  }
  const docAccessLenses=accessLenses(meta)
  if(!docAccessLenses.includes(lens))return {allowed:false,reason:`access_lenses exclude ${lens} lens`,phase:3}
  const excluded=Array.isArray(meta.exclude_lenses)?meta.exclude_lenses:[]
  if(excluded.includes(lens))return {allowed:false,reason:`access_lenses exclude ${lens} lens`,phase:4}
  if(!taskAllowed(meta,task))return {allowed:false,reason:`task selector excludes ${task||'(unspecified task)'}`,phase:5}
  const sensitivity=meta.sensitivity||''
  if(sensitivity==='restricted'){
    if(!(subj.kind==='owner:direct'&&resolution?.source==='builtin'&&lens==='private')){
      return {allowed:false,reason:`sensitivity ${sensitivity} excludes ${lens} lens`,phase:6}
    }
  }
  if(readScope==='restricted'){
    if(!(subj.kind==='owner:direct'&&resolution?.source==='builtin'&&lens==='private')){
      return {allowed:false,reason:'restricted read_scope requires direct owner under private lens',phase:1}
    }
  }
  const custom=resolution?.source==='registry'
  if(custom){
    if(sensitivity==='restricted')return {allowed:false,reason:'sensitivity restricted excludes custom lens',phase:6}
    if(SENSITIVITY_LENSES[sensitivity]&&!resolution.sensitivity_access.includes(sensitivity)){
      return {allowed:false,reason:`sensitivity ${sensitivity} excludes ${lens} lens`,phase:6}
    }
  }else{
    if(documentRole(meta)!=='policy'&&SENSITIVITY_LENSES[sensitivity]&&!SENSITIVITY_LENSES[sensitivity].includes(lens)){
      return {allowed:false,reason:`sensitivity ${sensitivity} excludes ${lens} lens`,phase:6}
    }
  }
  if((adapter==='obsidian-public'||adapter==='public'||adapter==='restricted-host')&&!publicationAllowed(meta)){
    return {allowed:false,reason:'not approved for publication on public adapter',phase:7}
  }
  return {allowed:true,reason:null,phase:null}
}
function allowed(meta,lens,adapter='generic',task=null,resolution=null,subject=null,sourceSpaceId=null){
  return allowedDocument(meta,lens,adapter,task,resolution,subject,sourceSpaceId).allowed
}
function tokenize(text){ return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]) }
function relevance(text,task){
  if(!task) return 0; const wanted=tokenize(task); const got=tokenize(text); let score=0
  for(const token of wanted) if(got.has(token)) score++
  return score
}
function canonicalFiles(root,{includeHistory=false}={}){
  let files=[...markdownFiles(join(root,'profile')),...markdownFiles(join(root,'context'))]
  if(includeHistory)files.push(...markdownFiles(join(root,'history')))
  const current=join(root,'topics','.current');if(existsSync(current)){const topic=readFileSync(current,'utf8').trim();if(topic){const path=join(root,'topics',topic.endsWith('.md')?topic:`${topic}.md`);if(existsSync(path))files.push(path)}}
  return [...new Set(files)].sort()
}
function filterClaimVisibility(body,lens,source,restrictions,resolution=null,identityKind='owner:direct'){
  const behaviorLens=resolution?.base_lens||lens
  return body.replace(/<!-- holoself-claim visibility=([a-z-]+) -->[\s\S]*?<!-- \/holoself-claim -->/g,(block,claimVisibility)=>{
    if(visibleUnderBehavior(claimVisibility,behaviorLens,'generic'))return block
    if(identityKind==='owner:direct')restrictions.push({source,reason:`claim visibility ${claimVisibility} excluded by ${lens} lens`})
    return ''
  })
}
function filterFieldVisibility(body,metadata,lens,source,restrictions,resolution=null,identityKind='owner:direct'){
  const behaviorLens=resolution?.base_lens||lens,configured=metadata.field_visibility&&typeof metadata.field_visibility==='object'&&!Array.isArray(metadata.field_visibility)?metadata.field_visibility:{}
  const policies={...configured};if(behaviorLens==='publishing')for(const field of ['compensation','salary','base pay','pay range','bonus','equity','negotiation'])if(!policies[field])policies[field]='private'
  let blockedHeading=false,reportedCompensation=false
  return body.split(/\r?\n/).filter(line=>{
    const heading=line.match(/^#{1,6}\s+(.+)$/)
    if(heading){
      const key=heading[1].trim().toLowerCase(),rule=Object.entries(policies).find(([field])=>key.includes(field.toLowerCase()))
      blockedHeading=Boolean(rule&&!visibleUnderBehavior(rule[1],behaviorLens,'generic'))
      if(behaviorLens==='publishing'&&COMPENSATION_RE.test(key))blockedHeading=true
      if(blockedHeading)restrictions.push({source,reason:`field ${rule?.[0]||'compensation'} excluded by ${lens} lens`})
      return !blockedHeading
    }
    if(blockedHeading)return false
    const field=line.match(/^\s*[-*]?\s*([^:]{2,40}):\s*(.+)$/),rule=field&&Object.entries(policies).find(([name])=>field[1].trim().toLowerCase()===name.toLowerCase())
    if(rule&&!visibleUnderBehavior(rule[1],behaviorLens,'generic')){
      restrictions.push({source,reason:`field ${rule[0]} excluded by ${lens} lens`})
      return false
    }
    if(behaviorLens==='publishing'&&COMPENSATION_RE.test(line)){
      if(!reportedCompensation){
        restrictions.push({source,reason:'compensation content excluded by publishing lens'})
        reportedCompensation=true
      }
      return false
    }
    return true
  }).join('\n')
}
function sourceRecords(root,kind,lens,task,adapter,link=null,registry=null,resolution=null,selectionOptions={},identityKind='owner:direct',subject=null){
  const records=[]; const restrictions=[],warnings=[]
  let files
  if(kind==='self')files=canonicalFiles(root,{includeHistory:selectionOptions.includeHistory||selectionOptions.temporal&&selectionOptions.temporal!=='current'})
  else files=projectMarkdownFiles(root,link)
  const subj=subject||{kind:identityKind,accessible_spaces:identityKind==='owner:direct'?['self','contrib']:[]}
  for(const path of files){
    const text=readFileSync(path,'utf8'),rel=slash(relative(root,path));let parsed
    try{parsed=frontmatter(text,{tolerant:kind==='project',registry})}catch(error){restrictions.push({source:rel,reason:'invalid canonical privacy metadata; excluded fail-closed'});warnings.push(`${rel}: ${error.message}`);continue}
    const {metadata,body,warnings:documentWarnings}=parsed;for(const warning of documentWarnings)warnings.push(`${rel}: ${warning}`)
    if(secretFile(path,root)||SECRET_RE.test(text)||['secret','credential','credentials'].includes(metadata.sensitivity)){
      if(kind==='project')restrictions.push({source:rel,reason:'secret-like content excluded'})
      continue
    }
    if(kind==='self'){
      const metadataErrors=canonicalPrivacyMetadataErrors(metadata,registry)
      if(metadataErrors.length){restrictions.push({source:rel,reason:'invalid canonical privacy metadata; excluded fail-closed'});warnings.push(`${rel}: ${metadataErrors.join('; ')}`);continue}
    }
    if(!VISIBILITIES.includes(visibility(metadata))){ restrictions.push({source:rel,reason:`unsupported visibility: ${visibility(metadata)}`}); continue }
    const docDecision=allowedDocument(metadata,lens,adapter,task,resolution,subj,kind==='self'?'self':(kind==='contrib'?'contrib':canonicalSpaceId(root)))
    if(!docDecision.allowed){
      if(kind==='self'&&(metadata.sensitivity==='restricted'||secretFile(path,root)||(docDecision.phase===1&&identityKind==='client:linked'))){
        if(identityKind==='owner:direct')restrictions.push({source:rel,reason:docDecision.reason})
      }else{
        restrictions.push({source:rel,reason:docDecision.reason})
      }
      continue
    }
    const safeMetadata=privacyMetadata(metadata,registry),behaviorLens=resolution?.base_lens||lens
    if(behaviorLens==='publishing'&&safeMetadata.sensitivity==='employer-confidential'&&safeMetadata.document_role!=='policy'){restrictions.push({source:rel,reason:'employer-confidential content excluded from publishing context'});continue}
    if(behaviorLens==='publishing'&&safeMetadata.document_role==='evidence'&&!safeMetadata.publication_allowed){restrictions.push({source:rel,reason:`evidence disclosure ${safeMetadata.disclosure} is not publish-approved`});continue}
    if(behaviorLens==='publishing'&&safeMetadata.document_role!=='policy'&&!safeMetadata.publication_allowed)restrictions.push({source:rel,reason:`readable context is not publication-approved (${safeMetadata.disclosure})`})
    const filteredBody=filterFieldVisibility(filterClaimVisibility(body,lens,rel,restrictions,resolution,identityKind),metadata,lens,rel,restrictions,resolution,identityKind)
    const score=relevance(`${rel}\n${filteredBody}`,task)
    const content=filteredBody.trim();records.push({kind,path:rel,absolute_path:path,access_lenses:safeMetadata.access_lenses,disclosure:safeMetadata.disclosure,document_role:safeMetadata.document_role,publication_allowed:safeMetadata.publication_allowed,visibility:safeMetadata.visibility,public_safe:safeMetadata.public_safe,sensitivity:safeMetadata.sensitivity,confidence:safeMetadata.confidence,freshness:new Date(statSync(path).mtimeMs).toISOString(),source_hash:hash(text),task_relevance:score,content,metadata:safeMetadata})
  }
  if(task){
    records.sort((a,b)=>b.task_relevance-a.task_relevance||canonicalSort(a.path,b.path))
    if(kind==='project')for(let i=records.length-1;i>=0;i--)if(records[i].task_relevance===0&&records[i].document_role!=='policy'){restrictions.push({source:records[i].path,reason:`no relevance match for task ${task}`});records.splice(i,1)}
  }
  return {records,restrictions,warnings}
}
function catalogCandidateRecords(catalog,root,kind,lens,task,adapter,registry,resolution,options={},identityKind='owner:direct',subject=null){
  const records=[]
  const restrictions=[]
  let unauthorizedSourcesOmitted=0
  const unmigratedWarnings=[]
  if(!catalog||!Array.isArray(catalog.sources))return {records,restrictions,unauthorized_sources_omitted:0,warnings:[]}
  const sources=catalog.sources
  const behaviorLens=resolution?.base_lens||lens
  const subj=subject||{kind:identityKind,accessible_spaces:identityKind==='owner:direct'?['self','contrib']:[]}
  const spaceId=catalog.space_id||(kind==='self'?'self':(kind==='contrib'?'contrib':canonicalSpaceId(root)))
  for(const s of sources){
    const rel=s.file
    const absPath=join(root,rel)
    const metadata=s.frontmatter

    if(identityKind==='owner:direct'&&metadata){
      const vis=metadata.visibility||'private'
      const accLenses=Array.isArray(metadata.access_lenses)?metadata.access_lenses:[]
      if(vis==='private'&&accLenses.some(l=>l!=='private')&&!metadata.read_scope){
        unmigratedWarnings.push(`Document '${rel}' has 'visibility: private' with public access_lenses; under v2 policy, read_scope defaults to 'restricted'. Access under non-private lenses is denied. Run 'holoself migrate policy' to resolve.`)
      }
    }

    const decision=allowedDocument(metadata,lens,adapter,task,resolution,subj,spaceId)
    const isPeer=Boolean(subj?.space_id&&spaceId!==subj.space_id&&kind!=='self')
    if(!decision.allowed){
      if(isPeer&&identityKind==='client:linked'){
        unauthorizedSourcesOmitted++
      }else{
        restrictions.push({source:rel,reason:decision.reason})
      }
      continue
    }
    if(behaviorLens==='publishing'&&metadata.sensitivity==='employer-confidential'&&metadata.document_role!=='policy'){
      if(isPeer&&identityKind==='client:linked'){
        unauthorizedSourcesOmitted++
      }else{
        restrictions.push({source:rel,reason:'employer-confidential content excluded from publishing context'})
      }
      continue
    }
    if(behaviorLens==='publishing'&&metadata.document_role==='evidence'&&!metadata.publication_allowed){
      if(isPeer&&identityKind==='client:linked'){
        unauthorizedSourcesOmitted++
      }else{
        restrictions.push({source:rel,reason:`evidence disclosure ${metadata.disclosure} is not publish-approved`})
      }
      continue
    }
    if(behaviorLens==='publishing'&&metadata.document_role!=='policy'&&!metadata.publication_allowed){
      if(isPeer&&identityKind==='client:linked'){
        unauthorizedSourcesOmitted++
      }else{
        restrictions.push({source:rel,reason:`readable context is not publication-approved (${metadata.disclosure})`})
      }
    }
    const dummyRes=[]
    const visibleSections=(s.sections||[]).filter(sec=>{
      const secVis=VISIBILITIES.includes(sec.visibility)?sec.visibility:'private'
      return visibleUnderBehavior(secVis,behaviorLens,adapter)
    }).map(sec=>{
      const filtered=filterFieldVisibility(filterClaimVisibility(sec.snippet||'',lens,rel,dummyRes,resolution,identityKind),metadata,lens,rel,dummyRes,resolution,identityKind)
      return {
        ...sec,
        snippet: filtered
      }
    })
    for(const r of dummyRes){
      if(isPeer&&identityKind==='client:linked') continue
      if(!restrictions.some(x=>x.source===r.source&&x.reason===r.reason)){
        restrictions.push(r)
      }
    }
    const visibleClaims=(s.claims||[]).filter(c=>visibleUnderBehavior(c.visibility,behaviorLens,adapter))
    const visibleTags=(s.tags||[]).filter(t=>visibleUnderBehavior(t.visibility,behaviorLens,adapter))
    const visibleLinks=(s.links||[]).filter(l=>visibleUnderBehavior(l.visibility,behaviorLens,adapter))
    const searchText=[
      rel,
      ...visibleSections.map(sec=>`${sec.heading} ${sec.snippet}`),
      ...visibleClaims.map(c=>c.text),
      ...visibleTags.map(t=>t.value)
    ].join(' ')

    const record={
      kind,
      path:rel,
      absolute_path:absPath,
      space_id:spaceId,
      access_lenses:metadata.access_lenses,
      disclosure:metadata.disclosure,
      document_role:metadata.document_role,
      publication_allowed:metadata.publication_allowed,
      visibility:metadata.visibility,
      public_safe:metadata.public_safe,
      sensitivity:metadata.sensitivity,
      confidence:metadata.confidence,
      freshness:new Date(s.modified_ms).toISOString(),
      source_hash:s.source_text_hash,
      source_ref:s.source_ref,
      source_id:s.source_ref.source_id,
      sections:visibleSections,
      claims:visibleClaims,
      tags:visibleTags,
      links:visibleLinks,
      search_text:searchText,
      content:'',
      metadata,
      estimated_tokens:s.estimated_tokens,
      knowledge_status:metadata.knowledge_status||'current',
      temporal_scope:metadata.temporal_scope||'timeless'
    }

    record.task_relevance = relevanceScore(record, task)

    if(kind==='contrib'&&metadata.contrib){
      record.contrib=metadata.contrib
    }

    records.push(record)
  }

  return {records,restrictions,unauthorized_sources_omitted:unauthorizedSourcesOmitted,warnings:unmigratedWarnings}
}
function resolvedContextAssertions(records,lens,task,adapter,link,resolution=null,subject=null){
  const errors=[],projectPaths=records.filter(record=>record.kind==='project').map(record=>record.path)
  for(const record of records){if(!allowed(record.metadata,lens,adapter,task,resolution,subject,record.space_id||record.kind))errors.push(`${record.kind}:${record.path}: policy rejected after resolution`);if(SECRET_RE.test(record.content))errors.push(`${record.kind}:${record.path}: secret-like content survived filtering`)}
  for(const path of projectPaths){if(!matchesAny(path,link?.project_context?.include||['**/*.md']))errors.push(`project:${path}: outside include policy`);if(matchesAny(path,link?.project_context?.exclude||DEFAULT_PROJECT_EXCLUDES))errors.push(`project:${path}: matched exclude policy`)}
  if(errors.length){const error=new Error(`context leakage validation failed: ${errors.length} source(s) rejected`);error.code='CONTEXT_LEAKAGE_DETECTED';error.details=errors;throw error}
  return {status:'passed',checks:['privacy-policy-reapplied','secret-pattern-scan','project-include-exclude-reapplied'],selected_sources:records.length}
}
function deduplicateCandidates(cands, localSpaceId){
  const seen = new Map()
  const scorePrec = c => {
    if(c.space_id === localSpaceId) return 1
    if(c.space_id === 'self') return 2
    return 3
  }
  for(const c of cands){
    const key = c.source_text_hash || c.source_hash || c.source_ref?.revision
    if(!key) continue
    const existing = seen.get(key)
    if(!existing){
      seen.set(key, c)
    }else{
      const pExist = scorePrec(existing)
      const pCurr = scorePrec(c)
      if(pCurr < pExist || (pCurr === pExist && (c.space_id || '') < (existing.space_id || ''))){
        seen.set(key, c)
      }
    }
  }
  const kept = new Set(seen.values())
  return cands.filter(c => {
    const key = c.source_text_hash || c.source_hash || c.source_ref?.revision
    if(!key) return true
    return kept.has(c)
  })
}
function getEligibleFederatedSpaces(selfRoot, consumerProjectPath, lens, { federated, spaces } = {}){
  const shouldFederate = Boolean(federated || spaces?.length)
  if(!shouldFederate) return []
  let registryLinksObj = null
  try{ registryLinksObj = readRegistry(selfRoot) }catch{ return [] }
  if(!registryLinksObj || !Array.isArray(registryLinksObj.links)) return []
  const consumerSpaceId = consumerProjectPath ? canonicalSpaceId(consumerProjectPath) : null
  const explicitSpaces = Array.isArray(spaces) ? new Set(spaces.map(s=>s.trim())) : null
  const eligible = []
  for(const entry of registryLinksObj.links){
    if(entry.status !== 'active') continue
    if(consumerSpaceId && entry.project_id === consumerSpaceId) continue
    if(explicitSpaces && !explicitSpaces.has(entry.project_id) && !explicitSpaces.has(entry.project_path) && !explicitSpaces.has(basename(entry.project_path))) continue

    // Pre-Filtro Zero-I/O (B3): check if requested lens is granted to producer in links.json
    const producerAllowedLenses = new Set((entry.allowed_lenses || []).filter(l => l !== 'private'))
    if(!producerAllowedLenses.has(lens)) continue

    eligible.push({
      space_id: entry.project_id,
      project_path: entry.project_path,
      binding_salt: entry.binding_salt,
      allowed_lenses: producerAllowedLenses
    })
  }
  return eligible
}
function contextData(o){
  if(o.identity!==undefined){const err=new Error('identity not accepted from caller');err.code='IDENTITY_NOT_ACCEPTED_FROM_CALLER';throw err}
  const surface=o.surface||(o.project?'cli-linked':'cli-direct')

  const cwd=process.cwd()
  let project=o.project?resolve(o.project):null
  let link=null
  let self=null
  let identity=null

  if(project){
    const holoselfDir=join(project,'.holoself')
    if(existsSync(holoselfDir)&&lstatSync(holoselfDir).isSymbolicLink()){
      const err=new Error(`project uses a legacy filesystem junction mount: ${project}; run holoself link setup to migrate to a bounded link`)
      err.code='LEGACY_MOUNT_DETECTED'
      throw err
    }
    const candidateLink=linkPath(project)
    if(!pathExists(candidateLink)){
      const err=new Error(`project is not linked to any Holoself canonical root: ${project}`)
      err.code='LINK_REQUIRED'
      throw err
    }
    link=readLink(project)
    self=link.path
    if(!existsSync(self)){const err=new Error(`self path not found: ${self}`);err.code='SELF_ROOT_MISSING';throw err}
    if(o.self||o.rootExplicit){
      const callerSelf=resolve(o.self||o.root)
      const cmpCaller=process.platform==='win32'?slash(safeRealpath(callerSelf)).toLowerCase():slash(safeRealpath(callerSelf))
      const cmpLink=process.platform==='win32'?slash(safeRealpath(link.path)).toLowerCase():slash(safeRealpath(link.path))
      if(cmpCaller!==cmpLink){
        const err=new Error('supplied self root does not match canonical link root')
        err.code='SELF_ROOT_NOT_CANONICAL'
        throw err
      }
    }
    identity={
      kind:'client:linked',
      project,
      self:link.path,
      allowedLenses:new Set([link.default_lens,...(link.secondary_lenses||[])])
    }
  }else{
    const found=findLinkUpwards(cwd)
    if(found){
      project=found.projectDir
      link=readLink(project)
      self=link.path
      if(!existsSync(self)){const err=new Error(`self path not found: ${self}`);err.code='SELF_ROOT_MISSING';throw err}
      if(o.self||o.rootExplicit){
        const callerSelf=resolve(o.self||o.root)
        const cmpCaller=process.platform==='win32'?slash(safeRealpath(callerSelf)).toLowerCase():slash(safeRealpath(callerSelf))
        const cmpLink=process.platform==='win32'?slash(safeRealpath(link.path)).toLowerCase():slash(safeRealpath(link.path))
        if(cmpCaller!==cmpLink){
          const err=new Error('supplied self root does not match canonical link root')
          err.code='SELF_ROOT_NOT_CANONICAL'
          throw err
        }
      }
      identity={
        kind:'client:linked',
        project,
        self:link.path,
        allowedLenses:new Set([link.default_lens,...(link.secondary_lenses||[])])
      }
    }else{
      if(surface==='mcp'||surface==='web'){
        const err=new Error('mcp and web surfaces require a linked project')
        err.code='LINK_REQUIRED'
        throw err
      }
      const envRoot=process.env.HOLOSELF_HOME||join(homedir(),'.holoself')
      const targetSelf=resolve(o.self||(o.rootExplicit?o.root:null)||envRoot)
      try{
        assertContainedPath(targetSelf,cwd,'caller working directory')
      }catch{
        const err=new Error('caller is outside canonical self root and has no link')
        err.code='LINK_REQUIRED'
        throw err
      }
      if(!isCanonicalSelf(targetSelf)){
        const err=new Error(`self path lacks canonical profile/context layout: ${targetSelf}`)
        err.code='SELF_ROOT_NOT_CANONICAL'
        throw err
      }
      self=targetSelf
      project=cwd
      identity={
        kind:'owner:direct',
        project:null,
        self:targetSelf,
        allowedLenses:null
      }
    }
  }

  const registry=loadLensRegistry(self)
  const registryLinksObj=readRegistry(self)
  const links_register_hash=computeLinksRegisterHash(registryLinksObj.links)
  const lens=o.lens||link?.default_lens||'general'

  switch(identity.kind){
    case 'owner:direct':
      if(!registry.byId.has(lens)){
        const error=new Error(`unknown lens requested: ${lens}`)
        error.code='UNKNOWN_LENS'
        throw error
      }
      break
    case 'client:linked': {
      const pId=canonicalSpaceId(project)
      const cPath=canonicalProjectPath(project)
      const regEntry=registryLinksObj.links.find(l=>l.project_id===pId||l.project_path===cPath)
      const hasValidSalt=regEntry&&
        typeof regEntry.binding_salt==='string'&&
        typeof link.binding_salt==='string'&&
        regEntry.binding_salt.length>0&&
        regEntry.binding_salt===link.binding_salt
      if(!regEntry||regEntry.status!=='active'||!hasValidSalt){
        const error=new Error(`Link not attested in self registry or binding_salt mismatch: ${project}. Run 'holoself link approve --project <dir>' from self root to activate.`)
        error.code='LENS_NOT_GRANTED'
        throw error
      }
      const linkLenses=new Set([link.default_lens,...(link.secondary_lenses||[])])
      const grantedLenses=new Set((regEntry.allowed_lenses||[]).filter(l=>l!=='private'))
      const effectiveAllowedLenses=new Set([...linkLenses].filter(l=>grantedLenses.has(l)&&l!=='private'))
      if(!effectiveAllowedLenses.has(lens)){
        const error=new Error(`unknown lens or lens is not granted by this project link: ${lens}`)
        error.code='LENS_NOT_GRANTED'
        throw error
      }
      identity.allowedLenses=effectiveAllowedLenses
      break
    }
    default:{
      const error=new Error('unrecognized caller identity kind')
      error.code='UNRECOGNIZED_IDENTITY'
      throw error
    }
  }

  const resolution=resolveLens(registry,lens)
  if(resolution.id!==lens){
    const error=new Error('lens resolution mismatch')
    error.code='LENS_RESOLUTION_MISMATCH'
    throw error
  }

  const subject={
    kind:identity.kind,
    space_id:identity.kind==='owner:direct'?'self':canonicalSpaceId(project),
    accessible_spaces:identity.kind==='owner:direct'?['self','contrib']:[canonicalSpaceId(project)],
    effective_allowed_lenses:identity.allowedLenses
  }

  const eligibleFederatedSpaces=getEligibleFederatedSpaces(self,identity.kind==='client:linked'?project:null,lens,o)

  const adapter=o.restrictedHost?'restricted-host':(o.adapter||'generic')
  const projectForCatalog=identity.kind==='client:linked'?project:null
  const catResult=ensureCatalog(self,projectForCatalog,link,registry,{rebuild:false,federatedSpaces:eligibleFederatedSpaces})
  const selfData=catalogCandidateRecords(catResult.self,self,'self',lens,o.task,adapter,registry,resolution,o,identity.kind,subject)
  const local=(identity.kind==='client:linked'&&identity.project!==null&&!o.selfOnly&&existsSync(project)&&resolve(project)!==resolve(self)&&catResult.project)
    ?catalogCandidateRecords(catResult.project,project,'project',lens,o.task,adapter,registry,resolution,o,identity.kind,subject)
    :{records:[],restrictions:[],unauthorized_sources_omitted:0}

  let contribCandidates=[]
  if(o.task&&catResult.contrib){
    let config=null
    try{config=JSON.parse(readFileSync(join(self,'config.json'),'utf8'))}catch{}
    const selectedContribs=new Set(Array.isArray(config?.selectedContribs)?config.selectedContribs:[])
    if(selectedContribs.size>0){
      const filteredSources=catResult.contrib.sources.filter(s=>selectedContribs.has(s.frontmatter?.contrib?.id))
      const contribPartition={...catResult.contrib,sources:filteredSources}
      const contribRes=catalogCandidateRecords(contribPartition,PACKAGE_ROOT,'contrib',lens,o.task,adapter,registry,resolution,o,identity.kind,subject)
      contribCandidates=contribRes.records
    }
  }

  let federatedCandidates=[]
  let federatedUnauthorizedOmitted=0
  for(const peer of (catResult.federated||[])){
    const peerData=catalogCandidateRecords(peer.catalog,peer.path,'project',lens,o.task,adapter,registry,resolution,o,identity.kind,subject)
    for(const rec of peerData.records){
      rec.space_id=peer.space_id
      rec.peer_name=peer.name
      federatedCandidates.push(rec)
    }
    if(identity.kind==='owner:direct'&&peerData.unauthorized_sources_omitted){
      federatedUnauthorizedOmitted+=peerData.unauthorized_sources_omitted
    }
  }

  const rawCandidates=[...selfData.records,...local.records,...contribCandidates,...federatedCandidates]
  const candidates=deduplicateCandidates(rawCandidates,subject.space_id)

  const cursorSecret=getOrCreateCursorSecret(self)
  const identityId=getIdentityId(identity,cursorSecret)
  const selfId=hash(slash(safeRealpath(self))).slice(0,16)
  const allowedLensesList=identity.allowedLenses?[...identity.allowedLenses].sort(canonicalSort):[...registry.byId.keys()].sort(canonicalSort)
  const budgetName=o.budget||'standard'

  const spaceSourcesMap={
    self:(catResult.self?.sources||[]).map(s=>[s.source_ref.source_id,s.source_ref.revision])
  }
  if(catResult.project){
    spaceSourcesMap[catResult.project.space_id||'project']=(catResult.project?.sources||[]).map(s=>[s.source_ref.source_id,s.source_ref.revision])
  }
  for(const peer of (catResult.federated||[])){
    spaceSourcesMap[peer.space_id]=(peer.catalog?.sources||[]).map(s=>[s.source_ref.source_id,s.source_ref.revision])
  }
  const catalog_hash=hash(canonicalJson(spaceSourcesMap))

  let configObj=null
  try{configObj=JSON.parse(readFileSync(join(self,'config.json'),'utf8'))}catch{}
  const contrib_selection_hash=hash(canonicalJson(
    Array.isArray(configObj?.selectedContribs)
      ?[...configObj.selectedContribs].sort(canonicalSort)
      :[]
  ))

  const reqSources=o.sources||o.source_ids||[]
  const requested_source_ids=Array.isArray(reqSources)&&reqSources.length
    ?[...new Set(reqSources.map(s => {
        if(typeof s === 'string' && SOURCE_ID_RE.test(s)) return s
        const found = candidates.find(c => c.path === s || c.source_id === s)
        return found ? found.source_id : (typeof s === 'string' ? sourceId({ kind: 'self', path: s }) : null)
      }).filter(id => typeof id === 'string' && SOURCE_ID_RE.test(id)))].sort(canonicalSort)
    :null

  const decisionKey=computeDecisionCacheKey({
    catalog_hash,
    lens_registry_hash:registry.registry_hash,
    contrib_selection_hash,
    links_register_hash,
    identity_id:identityId,
    lens,
    allowed_lenses:allowedLensesList,
    task_hash:hash(String(o.task||'')),
    temporal:o.temporal||'current',
    include_history:Boolean(o.includeHistory),
    budget:budgetName,
    manifest:Boolean(o.manifest),
    requested_source_ids,
    cursor:o.cursor||null
  })

  const cacheDir=link&&!o.noCache?decisionCacheDir(project):null
  if(cacheDir){
    purgeInvalidDecisionCache(cacheDir)
  }

  const deliveryRestrictions=[]
  let reconcileReads=0
  function deliverRecord(cand){
    let read=readSourceWithStat(cand.absolute_path)
    if(!read){cand.delivery_reason='source unavailable at delivery';return null}
    let rawHash=hash(read.text)
    let reconciled=false
    if(rawHash!==cand.source_ref.revision){
      reconcileReads++
      reconciled=true
      const nextRead=readSourceWithStat(cand.absolute_path)
      if(!nextRead){cand.delivery_reason='source unavailable at delivery';return null}
      const nextHash=hash(nextRead.text)
      if(nextHash!==rawHash){
        cand.delivery_reason='source concurrently modified; omitted fail-closed'
        return null
      }
      read=nextRead
      rawHash=nextHash
    }
    let parsed
    try{parsed=frontmatter(read.text,{tolerant:cand.kind==='project'||cand.kind==='contrib',registry})}catch{
      cand.delivery_reason='invalid canonical privacy metadata; excluded fail-closed'
      return null
    }
    const metadata=cand.kind==='contrib'&&(!parsed.metadata||!Object.keys(parsed.metadata).length)
      ?cand.metadata
      :{...(cand.kind==='contrib'?cand.metadata:{}),...parsed.metadata}
    const {body}=parsed
    const candSpaceId=cand.space_id||(cand.kind==='project'?canonicalSpaceId(project):cand.kind)
    if(!allowed(metadata,lens,adapter,o.task,resolution,subject,candSpaceId)){cand.delivery_reason='restricted by policy';return null}
    const behaviorLens=resolution?.base_lens||lens
    if(behaviorLens==='publishing'&&metadata.sensitivity==='employer-confidential'&&metadata.document_role!=='policy'){cand.delivery_reason='employer-confidential content excluded from publishing context';return null}
    if(behaviorLens==='publishing'&&metadata.document_role==='evidence'&&!metadata.publication_allowed){cand.delivery_reason=`evidence disclosure ${metadata.disclosure} is not publish-approved`;return null}
    const filteredBody=filterFieldVisibility(filterClaimVisibility(body,lens,cand.path,deliveryRestrictions,resolution,identity.kind),metadata,lens,cand.path,deliveryRestrictions,resolution,identity.kind)
    const content=filteredBody.trim()

    let freshness=cand.freshness
    let estimatedTokens=cand.estimated_tokens
    let sectionsList=cand.sections
    let claimsList=cand.claims
    let tagsList=cand.tags
    let linksList=cand.links
    let searchText=cand.search_text
    if(reconciled&&read.stat){
      freshness=new Date(read.stat.modified_ms).toISOString()
      estimatedTokens=Math.ceil(read.text.length/4)
      const safeMeta=privacyMetadata(metadata,registry)
      const rawSecs=privacySections(body,safeMeta)
      const seenSlugs=new Map()
      const catSecs=rawSecs.map(sec=>{
        const baseSlug=slugHeading(sec.heading)
        const count=(seenSlugs.get(baseSlug)||0)+1
        seenSlugs.set(baseSlug,count)
        const section_id=count===1?baseSlug:`${baseSlug}-${count}`
        const snippet=(sec.content.length>360?sec.content.slice(0,357)+'...':sec.content).trim()
        return {section_id,heading:sec.heading,visibility:sec.visibility,disclosure:sec.disclosure,claim:Boolean(sec.claim),snippet}
      })
      sectionsList=catSecs.filter(sec=>{
        const secVis=VISIBILITIES.includes(sec.visibility)?sec.visibility:'private'
        return visibleUnderBehavior(secVis,behaviorLens,adapter)
      }).map(sec=>{
        const filtered=filterFieldVisibility(filterClaimVisibility(sec.snippet||'',lens,cand.path,deliveryRestrictions,resolution,identity.kind),metadata,lens,cand.path,deliveryRestrictions,resolution,identity.kind)
        return {...sec,snippet:filtered}
      })
      const annotatedClaims=rawSecs.flatMap(sec=>claims(sec.content).map(text=>({text,visibility:COMPENSATION_RE.test(text)?'private':sec.visibility})))
      const annotatedLinks=rawSecs.flatMap(sec=>links(sec.content).map(value=>({value,visibility:sec.visibility})))
      const annotatedTags=rawSecs.flatMap(sec=>tags(sec.content).map(value=>({value,visibility:sec.visibility})))
      annotatedClaims.sort((a,b)=>canonicalSort(a.text,b.text))
      annotatedLinks.sort((a,b)=>canonicalSort(a.value,b.value))
      annotatedTags.sort((a,b)=>canonicalSort(a.value,b.value))
      claimsList=annotatedClaims.filter(c=>visibleUnderBehavior(c.visibility,behaviorLens,adapter))
      tagsList=annotatedTags.filter(t=>visibleUnderBehavior(t.visibility,behaviorLens,adapter))
      linksList=annotatedLinks.filter(l=>visibleUnderBehavior(l.visibility,behaviorLens,adapter))
      searchText=[
        cand.path,
        ...sectionsList.map(sec=>`${sec.heading} ${sec.snippet}`),
        ...claimsList.map(c=>c.text),
        ...tagsList.map(t=>t.value)
      ].join(' ')
    }

    return {
      content,
      metadata:privacyMetadata(metadata,registry),
      source_hash:rawHash,
      freshness,
      estimated_tokens:estimatedTokens,
      sections:sectionsList,
      claims:claimsList,
      tags:tagsList,
      links:linksList,
      search_text:searchText
    }
  }

  const nowMs=o.now?(typeof o.now==='number'?o.now:Date.parse(o.now)||Date.now()):Date.now()
  const candidateEpochs=candidates.map(c=>c.metadata?.valid_until_epoch_ms).filter(v=>typeof v==='number'&&v>nowMs)
  const validUntilEpochMs=candidateEpochs.length?Math.min(...candidateEpochs):null

  const selectionOptions={
    task:o.task,
    lens,
    budget:budgetName,
    manifest:o.manifest,
    sources:reqSources,
    temporal:o.temporal||'current',
    includeHistory:o.includeHistory,
    cursor:o.cursor||null,
    cursorSecret,
    identityId,
    selfId,
    registryHash:registry.registry_hash,
    allowedLenses:allowedLensesList,
    deliver:deliverRecord,
    now:o.now
  }

  let selected=null
  const cachedEntry=cacheDir?readDecisionCache(cacheDir,decisionKey,{now:o.now}):null
  if(cachedEntry){
    const candById=new Map(candidates.map(c=>[c.source_id,c]))
    const selectedCandidates=cachedEntry.receipt.source_ids.map(id=>candById.get(id)).filter(Boolean)
    const deliveredRecords=[]
    const omitted=[]
    const temporalExcluded=[]
    const eligibleCandidates=[]
    const reqSet = new Set((o.sources || []).concat(requested_source_ids || []))
    for(const c of candidates){
      const temporal=temporalDisposition(c.metadata,o.task,{includeHistory:o.includeHistory,temporal:o.temporal,now:o.now})
      if(!temporal.include){
        temporalExcluded.push({source:c.path,reason:temporal.reason})
      }else{
        c.knowledge_status = temporal.status
        c.temporal_scope = temporal.scope
        if(reqSet.size && !reqSet.has(c.source_id) && !reqSet.has(c.path)) continue
        eligibleCandidates.push(c)
      }
    }
    eligibleCandidates.sort((a,b)=>{
      if(reqSet.size)return (a.source_id<b.source_id?-1:a.source_id>b.source_id?1:0)||(a.path<b.path?-1:a.path>b.path?1:0)
      return (b.task_relevance||0)-(a.task_relevance||0)||(a.source_id<b.source_id?-1:a.source_id>b.source_id?1:0)||(a.path<b.path?-1:a.path>b.path?1:0)
    })
    const selectedCandidateIds=new Set(selectedCandidates.map(c=>c.source_id))
    if(!o.manifest){
      let contribCount=0
      for(const c of eligibleCandidates){
        if(selectedCandidateIds.has(c.source_id)){
          if(c.kind==='contrib') contribCount++
        }else{
          if(o.task&&!reqSet.size&&c.kind==='project'&&(c.task_relevance||0)<=0&&c.document_role!=='policy'){
            omitted.push({source:c.path,reason:'no meaningful task relevance'})
          }else if(c.kind==='contrib'&&contribCount>=2){
            omitted.push({source:c.path,reason:'contrib selection limit reached'})
          }else{
            omitted.push({source:c.path,reason:`context budget ${budgetName} exhausted`})
          }
        }
      }
    }
    let isTruncated=false
    let chars=0
    if(o.manifest){
      for(const cand of selectedCandidates){
        deliveredRecords.push({
          ...cand,
          content:'',
          manifest_only:true,
          truncated:false,
          knowledge_status:cand.knowledge_status||'current',
          temporal_scope:cand.temporal_scope||'timeless'
        })
      }
    }else{
      const budgetChars=CONTEXT_BUDGETS[budgetName]||CONTEXT_BUDGETS.standard
      const isNotNeeded=contextNeed(o.task)==='not-needed'
      for(const cand of selectedCandidates){
        if(!reqSet.size&&isNotNeeded&&cand.kind==='self'){
          omitted.push({source:cand.path,reason:'personal context not needed for this task'})
          continue
        }
        const remaining=budgetChars-chars
        if(remaining<160){
          omitted.push({source:cand.path,reason:`context budget ${budgetName} exhausted`})
          isTruncated=true
          continue
        }
        const delivered=deliverRecord(cand)
        if(!delivered){
          if(cand.delivery_reason) omitted.push({source:cand.path,reason:cand.delivery_reason})
          continue
        }
        const res=excerpt(delivered.content,o.task,remaining)
        if(!res.content.trim()){
          omitted.push({source:cand.path,reason:'empty after filtering'})
          continue
        }
        deliveredRecords.push({
          ...cand,
          content:res.content,
          metadata:delivered.metadata||cand.metadata,
          source_hash:delivered.source_hash||cand.source_hash,
          freshness:delivered.freshness||cand.freshness,
          estimated_tokens:delivered.estimated_tokens??cand.estimated_tokens,
          sections:delivered.sections||cand.sections,
          claims:delivered.claims||cand.claims,
          tags:delivered.tags||cand.tags,
          links:delivered.links||cand.links,
          search_text:delivered.search_text||cand.search_text,
          knowledge_status:cand.knowledge_status||'current',
          temporal_scope:cand.temporal_scope||'timeless',
          truncated:res.truncated
        })
        chars+=res.content.length
        if(res.truncated)isTruncated=true
      }
    }
    let startOffset=0
    if(o.cursor){
      try{
        const parsed=JSON.parse(Buffer.from(o.cursor,'base64url').toString('utf8'))
        if(Number.isInteger(parsed?.p?.offset)&&parsed.p.offset>=0) startOffset=parsed.p.offset
      }catch{}
    }
    const nextOffset=startOffset+deliveredRecords.length
    const nextCursor=(o.manifest&&nextOffset<eligibleCandidates.length)
      ?buildCursor(identityId,lens,budgetName,true,selfId,cachedEntry.task_hash,cachedEntry.temporal,nextOffset,cachedEntry.state_hash,cursorSecret)
      :null
    const receiptInput={
      budget:budgetName,
      task_hash:cachedEntry.task_hash,
      lens:lens||null,
      sources:deliveredRecords.map(r=>[r.source_id,r.source_hash,r.truncated])
    }
    const contextHash=hash(canonicalJson(receiptInput))
    const freshReceipt={
      schema_version:1,
      context_hash:contextHash,
      task_hash:cachedEntry.task_hash,
      lens:lens||null,
      budget:budgetName,
      temporal:cachedEntry.temporal,
      source_ids:deliveredRecords.map(r=>r.source_id),
      source_hashes:deliveredRecords.map(r=>r.source_hash)
    }
    const serializedContentBytes=Buffer.byteLength(JSON.stringify(deliveredRecords))
    selected={
      records:deliveredRecords,
      omitted,
      temporalExcluded,
      candidates:eligibleCandidates,
      startOffset,
      taskHash:cachedEntry.task_hash,
      temporalVal:cachedEntry.temporal,
      stateHash:cachedEntry.state_hash,
      selection:{
        schema_version:1,
        context_need:contextNeed(o.task),
        budget:budgetName,
        budget_chars:(CONTEXT_BUDGETS[budgetName]||CONTEXT_BUDGETS.standard)===Number.MAX_SAFE_INTEGER?null:(CONTEXT_BUDGETS[budgetName]||CONTEXT_BUDGETS.standard),
        manifest_only:Boolean(o.manifest),
        temporal:cachedEntry.temporal,
        candidate_count:candidates.length,
        eligible_count:eligibleCandidates.length,
        selected_count:deliveredRecords.length,
        omitted_count:omitted.length+temporalExcluded.length,
        content_chars:chars,
        estimated_tokens:estimateTokens(chars),
        estimated_tokens_total_heuristic:Math.ceil(serializedContentBytes/4),
        truncated:isTruncated||deliveredRecords.some(r=>r.truncated),
        truncated_sources:deliveredRecords.filter(r=>r.truncated).map(r=>r.source_id),
        selected_sources:deliveredRecords.map(r=>r.source_id),
        temporal_excluded:temporalExcluded.length,
        contrib_sources:deliveredRecords.filter(r=>r.kind==='contrib').map(r=>r.source_id),
        contradiction_digest:contradictionDigest(deliveredRecords),
        reconcile_reads:reconcileReads,
        catalog_reads:catResult.catalog_reads||0,
        next_cursor:nextCursor
      },
      receipt:freshReceipt,
      cache:{key:decisionKey,hit:true,persistent:true}
    }
  }else{
    selected=cachedSelection(candidates,selectionOptions)
    selected.selection.reconcile_reads=reconcileReads
    selected.selection.catalog_reads=catResult.catalog_reads||0
    if(cacheDir){
      const decisionEntry={
        schema_version:CACHE_SCHEMA_VERSION,
        catalog_hash,
        lens_registry_hash:registry.registry_hash,
        contrib_selection_hash,
        links_register_hash,
        identity_id:identityId,
        lens,
        allowed_lenses:allowedLensesList,
        task_hash:hash(String(o.task||'')),
        temporal:o.temporal||'current',
        include_history:Boolean(o.includeHistory),
        budget:budgetName,
        manifest:Boolean(o.manifest),
        requested_source_ids,
        cursor:o.cursor||null,
        source_refs:selected.records.map(r=>r.source_ref),
        receipt:selected.receipt,
        state_hash:selected.stateHash,
        valid_until_epoch_ms:validUntilEpochMs,
        estimated_tokens_total:selected.selection.estimated_tokens_total_heuristic
      }
      writeDecisionCache(cacheDir,decisionKey,decisionEntry,getDecisionCacheLimits(link))
      selected.cache={key:decisionKey,hit:false,persistent:true}
    }
  }

  const records=[...selected.records],sources=records.map(({content,metadata,absolute_path,...source})=>source)
  const warnings=[
    ...(catResult.warnings||[]),
    ...(identity.kind==='owner:direct'?[...(selfData.warnings||[]),...(local.warnings||[])]:[])
  ]
  if(!link&&!o.self&&resolve(self)!==resolve(project))warnings.push('No project link found; resolved explicit/default self root.')
  const generatedAt=new Date().toISOString(),restrictedHost=Boolean(o.snapshot||o.restrictedHost||adapter==='restricted-host'),expiresAt=restrictedHost?new Date(Date.parse(generatedAt)+(o.expiresHours||24)*60*60*1000).toISOString():null
  const validation=resolvedContextAssertions(records,lens,o.task,adapter,link,resolution,subject)
  const selfRecords=records.filter(record=>record.kind==='self')
  const localSpaceId=identity.kind==='client:linked'?canonicalSpaceId(project):'self'
  const localRecords=records.filter(record=>record.kind==='project'&&(!record.space_id||record.space_id===localSpaceId))
  const methodRecords=records.filter(record=>record.kind==='contrib')
  const federatedRecords=records.filter(record=>record.kind==='project'&&record.space_id&&record.space_id!==localSpaceId)

  const isLinked=identity.kind==='client:linked'
  const selfProjection=isLinked
    ?{documents:selfRecords.map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))}
    :{path:slash(resolve(self)),documents:selfRecords.map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))}

  const projectProjection=isLinked
    ?{name:basename(project),documents:localRecords.map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))}
    :{path:slash(project),name:basename(project),documents:localRecords.map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))}

  const federatedProjections=(catResult.federated||[]).map(peer=>{
    const peerDocs=federatedRecords.filter(r=>r.space_id===peer.space_id)
    return {
      space_id:peer.space_id,
      name:peer.name,
      documents:peerDocs.map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))
    }
  }).filter(p=>p.documents.length>0)

  const hasUnreachable=Boolean(catResult.unreachable_spaces&&catResult.unreachable_spaces.length>0)
  const queryStatus=hasUnreachable?'partial':(selected.selection.context_need==='not-needed'?'not-needed':'complete')

  const unauthorizedSourcesOmitted=(selfData.unauthorized_sources_omitted||0)+(local.unauthorized_sources_omitted||0)+federatedUnauthorizedOmitted
  const result={
    status:queryStatus,
    self:selfProjection,
    lens,
    lens_resolution:{schema_version:resolution.schema_version,id:resolution.id,title:resolution.title,source:resolution.source,base_lens:resolution.base_lens,sensitivity_access:[...resolution.sensitivity_access]},
    project:projectProjection,
    federated:federatedProjections,
    methods:{documents:methodRecords.map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only,contrib:r.contrib}))},
    ...(hasUnreachable?{unreachable_spaces:catResult.unreachable_spaces}:{}),
    task:o.task||null,
    packet_metadata:{schema_version:2,packet_id:randomUUID(),generated_at:generatedAt,expires_at:expiresAt,host_mode:restrictedHost?'restricted-host-snapshot':'live-local',lens_registry_hash:registry.registry_hash,source_hash_algorithm:'sha256',source_hashes:sources.map(source=>({kind:source.kind,path:source.path,sha256:source.source_hash,freshness:source.freshness}))},
    sources,
    restrictions:[...selfData.restrictions,...local.restrictions,...deliveryRestrictions,...selected.omitted,...selected.temporalExcluded],
    warnings,
    validation,
    selection:{
      ...selected.selection,
      ...(!isLinked&&unauthorizedSourcesOmitted>0?{unauthorized_sources_omitted:unauthorizedSourcesOmitted}:{})
    },
    context_receipt:{
      ...selected.receipt,
      status:queryStatus,
      ...(hasUnreachable?{unreachable_spaces:catResult.unreachable_spaces}:{}),
      cache:selected.cache
    },
    proposals:(isLinked&&project)?listProposalData(project).filter(p=>p.status==='pending'):[],
    cache:selected.cache,
    ...(!isLinked&&unauthorizedSourcesOmitted>0?{unauthorized_sources_omitted:unauthorizedSourcesOmitted}:{})
  }

  const envelopeCap=ENVELOPE_BYTE_CAPS[budgetName]||ENVELOPE_BYTE_CAPS.standard
  const isMcp=surface==='mcp'
  const measurePayload=res=>{
    if(isMcp)return Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(res,null,2)}],structuredContent:{data:res}}))
    return Buffer.byteLength(JSON.stringify(res,null,2)+'\n')
  }

  let payloadBytes=measurePayload(result)
  if(o.manifest&&payloadBytes>envelopeCap){
    const candidateList=selected.candidates||candidates
    const startOffset=selected.startOffset||0
    while(records.length>0&&payloadBytes>envelopeCap){
      const removed=records.pop()
      result.restrictions.push({source:removed.path,reason:'source exceeds envelope budget'})
      result.sources=records.map(({content,metadata,absolute_path,...s})=>s)
      result.self.documents=records.filter(r=>r.kind==='self').map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))
      result.project.documents=records.filter(r=>r.kind==='project'&&(!r.space_id||r.space_id===localSpaceId)).map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))
      result.federated=(catResult.federated||[]).map(peer=>{
        const pDocs=records.filter(r=>r.space_id===peer.space_id)
        return {
          space_id:peer.space_id,
          name:peer.name,
          documents:pDocs.map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only}))
        }
      }).filter(p=>p.documents.length>0)
      result.methods.documents=records.filter(r=>r.kind==='contrib').map(r=>({path:r.path,content:r.content,metadata:r.metadata,source_id:r.source_id,truncated:r.truncated,manifest_only:r.manifest_only,contrib:r.contrib}))
      result.packet_metadata.source_hashes=result.sources.map(s=>({kind:s.kind,path:s.path,sha256:s.source_hash,freshness:s.freshness}))
      result.selection.selected_count=records.length
      result.selection.selected_sources=records.map(r=>r.source_id)
      result.selection.omitted_count=result.restrictions.length
      result.selection.truncated=true
      payloadBytes=measurePayload(result)
    }
    result.selection.estimated_tokens_total_heuristic=Math.ceil(payloadBytes/4)
    let nextOffset=startOffset+records.length
    if(records.length===0&&startOffset<candidateList.length){
      nextOffset=startOffset+1
      result.selection.truncated=true
    }
    if(nextOffset<candidateList.length){
      result.selection.next_cursor=buildCursor(identityId,lens,budgetName,Boolean(o.manifest),selfId,selected.taskHash,selected.temporalVal,nextOffset,selected.stateHash,cursorSecret)
    }else{
      result.selection.next_cursor=null
    }
  }

  return result
}
function packetFormat(data,adapter='generic'){
  const labels={pi:'Pi context packet',claude:'Claude Code context packet',codex:'Codex context packet',generic:'Holoself context packet',obsidian:'Obsidian/Claude context packet','restricted-host':'Restricted-host Holoself context packet'}
  const title=labels[adapter] || labels.generic,metadata=data.packet_metadata
  const fedDocs=(data.federated||[]).flatMap(f=>f.documents.map(x=>({...x,owner:f.name||f.space_id})))
  const docs=[...data.self.documents.map(x=>({...x,owner:'self'})),...data.project.documents.map(x=>({...x,owner:'project'})),...fedDocs,...(data.methods?.documents||[]).map(x=>({...x,owner:'method'}))]
  const receipt=`Context receipt: ${data.context_receipt.context_hash} (${data.context_receipt.cache.hit?'cache hit':'fresh resolution'})\nContext gate: ${data.selection.context_need}; budget: ${data.selection.budget}; estimated tokens: ${data.selection.estimated_tokens}; selected sources: ${data.selection.selected_count}`
  return `# ${title}\n\nPacket ID: ${metadata.packet_id}\n${receipt}\nGenerated: ${metadata.generated_at}\nExpires: ${metadata.expires_at||'not applicable (live local resolution)'}\nHost mode: ${metadata.host_mode}\nLens: ${data.lens}\nLens source: ${data.lens_resolution.source}\nLens base: ${data.lens_resolution.base_lens}\nTask: ${data.task || '(none)'}\nPrivacy: access-filtered. Publication requires disclosure=publish-approved; readability alone is never approval. Preserve provenance; never silently write self.\n\n## Source hashes (SHA-256)\n\n${metadata.source_hashes.map(source=>`- ${source.kind}:${source.path} ${source.sha256} (${source.freshness})`).join('\n')||'- None'}\n\n${docs.map(d=>`## ${d.owner}: ${d.path}\n\nAccess lenses: ${(d.metadata.access_lenses||[]).join(', ')}\nDisclosure: ${d.metadata.disclosure}\nSensitivity: ${d.metadata.sensitivity}\nDocument role: ${d.metadata.document_role}\nPublication allowed: ${d.metadata.publication_allowed?'yes':'no'}\n\n${d.content}`).join('\n\n')}\n\n## Restrictions\n\n${data.restrictions.map(x=>`- ${x.source}: ${x.reason}`).join('\n') || '- None'}\n`
}
function withoutPrivatePaths(value){
  if(Array.isArray(value))return value.map(withoutPrivatePaths)
  if(!value||typeof value!=='object')return value
  const clean={}
  for(const [key,item] of Object.entries(value)){
    if(['absolute_path','_path','source_project_path'].includes(key))continue
    if(key==='path'&&(value===value.self||value===value.project))continue
    clean[key]=withoutPrivatePaths(item)
  }
  return clean
}
function mcpContextData(project,options={}){
  if(options.surface!==undefined){const err=new Error('surface not accepted from request');err.code='SURFACE_NOT_ACCEPTED_FROM_REQUEST';throw err}
  if(options.identity!==undefined){const err=new Error('identity not accepted from caller');err.code='IDENTITY_NOT_ACCEPTED_FROM_CALLER';throw err}
  const link=readLink(project),requestedLens=options.lens||link.default_lens,allowedLenses=new Set([link.default_lens,...(link.secondary_lenses||[])])
  if(!allowedLenses.has(requestedLens)){const error=new Error(`unknown lens or lens is not granted by this project link: ${requestedLens}`);error.code='LENS_NOT_GRANTED';throw error}
  const data=contextData({
    ...options,
    project,
    surface:'mcp',
    task:options.task,
    lens:requestedLens,
    budget:options.budget||'standard',
    temporal:options.temporal||'current',
    manifest:Boolean(options.manifest),
    sources:options.source_ids||options.sources||[],
    cursor:options.cursor||null,
    noCache:true
  })
  if(options.source_ids?.length){const selected=new Set(data.sources.map(source=>source.source_id)),missing=options.source_ids.filter(id=>!selected.has(id));if(missing.length)throw new Error(`source handles are unavailable under the requested link/lens/lifecycle: ${missing.join(', ')}`)}
  const clean=withoutPrivatePaths(data)
  clean.self={documents:clean.self.documents}
  clean.project={name:data.project.name,documents:clean.project.documents}
  return clean
}
async function askConfirm(o,message){
  if(o.yes) return true
  if(!input.isTTY || !output.isTTY) throw new Error(`${message} Re-run with --yes to confirm.`)
  const rl=createInterface({input,output}); try{return (await rl.question(`${message} Type "yes" to continue: `)).trim().toLowerCase()==='yes'}finally{rl.close()}
}
async function askValue(message){const rl=createInterface({input,output});try{return (await rl.question(`${message}: `)).trim()}finally{rl.close()}}
function setupFindings(project){
  const files=markdownFiles(project); const names=files.map(path=>slash(relative(project,path)))
  const instructions=names.filter(x=>/(^|\/)(AGENTS|CLAUDE|CODEX)\.md$/i.test(x))
  const context=names.filter(x=>/(profile|context|bio|cv|resume|voice|identity)/i.test(x))
  const lower=basename(project).toLowerCase(); const lens=lower.includes('linkedin')?'publishing':lower.includes('career')?'career':'general'
  return {instructions,context,suggested_lens:lens,likely_duplicates:context,migration_recommendations:context.map(path=>`${path}: compare with canonical self; retain project-specific content and propose reusable knowledge`)}
}
function normalize(text){ return text.toLowerCase().replace(/\s+/g,' ').replace(/[^\p{L}\p{N} ]/gu,'').trim() }
function similarity(a,b){ const aa=tokenize(a),bb=tokenize(b); if(!aa.size&&!bb.size)return 1; let both=0;for(const x of aa)if(bb.has(x))both++;return both/(aa.size+bb.size-both) }
function analysis(project){
  const link=readLink(project); const selfDocs=sourceRecords(link.path,'self','private',null,'generic',link).records
  const projectDocs=sourceRecords(project,'project','private',null,'generic',link).records
  const findings=[]
  for(const p of projectDocs){
    let matched=false
    for(const s of selfDocs){
      if(normalize(p.content)===normalize(s.content) && normalize(p.content)){
        findings.push({classification:'Exact duplicate',project_file:p.path,self_file:s.path,evidence:'normalized contents match',recommendation:'Reference canonical self; keep project artifact until reviewed.'});matched=true
        if(statSync(p.absolute_path).mtimeMs<statSync(s.absolute_path).mtimeMs)findings.push({classification:'Stale copy',project_file:p.path,self_file:s.path,evidence:'matching project copy is older',recommendation:'Regenerate view after review; do not delete automatically.'})
        continue
      }
      const score=similarity(p.content,s.content)
      if(score>=0.72){findings.push({classification:'Semantic duplicate',project_file:p.path,self_file:s.path,evidence:`token similarity ${score.toFixed(2)}`,recommendation:'Compare and retain only project-specific extension.'});matched=true}
      const pNums=[...p.content.matchAll(/\b\d+(?:\.\d+)?%?\b/g)].map(x=>x[0]); const sNums=[...s.content.matchAll(/\b\d+(?:\.\d+)?%?\b/g)].map(x=>x[0])
      if(score>=0.35 && pNums.length && sNums.length && pNums.some(x=>!sNums.includes(x))){findings.push({classification:'Contradiction',project_file:p.path,self_file:s.path,evidence:`related text has differing metrics (${pNums.join(', ')} vs ${sNums.join(', ')})`,recommendation:'Verify evidence and create fact_correction or conflict_resolution proposal.'});matched=true}
    }
    if(p.sensitivity==='employer-confidential' && /public|publish|linkedin/i.test(p.path)) findings.push({classification:'Sensitive leakage',project_file:p.path,self_file:null,evidence:'employer-confidential content in publishing-like path',recommendation:'Restrict visibility and remove from public output after review.'})
    if(!matched){
      const candidate=/(identity|career|voice|preference|story|achievement|leadership)/i.test(p.path)
      const unclear=!candidate&&/(profile|context)/i.test(p.path)
      findings.push({classification:candidate?'Candidate for self':unclear?'Unclear ownership':'Project-specific content',project_file:p.path,self_file:null,evidence:candidate?'durable-context filename pattern':unclear?'context-like path without canonical match':'no canonical overlap detected',recommendation:candidate?'Create proposal with evidence.':unclear?'Review ownership; keep file in place until decided.':'Keep owned by project.'})
    }
  }
  return {generated_at:new Date().toISOString(),project:slash(project),self:slash(link.path),findings}
}
function filterAnalysis(report,type){
  if(type==='overlap') return report.findings.filter(x=>['Exact duplicate','Semantic duplicate','Project-specific content','Candidate for self','Unclear ownership','Sensitive leakage'].includes(x.classification))
  if(type==='conflicts') return report.findings.filter(x=>x.classification==='Contradiction' || x.classification==='Sensitive leakage')
  if(type==='stale') return report.findings.filter(x=>x.classification==='Stale copy')
  return report.findings
}
function proposalDir(project){return assertContainedPath(project,join(project,'.holoself','proposals'),'proposal directory')}
function proposalFile(project,id){if(!UUID_RE.test(id))throw new Error(`invalid proposal id: ${id}`);return join(proposalDir(project),`${id}.yaml`)}
function proposalText(p){ return yamlObject(p) }
function proposalChanges(p){return Array.isArray(p.changes)?p.changes:[{change_id:'claim',target:p.target,operation:'append_claim',proposal_type:p.proposal_type,claim:p.claim,evidence:p.evidence,confidence:p.confidence,visibility:p.visibility}]}
function validateProposal(p){
  const errors=[],v2=p?.schema_version===2,requiredStrings=v2?['proposal_id','source_project','status','created_at']:['proposal_id','source_project','target','proposal_type','claim','evidence','confidence','visibility','status','created_at'],allowedKeys=new Set(['schema_version','title','proposal_id','source_project','source_project_path','source_files','target','proposal_type','claim','evidence','confidence','visibility','status','created_at','reviewed_at','provenance','changes','_path'])
  if(!p||Array.isArray(p)||typeof p!=='object')return ['proposal must be a mapping']
  for(const key of Object.keys(p))if(!allowedKeys.has(key))errors.push(`unknown proposal field: ${key}`)
  for(const key of requiredStrings)if(typeof p[key]!=='string'||!p[key].trim())errors.push(`proposal ${key} must be a non-empty string`)
  if(typeof p.proposal_id==='string'&&!UUID_RE.test(p.proposal_id))errors.push('proposal_id must be a UUID')
  const terminal=PROPOSAL_STATES.includes(p.status)&&p.status!=='pending'
  if(v2){
    if(typeof p.title!=='string'||!p.title.trim())errors.push('proposal title must be a non-empty string')
    if(!Array.isArray(p.changes)||!p.changes.length)errors.push('proposal changes must be a non-empty array')
    const ids=new Set();for(const change of p.changes||[]){if(!change||Array.isArray(change)||typeof change!=='object'){errors.push('proposal change must be a mapping');continue}for(const key of ['change_id','target','operation'])if(typeof change[key]!=='string'||!change[key].trim())errors.push(`proposal change ${key} must be a non-empty string`);if(ids.has(change.change_id))errors.push(`duplicate change_id: ${change.change_id}`);ids.add(change.change_id);if(change.operation!=='append_claim')errors.push(`unsupported proposal operation: ${change.operation}`);if(isAbsolute(change.target||'')||slash(change.target||'').split('/').includes('..')||!String(change.target||'').toLowerCase().endsWith('.md'))errors.push(`proposal change target must be a contained relative Markdown path: ${change.change_id}`);if(!PROPOSAL_TYPES.includes(change.proposal_type))errors.push(`invalid proposal_type: ${change.proposal_type}`);if(!VISIBILITIES.includes(change.visibility))errors.push(`invalid proposal visibility: ${change.visibility}`);for(const key of ['claim','evidence','confidence'])if(typeof change[key]!=='string'||!change[key].trim())errors.push(`proposal change ${key} must be a non-empty string`)}
  }
  if(!terminal&&typeof p.target==='string'&&(isAbsolute(p.target)||slash(p.target).split('/').includes('..')||!p.target.toLowerCase().endsWith('.md')))errors.push('proposal target must be a contained relative Markdown path')
  if(!v2&&!PROPOSAL_TYPES.includes(p.proposal_type))errors.push(`invalid proposal_type: ${p.proposal_type}`)
  if(!PROPOSAL_STATES.includes(p.status))errors.push(`invalid proposal status: ${p.status}`)
  if(!v2&&!VISIBILITIES.includes(p.visibility))errors.push(`invalid proposal visibility: ${p.visibility}`)
  if(typeof p.created_at==='string'&&Number.isNaN(Date.parse(p.created_at)))errors.push('proposal created_at must be an ISO date-time')
  if(p.reviewed_at!==undefined&&(typeof p.reviewed_at!=='string'||Number.isNaN(Date.parse(p.reviewed_at))))errors.push('proposal reviewed_at must be an ISO date-time')
  if(p.source_project_path!==undefined&&typeof p.source_project_path!=='string')errors.push('proposal source_project_path must be a string')
  for(const key of ['source_files','provenance'])if(!Array.isArray(p[key])||!p[key].length||p[key].some(x=>typeof x!=='string'||!x.trim()))errors.push(`proposal ${key} must be a non-empty string array`)
  if(!terminal&&Array.isArray(p.source_files)&&p.source_files.some(x=>isAbsolute(x)||slash(x).split('/').includes('..')))errors.push('proposal source_files must be contained relative paths')
  const textFields=[p.claim,p.evidence,p.confidence,...proposalChanges(p).flatMap(x=>[x.claim,x.evidence,x.confidence]),...(Array.isArray(p.provenance)?p.provenance:[])];if(textFields.some(x=>typeof x==='string'&&/<!--\s*\/?holoself-claim/i.test(x)))errors.push('proposal text contains reserved claim markers')
  return errors
}
function readProposal(path){
  if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error(`proposal is not a regular file: ${path}`)
  let p;try{p=parseYaml(readFileSync(path,'utf8'))}catch(error){throw new Error(`malformed proposal ${path}: ${error.message}`)}
  const errors=validateProposal(p);if(errors.length)throw new Error(`invalid proposal ${path}: ${errors.join('; ')}`)
  if(basename(path,'.yaml')!==p.proposal_id)throw new Error(`proposal filename does not match proposal_id: ${path}`)
  p._path=path;return p
}
function listProposalData(project){
  return scanProposalStore(project).managed
}
function scanProposalStore(project){
  const dir=proposalDir(project);if(!existsSync(dir))return {managed:[],diagnostics:[]}
  if(lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory())throw new Error(`proposal directory is unsafe: ${dir}`)
  const managed=[],diagnostics=[]
  for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>canonicalSort(a.name,b.name))){
    const rel=`.holoself/proposals/${entry.name}`,path=join(dir,entry.name)
    if(entry.isDirectory()){diagnostics.push({path:rel,code:'UNMANAGED_PROPOSAL_DIRECTORY',severity:'warning',suggested_action:'review-manually'});continue}
    if(entry.isSymbolicLink()||!entry.isFile()){diagnostics.push({path:rel,code:'UNSAFE_PROPOSAL_ENTRY',severity:'error',suggested_action:'review-manually'});continue}
    if(!entry.name.endsWith('.yaml')){diagnostics.push({path:rel,code:'UNMANAGED_PROPOSAL_FORMAT',severity:'warning',suggested_action:'adopt-or-preserve'});continue}
    try{managed.push(readProposal(path))}catch(error){diagnostics.push({path:rel,code:'INVALID_PROPOSAL',severity:'error',suggested_action:'repair-or-preserve',detail:error.message.replace(path,rel)})}
  }
  return {managed,diagnostics}
}
function findProposal(project,id){
  if(typeof id!=='string'||!UUID_PREFIX_RE.test(id)||id.includes('..')||id.includes('/')||id.includes('\\'))throw new Error(`invalid proposal id: ${id}`)
  const scan=scanProposalStore(project),matches=scan.managed.filter(p=>p.proposal_id===id||p.proposal_id.startsWith(id));if(!matches.length){const invalid=scan.diagnostics.find(item=>basename(item.path,'.yaml').startsWith(id));if(invalid)throw new Error(invalid.detail||`${invalid.code}: ${invalid.path}`);throw new Error(`proposal not found: ${id}`)}if(matches.length>1)throw new Error(`ambiguous proposal id: ${id}`);return matches[0]
}
function proposalProjectErrors(p,project){
  const errors=[];if(p.source_project!==basename(project))errors.push('proposal source_project does not match linked project')
  if(p.source_project_path&&resolve(p.source_project_path)!==resolve(project))errors.push('proposal source_project_path does not match linked project')
  for(const source of p.source_files||[]){try{const path=assertContainedPath(project,resolve(project,source),'proposal source file');if(!existsSync(path)||!lstatSync(path).isFile())errors.push(`proposal source file not found: ${source}`)}catch(error){errors.push(error.message)}}return errors
}
function saveProposal(p,path=p._path){const errors=validateProposal(p);if(errors.length)throw new Error(`invalid proposal: ${errors.join('; ')}`);const clean={...p};delete clean._path;atomicWrite(path,proposalText(clean))}
function createProposal(project,input){
  const link=readLink(project);if(link.proposals!=='enabled')throw new Error('proposals are not enabled for link')
  const sourceFiles=input.source_files||[];if(!sourceFiles.length)throw new Error('proposal requires at least one source file')
  for(const source of sourceFiles){const path=assertContainedPath(project,resolve(project,source),'proposal source file');if(!existsSync(path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error(`source file not found or unsafe: ${source}`)}
  const p={schema_version:2,proposal_id:randomUUID(),title:`Review reusable context from ${basename(project)}`,source_project:basename(project),source_project_path:slash(project),source_files:sourceFiles,status:'pending',created_at:new Date().toISOString(),provenance:sourceFiles.map(x=>`${basename(project)}:${x}`),changes:[{change_id:'claim',target:input.target||'context/claims.md',operation:'append_claim',proposal_type:input.proposal_type||'new_fact',claim:input.claim,evidence:input.evidence||`Source project files: ${sourceFiles.join(', ')}`,confidence:input.confidence||'unverified',visibility:input.visibility||'private'}]}
  const errors=validateProposal(p);if(errors.length)throw new Error(errors.join('; '));createLinkDirs(project,{preserveReadme:true});saveProposal(p,proposalFile(project,p.proposal_id));return p
}
function proposalPreviewData(project,id){
  const p=findProposal(project,id);if(p.status!=='pending')throw new Error(`proposal is ${p.status}, expected pending`)
  const projectErrors=proposalProjectErrors(p,project);if(projectErrors.length)throw new Error(`proposal provenance validation failed: ${projectErrors.join('; ')}`)
  const link=readLink(project),grouped=new Map(),approvedAt='<commit-time>',previews=[]
  for(const change of proposalChanges(p)){
    const target=safeTarget(link.path,change.target),before=grouped.get(target)?.before??(existsSync(target)?readFileSync(target,'utf8'):'---\naccess_lenses: [general, career, publishing, technical, leadership, interview, private]\ndisclosure: review-required\nsensitivity: personal\ndocument_role: evidence\n---\n')
    if(claims(before).some(x=>normalize(x)===normalize(change.claim)))throw new Error(`proposal duplicates an existing canonical claim: ${change.change_id}`)
    const block=`\n\n<!-- holoself-claim visibility=${change.visibility} -->\n## Approved proposal ${p.proposal_id}/${change.change_id}\n\n${change.claim}\n\n- Evidence: ${change.evidence}\n- Confidence: ${change.confidence}\n- Visibility: ${change.visibility}\n- Provenance: ${p.provenance.join('; ')}\n- Approved: ${approvedAt}\n<!-- /holoself-claim -->\n`,current=grouped.get(target)?.after??before,after=current.trimEnd()+block
    grouped.set(target,{target,before,after});previews.push({change_id:change.change_id,target:slash(relative(link.path,target)),before_sha256:hash(before),after_sha256:hash(after),preview:block.trim()})
  }
  return {proposal:p,link,grouped,changes:previews,preview_hash:hash(JSON.stringify(previews))}
}
function stateProposal(project,p,state,details={}){
  if(!UUID_RE.test(p.proposal_id))throw new Error('proposal_id must be a UUID')
  const self=readLink(project).path,dir=assertContainedPath(self,join(self,'proposals',state),'proposal archive'),archive=assertContainedPath(self,join(dir,`${p.proposal_id}.yaml`),'proposal archive'),receiptDir=assertContainedPath(self,join(self,'proposals','receipts'),'proposal receipts'),receipt=assertContainedPath(self,join(receiptDir,`${p.proposal_id}-${state}.json`),'proposal receipt');if(existsSync(archive)||existsSync(receipt))throw new Error(`proposal archive or receipt collision: ${archive}`)
  const original={status:p.status,reviewed_at:p.reviewed_at},proposalSha=hash(proposalText(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='_path'))));p.status=state;p.reviewed_at=new Date().toISOString();ensureDir(dir);ensureDir(receiptDir)
  try{writeFileSync(archive,proposalText(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='_path'))),{encoding:'utf8',flag:'wx'});writeFileSync(receipt,JSON.stringify({schema_version:1,proposal_id:p.proposal_id,decision:state,reviewed_at:p.reviewed_at,proposal_sha256:proposalSha,...details},null,2)+'\n',{encoding:'utf8',flag:'wx'});saveProposal(p)}catch(error){rmSync(archive,{force:true});rmSync(receipt,{force:true});p.status=original.status;if(original.reviewed_at===undefined)delete p.reviewed_at;else p.reviewed_at=original.reviewed_at;throw error}
}
function safeTarget(self,target){
  const root=resolve(self),path=assertContainedPath(root,resolve(root,target),'proposal target'),rel=slash(relative(root,path)),top=rel.split('/')[0]
  if(!['profile','context','reference','contribs','topics'].includes(top)||!path.toLowerCase().endsWith('.md'))throw new Error('proposal target must be Markdown under profile, context, reference, contribs, or topics')
  return path
}
function catalogRoot(project){return assertContainedPath(project,join(project,'.holoself','catalog'),'catalog directory')}
function catalogFilePath(project){return join(catalogRoot(project),'catalog.json')}
function privacyMetadata(metadata,registry=null){
  const rawSensitivity=typeof metadata.sensitivity==='string'?metadata.sensitivity:null,sensitivity=SENSITIVITIES.includes(rawSensitivity)?rawSensitivity:(rawSensitivity?'restricted':'personal'),known=x=>registry?registry.byId.has(x):LENSES.includes(x)
  const read_scope=['shared','local','restricted'].includes(metadata.read_scope)?metadata.read_scope:(visibility(metadata)==='private'?'restricted':'shared')
  const result={access_lenses:accessLenses(metadata).filter(known),disclosure:disclosure(metadata),sensitivity,document_role:documentRole(metadata),publication_allowed:publicationAllowed({...metadata,sensitivity}),task_include:Array.isArray(metadata.task_include)?metadata.task_include:[],task_exclude:Array.isArray(metadata.task_exclude)?metadata.task_exclude:[],visibility:visibility(metadata),read_scope,public_safe:Object.hasOwn(metadata,'public_safe')?metadata.public_safe:null,confidence:typeof metadata.confidence==='string'?metadata.confidence:null,exclude_lenses:Array.isArray(metadata.exclude_lenses)?metadata.exclude_lenses.filter(known):[],field_visibility:{},knowledge_status:KNOWLEDGE_STATUSES.includes(metadata.knowledge_status)?metadata.knowledge_status:'current',temporal_scope:TEMPORAL_SCOPES.includes(metadata.temporal_scope)?metadata.temporal_scope:'current',valid_from:typeof metadata.valid_from==='string'?metadata.valid_from:null,valid_until:typeof metadata.valid_until==='string'?metadata.valid_until:null,valid_until_epoch_ms:null,review_after:typeof metadata.review_after==='string'?metadata.review_after:null,supersedes:Array.isArray(metadata.supersedes)?metadata.supersedes:[],superseded_by:typeof metadata.superseded_by==='string'?metadata.superseded_by:null}
  if(metadata.field_visibility&&typeof metadata.field_visibility==='object'&&!Array.isArray(metadata.field_visibility))for(const [key,value] of Object.entries(metadata.field_visibility))result.field_visibility[key]=VISIBILITIES.includes(value)?value:'private'
  if(result.valid_until)result.valid_until_epoch_ms=dateValue(result.valid_until,true)
  return result
}
function privacySections(body,policy){
  const chunks=[],claimPattern=/<!-- holoself-claim visibility=([a-z-]+) -->([\s\S]*?)<!-- \/holoself-claim -->/g
  const ordinary=body.replace(claimPattern,(_,claimVisibility,claimBody)=>{const v=VISIBILITIES.includes(claimVisibility)?claimVisibility:'private';for(const section of sections(claimBody))chunks.push({...section,visibility:v,claim:true,disclosure:v==='public-safe'?'publish-approved':'review-required'});return ''})
  for(const section of sections(ordinary)){const heading=section.heading.toLowerCase(),fieldRule=Object.entries(policy.field_visibility||{}).find(([field])=>heading.includes(field.toLowerCase())),v=COMPENSATION_RE.test(heading)?'private':fieldRule?.[1]||policy.visibility;chunks.push({...section,visibility:v,claim:false,disclosure:policy.disclosure})}
  return chunks
}
function buildCatalogSource(file,sourceKind,root,registry,tolerant=false){
  const rel=slash(relative(root,file))
  if(!existsSync(file)) return null
  const read=readSourceWithStat(file)
  if(!read) return { unreadable: true, error: `${rel}: unreadable: file locked or sharing violation` }
  const {text,stat}=read
  let parsed
  try{parsed=frontmatter(text,{tolerant,registry})}catch(err){return {error:`${rel}: ${err.message}`}}
  const {metadata,body,warnings:docWarnings}=parsed
  if(secretFile(file,root)||SECRET_RE.test(text)||['secret','credential','credentials'].includes(metadata.sensitivity)){return {secret:true}}
  if(sourceKind==='canonical'){
    const metadataErrors=canonicalPrivacyMetadataErrors(metadata,registry)
    if(metadataErrors.length)return {error:`${rel}: ${metadataErrors.join('; ')}`}
  }
  if(!VISIBILITIES.includes(visibility(metadata)))return null

  const policy=privacyMetadata(metadata,registry)
  const rawSections=privacySections(body,policy)
  const seenSlugs=new Map()
  const catalogSections=rawSections.map(sec=>{
    const baseSlug=slugHeading(sec.heading)
    const count=(seenSlugs.get(baseSlug)||0)+1
    seenSlugs.set(baseSlug,count)
    const section_id=count===1?baseSlug:`${baseSlug}-${count}`
    const snippet=(sec.content.length>360?sec.content.slice(0,357)+'...':sec.content).trim()
    return {section_id,heading:sec.heading,visibility:sec.visibility,disclosure:sec.disclosure,claim:Boolean(sec.claim),snippet}
  })

  const annotatedClaims=rawSections.flatMap(sec=>claims(sec.content).map(text=>({text,visibility:COMPENSATION_RE.test(text)?'private':sec.visibility})))
  const annotatedLinks=rawSections.flatMap(sec=>links(sec.content).map(value=>({value,visibility:sec.visibility})))
  const annotatedTags=rawSections.flatMap(sec=>tags(sec.content).map(value=>({value,visibility:sec.visibility})))
  annotatedClaims.sort((a,b)=>canonicalSort(a.text,b.text))
  annotatedLinks.sort((a,b)=>canonicalSort(a.value,b.value))
  annotatedTags.sort((a,b)=>canonicalSort(a.value,b.value))

  const sourceTextHash=hash(text)
  const spaceId=sourceKind==='canonical'?'self':(sourceKind==='project'?canonicalSpaceId(root):'contrib')
  const sRef=sourceRef(spaceId,rel,sourceTextHash,null)
  const estimatedTokens=Math.ceil(text.length/4)

  return {
    record:{
      source_kind:sourceKind,
      source_ref:sRef,
      file:rel,
      size:stat.size,
      modified_ms:stat.modified_ms,
      mtime_ns:stat.mtime_ns,
      ino:stat.ino,
      dev:stat.dev,
      source_text_hash:sourceTextHash,
      frontmatter:policy,
      sections:catalogSections,
      claims:annotatedClaims,
      tags:annotatedTags,
      links:annotatedLinks,
      estimated_tokens:estimatedTokens
    },
    rawSections,
    warnings:(docWarnings||[]).map(w=>`${rel}: ${w}`)
  }
}

function isPartitionFresh(catalog,rootDir,files,registry,expectedContextHash,spaceId){
  if(!catalog)return false
  if(catalog.schema_version!==CATALOG_SCHEMA_VERSION)return false
  if(catalog.lens_registry_hash!==registry.registry_hash)return false
  if(spaceId==='self'){
    if(catalog.project_context_hash!==null)return false
  }else{
    if(catalog.project_context_hash!==expectedContextHash)return false
  }
  const known=new Map()
  for(const s of catalog.sources||[]) known.set(s.file,s)
  for(const s of catalog.ignored_sources||[]) known.set(s.file,s)

  if(files.length!==known.size)return false

  for(const file of files){
    const rel=slash(relative(rootDir,file))
    const expected=known.get(rel)
    if(!expected)return false
    let st
    try{st=getStatTuple(file)}catch{return false}
    if(expected.size!==st.size||expected.mtime_ns!==st.mtime_ns||expected.ino!==st.ino||expected.dev!==st.dev)return false
  }
  return true
}

function ensureCatalogPartition(spaceId,rootDir,files,registry,options={}){
  const catPath=catalogFilePath(rootDir)
  let existingCatalog=null
  if(!options.rebuild&&existsSync(catPath)){
    try{
      const parsed=JSON.parse(readFileSync(catPath,'utf8'))
      const val=validateCatalogSchema(parsed)
      if(val.valid&&parsed.space_id===spaceId&&parsed.lens_registry_hash===registry.registry_hash){
        if(spaceId==='self'&&parsed.project_context_hash===null){
          existingCatalog=parsed
        }else if(spaceId!=='self'&&parsed.project_context_hash===options.expectedProjectContextHash){
          existingCatalog=parsed
        }
      }
    }catch{}
  }

  const isFresh=!options.rebuild&&isPartitionFresh(existingCatalog,rootDir,files,registry,options.expectedProjectContextHash,spaceId)
  if(isFresh){
    const persistentWarnings=(existingCatalog?.ignored_sources||[])
      .filter(s=>s.reason&&s.reason!=='secret'&&s.reason!=='unsupported visibility')
      .map(s=>s.reason)
    return {catalog:existingCatalog,fresh:true,skippedSecrets:0,warnings:persistentWarnings,catalog_reads:0}
  }

  const existingByFile=new Map(existingCatalog?existingCatalog.sources.map(s=>[s.file,s]):[])
  const existingIgnoredByFile=new Map(existingCatalog?.ignored_sources?existingCatalog.ignored_sources.map(s=>[s.file,s]):[])

  const sources=[],ignored_sources=[],warnings=[]
  let skippedSecrets=0,catalogReads=0
  const sourceKind=spaceId==='self'?'canonical':'project'
  const isProject=spaceId!=='self'

  for(const file of files){
    const rel=slash(relative(rootDir,file))
    const sOld=existingByFile.get(rel)
    if(!options.rebuild&&sOld){
      let st=null
      try{st=getStatTuple(file)}catch{}
      if(st&&sOld.size===st.size&&sOld.mtime_ns===st.mtime_ns&&sOld.ino===st.ino&&sOld.dev===st.dev){
        sources.push(sOld)
        continue
      }
    }
    const sIgnoredOld=existingIgnoredByFile.get(rel)
    if(!options.rebuild&&sIgnoredOld){
      let st=null
      try{st=getStatTuple(file)}catch{}
      if(st&&sIgnoredOld.size===st.size&&sIgnoredOld.mtime_ns===st.mtime_ns&&sIgnoredOld.ino===st.ino&&sIgnoredOld.dev===st.dev){
        ignored_sources.push(sIgnoredOld)
        continue
      }
    }
    catalogReads++
    let built
    try {
      built=buildCatalogSource(file,sourceKind,rootDir,registry,isProject)
    } catch(err) {
      built={unreadable:true,error:`${rel}: unreadable (${err.message})`}
    }
    if(built?.unreadable){
      warnings.push(built.error)
      // Per plan §6.1.5.3.4: "sem gravar mtime falso no catálogo"
      // Write zeroed stat tuple so it will not match on subsequent runs and will be re-attempted
      ignored_sources.push({file:rel,size:0,modified_ms:0,mtime_ns:'0',ino:'0',dev:'0',reason:built.error})
      continue
    }
    if(!built){
      let st=null
      try{st=getStatTuple(file)}catch{}
      ignored_sources.push({file:rel,size:st?st.size:0,modified_ms:st?st.modified_ms:0,mtime_ns:st?st.mtime_ns:'0',ino:st?st.ino:'0',dev:st?st.dev:'0',reason:st?'unsupported visibility':'unreadable: stat failure'})
      continue
    }
    if(built.secret){
      skippedSecrets++
      let st=null
      try{st=getStatTuple(file)}catch{}
      ignored_sources.push({file:rel,size:st?st.size:0,modified_ms:st?st.modified_ms:0,mtime_ns:st?st.mtime_ns:'0',ino:st?st.ino:'0',dev:st?st.dev:'0',reason:'secret'})
      continue
    }
    if(built.error){
      warnings.push(built.error)
      let st=null
      try{st=getStatTuple(file)}catch{}
      ignored_sources.push({file:rel,size:st?st.size:0,modified_ms:st?st.modified_ms:0,mtime_ns:st?st.mtime_ns:'0',ino:st?st.ino:'0',dev:st?st.dev:'0',reason:built.error})
      continue
    }
    if(built.warnings)warnings.push(...built.warnings)
    if(built.record)sources.push(built.record)
  }

  sources.sort((a,b)=>canonicalSort(a.file,b.file))
  ignored_sources.sort((a,b)=>canonicalSort(a.file,b.file))

  if(isProject&&options.link?.project_context){
    const link=options.link,projectPaths=sources.map(s=>s.file),assertionErrors=[]
    for(const s of sources){
      if(!matchesAny(s.file,link.project_context.include))assertionErrors.push(`${s.file}: outside include policy`)
      if(matchesAny(s.file,link.project_context.exclude))assertionErrors.push(`${s.file}: matched exclude policy`)
    }
    for(const pattern of link.project_context.assert_include||[]){
      if(!projectPaths.some(file=>globRegex(pattern).test(file)))assertionErrors.push(`assert_include unmatched: ${pattern}`)
    }
    for(const pattern of link.project_context.assert_exclude||[]){
      if(projectPaths.some(file=>globRegex(pattern).test(file)))assertionErrors.push(`assert_exclude matched indexed file: ${pattern}`)
    }
    for(const s of sources){
      for(const sec of s.sections||[]){
        if(SECRET_RE.test(sec.snippet))assertionErrors.push(`${s.source_kind}:${s.file}: secret-like content survived index build`)
      }
    }
    if(assertionErrors.length)throw new Error(`index post-build assertions failed: ${assertionErrors.join('; ')}`)
  }

  const catalog={
    schema_version:CATALOG_SCHEMA_VERSION,
    space_id:spaceId,
    lens_registry_hash:registry.registry_hash,
    project_context_hash:spaceId==='self'?null:(options.expectedProjectContextHash||null),
    generated_at:new Date().toISOString(),
    sources,
    ignored_sources
  }

  const val=validateCatalogSchema(catalog)
  if(!val.valid)throw new Error(`catalog schema validation failed: ${val.errors.join('; ')}`)

  ensureDir(catalogRoot(rootDir))
  atomicWriteFile(catPath,JSON.stringify(catalog,null,2)+'\n')
  return {catalog,fresh:false,skippedSecrets,warnings,catalog_reads:catalogReads}
}

let CONTRIB_CATALOG_CACHE=null
function ensureContribPartition(packageRoot,registry,selfRoot=null){
  const catPath=selfRoot?join(catalogRoot(selfRoot),'contrib.json'):null
  if(CONTRIB_CATALOG_CACHE&&CONTRIB_CATALOG_CACHE.lens_registry_hash===registry.registry_hash){
    if(catPath){
      let needWrite = !existsSync(catPath)
      if(!needWrite){
        try {
          const onDisk = JSON.parse(readFileSync(catPath, 'utf8'))
          if(onDisk.lens_registry_hash !== registry.registry_hash) needWrite = true
        } catch { needWrite = true }
      }
      if(needWrite){
        try{
          ensureDir(dirname(catPath))
          atomicWriteFile(catPath,JSON.stringify(CONTRIB_CATALOG_CACHE,null,2)+'\n')
        }catch{}
      }
    }
    return { ...CONTRIB_CATALOG_CACHE, catalog: CONTRIB_CATALOG_CACHE, fresh: true, catalog_reads: 0 }
  }
  let metaCatalog
  try{metaCatalog=JSON.parse(readFileSync(join(packageRoot,'contribs','catalog.json'),'utf8'))}catch{
    const emptyCat = {schema_version:CATALOG_SCHEMA_VERSION,space_id:'contrib',lens_registry_hash:registry.registry_hash,project_context_hash:null,generated_at:new Date().toISOString(),sources:[]}
    return { ...emptyCat, catalog: emptyCat, fresh: true, catalog_reads: 0 }
  }

  if(catPath&&existsSync(catPath)){
    try{
      const onDisk=JSON.parse(readFileSync(catPath,'utf8'))
      const val=validateCatalogSchema(onDisk)
      if(val.valid&&onDisk.space_id==='contrib'&&onDisk.lens_registry_hash===registry.registry_hash){
        const known=new Map(onDisk.sources.map(s=>[s.file,s]))
        let isFresh=true
        const validEntries=[]
        for(const entry of metaCatalog.contribs||[]){
          const rel=`contribs/${entry.path}`
          const filePath=join(packageRoot,'contribs',entry.path)
          if(!existsSync(filePath)||lstatSync(filePath).isSymbolicLink()||!lstatSync(filePath).isFile())continue
          validEntries.push(rel)
          const sOld=known.get(rel)
          if(!sOld){isFresh=false;break}
          let st
          try{st=getStatTuple(filePath)}catch{isFresh=false;break}
          if(sOld.size!==st.size||sOld.mtime_ns!==st.mtime_ns||sOld.ino!==st.ino||sOld.dev!==st.dev){
            isFresh=false
            break
          }
        }
        if(isFresh&&onDisk.sources.length===validEntries.length){
          CONTRIB_CATALOG_CACHE=onDisk
          return { ...onDisk, catalog: onDisk, fresh: true, catalog_reads: 0 }
        }
      }
    }catch{}
  }

  let catalogReads=0
  const sources=[]
  for(const entry of metaCatalog.contribs||[]){
    const filePath=join(packageRoot,'contribs',entry.path)
    if(!existsSync(filePath)||lstatSync(filePath).isSymbolicLink()||!lstatSync(filePath).isFile())continue
    catalogReads++
    const sourceRead=readSourceWithStat(filePath)
    if(!sourceRead)continue
    const {text,stat}=sourceRead
    const sourceTextHash=hash(text)
    const rel=`contribs/${entry.path}`,sRef=sourceRef('contrib',rel,sourceTextHash,null)
    const declaredLenses=['general','career','technical','leadership','publishing','interview','private'],sensitivity=entry.sensitivity||'none'
    const policy={
      access_lenses:declaredLenses,
      disclosure:'internal-only',
      sensitivity,
      document_role:'policy',
      publication_allowed:false,
      task_include:[],
      task_exclude:[],
      visibility:'linked-projects',
      read_scope:'shared',
      field_visibility:{},
      knowledge_status:'current',
      temporal_scope:'timeless',
      valid_until_epoch_ms:null,
      contrib:{id:entry.id,title:entry.title,domain:entry.domain,type:entry.type}
    }
    const rawSections=sections(text),seenSlugs=new Map()
    const catalogSections=rawSections.map(sec=>{
      const baseSlug=slugHeading(sec.heading)
      const count=(seenSlugs.get(baseSlug)||0)+1
      seenSlugs.set(baseSlug,count)
      const section_id=count===1?baseSlug:`${baseSlug}-${count}`
      const snippet=(sec.content.length>360?sec.content.slice(0,357)+'...':sec.content).trim()
      return {section_id,heading:sec.heading,visibility:'linked-projects',disclosure:'internal-only',claim:false,snippet}
    })
    sources.push({
      source_kind:'contrib',
      source_ref:sRef,
      file:rel,
      size:stat.size,
      modified_ms:stat.modified_ms,
      mtime_ns:stat.mtime_ns,
      ino:stat.ino,
      dev:stat.dev,
      source_text_hash:sourceTextHash,
      frontmatter:policy,
      sections:catalogSections,
      claims:[],
      tags:[],
      links:[],
      estimated_tokens:Math.ceil(text.length/4)
    })
  }
  sources.sort((a,b)=>canonicalSort(a.file,b.file))
  const catalog={schema_version:CATALOG_SCHEMA_VERSION,space_id:'contrib',lens_registry_hash:registry.registry_hash,project_context_hash:null,generated_at:new Date().toISOString(),sources}
  const val=validateCatalogSchema(catalog)
  if(!val.valid)throw new Error(`contrib catalog schema validation failed: ${val.errors.join('; ')}`)
  if(catPath){
    try{
      ensureDir(dirname(catPath))
      atomicWriteFile(catPath,JSON.stringify(catalog,null,2)+'\n')
    }catch{}
  }
  CONTRIB_CATALOG_CACHE=catalog
  return { ...catalog, catalog: catalog, fresh: false, catalog_reads: catalogReads }
}

function ensureCatalog(selfRoot,projectDir,link,registry,options={}){
  if(projectDir){
    try{purgeLegacyIndex(projectDir)}catch(err){if(err.code==='LEGACY_INDEX_PURGE_FAILED')throw err}
  }
  const selfFiles=canonicalFiles(selfRoot,{includeHistory:true})
  const selfResult=ensureCatalogPartition('self',selfRoot,selfFiles,registry,options)

  let projectResult=null
  if(projectDir&&existsSync(projectDir)&&resolve(projectDir)!==resolve(selfRoot)){
    const projectFiles=projectMarkdownFiles(projectDir,link)
    const expectedProjectContextHash=link?.project_context?hash(canonicalJson(link.project_context)):null
    projectResult=ensureCatalogPartition(canonicalSpaceId(projectDir),projectDir,projectFiles,registry,{
      ...options,
      link,
      expectedProjectContextHash
    })
  }
  const contribResult=ensureContribPartition(PACKAGE_ROOT,registry,selfRoot)

  const federated=[]
  const unreachable_spaces=[]
  let fedSkippedSecrets=0, fedCatalogReads=0
  let allFresh=selfResult.fresh&&(!projectResult||projectResult.fresh)&&Boolean(contribResult.fresh)
  const fedWarnings=[]

  if(Array.isArray(options.federatedSpaces)){
    for(const peer of options.federatedSpaces){
      const peerSpaceId=peer.space_id||canonicalSpaceId(peer.project_path)
      try{
        const pPath=resolve(peer.project_path)
        if(!existsSync(pPath)){
          unreachable_spaces.push(peerSpaceId)
          continue
        }
        const st=lstatSync(pPath)
        if(st.isSymbolicLink()){
          unreachable_spaces.push(peerSpaceId)
          continue
        }
        const dotHolo=join(pPath,'.holoself')
        if(existsSync(dotHolo)&&lstatSync(dotHolo).isSymbolicLink()){
          unreachable_spaces.push(peerSpaceId)
          continue
        }
        const peerLink=readLink(pPath,{tolerant:true})
        if(!peerLink||peerLink.binding_salt!==peer.binding_salt){
          unreachable_spaces.push(peerSpaceId)
          continue
        }
        try{purgeLegacyIndex(pPath)}catch{}
        const peerFiles=projectMarkdownFiles(pPath,peerLink)
        const expectedProjectContextHash=peerLink?.project_context?hash(canonicalJson(peerLink.project_context)):null
        const peerResult=ensureCatalogPartition(peerSpaceId,pPath,peerFiles,registry,{
          ...options,
          link:peerLink,
          expectedProjectContextHash
        })
        federated.push({
          space_id:peerSpaceId,
          name:basename(pPath),
          path:pPath,
          catalog:peerResult.catalog,
          link:peerLink
        })
        fedSkippedSecrets+=peerResult.skippedSecrets||0
        fedCatalogReads+=peerResult.catalog_reads||0
        if(!peerResult.fresh) allFresh=false
        if(peerResult.warnings?.length) fedWarnings.push(...peerResult.warnings)
      }catch{
        unreachable_spaces.push(peerSpaceId)
      }
    }
  }

  return {
    self:selfResult.catalog,
    project:projectResult?projectResult.catalog:null,
    contrib:contribResult.catalog||contribResult,
    federated,
    unreachable_spaces:[...new Set(unreachable_spaces)].sort(),
    fresh:allFresh,
    skippedSecrets:selfResult.skippedSecrets+(projectResult?.skippedSecrets||0)+fedSkippedSecrets,
    warnings:[...selfResult.warnings,...(projectResult?.warnings||[]),...fedWarnings],
    catalog_reads:selfResult.catalog_reads+(projectResult?.catalog_reads||0)+(contribResult?.catalog_reads||0)+fedCatalogReads
  }
}

function buildIndex(project,changed=false,persist=true,options={}){
  const link=readLink(project),registry=loadLensRegistry(link.path)
  const federatedSpaces=options.federated||options.spaces?.length
    ?getEligibleFederatedSpaces(link.path,project,options.lens||link.default_lens||'general',options)
    :[]
  const result=ensureCatalog(link.path,project,link,registry,{rebuild:!changed,federatedSpaces})
  const projectSpaceId=canonicalSpaceId(project)
  const projectEntries=(result.project?.sources||[]).map(s=>({...s,source_kind:'project',source_project:basename(project),space_id:projectSpaceId}))
  const selfEntries=(result.self?.sources||[]).map(s=>({...s,source_kind:'canonical',source_project:'self',space_id:'self'}))
  const fedEntries=[]
  for(const peer of (result.federated||[])){
    for(const s of (peer.catalog?.sources||[])){
      fedEntries.push({...s,source_kind:'federated',source_project:peer.space_id,space_id:peer.space_id,peer_name:peer.name})
    }
  }
  const entries=[...selfEntries,...projectEntries,...fedEntries]
  entries.sort((a,b)=>canonicalSort(`${a.source_kind}:${a.file}`,`${b.source_kind}:${b.file}`))
  const input_state_hash=hash(canonicalJson({
    self:result.self.sources.map(s=>[s.file,s.source_text_hash]),
    project:(result.project?.sources||[]).map(s=>[s.file,s.source_text_hash]),
    federated:(result.federated||[]).map(p=>[p.space_id,(p.catalog?.sources||[]).map(s=>[s.file,s.source_text_hash])])
  }))
  return {
    schema_version:1,
    privacy_policy_version:4,
    lens_registry_hash:registry.registry_hash,
    engine:'deterministic-json',
    source_of_truth:'Markdown',
    generated_at:result.project?.generated_at||result.self.generated_at,
    input_state_hash,
    project_context_hash:result.project?.project_context_hash||null,
    project:slash(project),
    self:slash(link.path),
    skipped_secret_files:result.skippedSecrets,
    warnings:result.warnings,
    build_assertions:{status:'passed',checks:['include-policy','exclude-policy','required-includes','forbidden-excludes','secret-pattern-scan'],included_project_files:projectEntries.length},
    entries,
    sources:entries
  }
}

function readIndex(project,auto=true,persist=true,options={}){
  return buildIndex(project,true,persist,options)
}

function searchIndex(index,query,lens='general',registry=null,resolution=null,temporal='current',options={}){
  const terms=[...tokenize(query)],results=[],behaviorLens=resolution?.base_lens||lens
  const entries=index.entries||index.sources||[]
  const consumerSpaceId=index.project?canonicalSpaceId(index.project):null
  for(const entry of entries){
    const entrySpaceId=entry.space_id||(entry.source_kind==='canonical'?'self':(consumerSpaceId||'project'))
    const isPeer=entry.source_kind==='federated'||Boolean(consumerSpaceId&&entrySpaceId!==consumerSpaceId&&entrySpaceId!=='self')
    const subj=isPeer
      ?{kind:'client:linked',space_id:consumerSpaceId,accessible_spaces:[consumerSpaceId],effective_allowed_lenses:options.effective_allowed_lenses||null}
      :null
    if(!allowed(entry.frontmatter||{},lens,'generic',null,resolution,subj,entrySpaceId)||!temporalDisposition(entry.frontmatter||{},query,{temporal}).include)continue
    const policy=entry.frontmatter||{}
    if(behaviorLens==='publishing'&&policy.sensitivity==='employer-confidential'&&policy.document_role!=='policy')continue
    if(behaviorLens==='publishing'&&policy.document_role==='evidence'&&!policy.publication_allowed)continue
    for(const section of entry.sections||[]){
      const sectionVisibility=VISIBILITIES.includes(section.visibility)?section.visibility:'private'
      if(!visibleUnderBehavior(sectionVisibility,behaviorLens,'generic'))continue
      const restrictions=[]
      const filtered=filterFieldVisibility(filterClaimVisibility(section.snippet||'',lens,entry.file,restrictions,resolution),entry.frontmatter||{},lens,entry.file,restrictions,resolution)
      if(!filtered.trim())continue
      const hay=`${section.heading} ${filtered}`.toLowerCase(),score=terms.filter(x=>hay.includes(x)).length
      if(!score||score<terms.length)continue
      const passage=filtered.length>360?filtered.slice(0,357)+'...':filtered
      const provPrefix=entry.source_kind==='canonical'?'self':(entry.source_kind==='federated'?entry.space_id:(entry.source_project||entry.space_id||entry.source_ref?.space_id))
      results.push({
        source_file:entry.file,
        source_kind:entry.source_kind==='canonical'?'self':entry.source_kind,
        source_project:entry.source_project||(entry.source_kind==='canonical'?'self':entry.space_id||entry.source_ref?.space_id),
        space_id:entrySpaceId,
        section:section.heading,
        matching_passage:passage,
        provenance:`${provPrefix}:${entry.file}#${section.heading}`,
        access_lenses:policy.access_lenses||[],
        disclosure:section.disclosure||policy.disclosure||'internal-only',
        sensitivity:policy.sensitivity||'personal',
        document_role:policy.document_role||'content',
        publication_allowed:Boolean(policy.publication_allowed),
        visibility:sectionVisibility,
        freshness:entry.modified_ms?new Date(entry.modified_ms).toISOString():entry.modified_at||new Date().toISOString(),
        score
      })
    }
  }

  if(options.federated||options.deduplicate){
    const localSpaceId=consumerSpaceId||'project'
    const scorePrec=r=>{
      if(r.space_id===localSpaceId||r.source_kind==='project') return 1
      if(r.space_id==='self'||r.source_kind==='canonical') return 2
      return 3
    }
    const passageMap=new Map()
    for(const r of results){
      const key=hash(r.matching_passage)
      const existing=passageMap.get(key)
      if(!existing){
        passageMap.set(key,r)
      }else{
        const pExist=scorePrec(existing)
        const pCurr=scorePrec(r)
        if(pCurr<pExist||(pCurr===pExist&&(r.space_id||'')<(existing.space_id||''))){
          passageMap.set(key,r)
        }
      }
    }
    return [...passageMap.values()].sort((a,b)=>b.score-a.score||canonicalSort(a.source_file,b.source_file)||canonicalSort(a.provenance,b.provenance))
  }

  return results.sort((a,b)=>b.score-a.score||canonicalSort(a.source_file,b.source_file))
}
export function ecosystemValidationErrors(root,project=null){
  const errors=[];let rootRegistry=null
  if(existsSync(root)){try{rootRegistry=loadLensRegistry(root)}catch(error){errors.push(error.message)}}
  const checkMarkdown=(base,registry=rootRegistry)=>{
    for(const path of markdownFiles(base)){
      const text=readFileSync(path,'utf8'),rel=slash(relative(base,path));let metadata={}
      try{metadata=frontmatter(text,{registry}).metadata}catch(error){errors.push(`${error.message}: ${rel}`)}
      const canonicalContent=/^(?:profile|context|topics)\//.test(rel)
      if(canonicalContent)for(const error of canonicalPrivacyMetadataErrors(metadata,registry))errors.push(`${error}: ${rel}`)
      if(metadata.visibility&&!VISIBILITIES.includes(metadata.visibility))errors.push(`invalid visibility ${metadata.visibility}: ${rel}`)
      if(metadata.field_visibility!==undefined&&(typeof metadata.field_visibility!=='object'||Array.isArray(metadata.field_visibility)))errors.push(`field_visibility must be a mapping: ${rel}`)
      else for(const value of Object.values(metadata.field_visibility||{}))if(!VISIBILITIES.includes(value))errors.push(`invalid field visibility ${value}: ${rel}`)
      for(const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)/g))if(!/^(?:https?:|mailto:)/.test(match[1])&&!existsSync(resolve(dirname(path),match[1])))errors.push(`broken reference ${match[1]}: ${rel}`)
      const generated=metadata.generated_from
      if(Array.isArray(generated)){for(const source of generated){const sourcePath=resolve(base,source);if(!existsSync(sourcePath))errors.push(`broken generated source ${source}: ${rel}`);else if(statSync(sourcePath).mtimeMs>statSync(path).mtimeMs)errors.push(`stale generated view: ${rel}`)}}
    }
    const claimsPath=join(base,'context','claims.md')
    if(existsSync(claimsPath)){const seen=new Set();for(const claim of canonicalClaims(readFileSync(claimsPath,'utf8'))){const key=normalize(claim);if(seen.has(key))errors.push(`duplicate canonical claim: ${claim}`);seen.add(key)}}
  }
  if(existsSync(root)&&rootRegistry)checkMarkdown(root)
  const proposalRoots=[join(root,'proposals')]
  if(project){
    try{
      const link=readLink(project)
      if(!existsSync(link.path))errors.push(`broken self path: ${link.path}`)
      else if(!existsSync(join(link.path,'profile'))||!existsSync(join(link.path,'context')))errors.push(`self path lacks profile/context layout: ${link.path}`)
      if(link.access!=='read')errors.push('link access must be read')
      if(link.proposals!=='enabled'&&link.proposals!=='disabled')errors.push(`invalid proposals mode: ${link.proposals}`)
      if(link.index!=='local')errors.push(`link index must be local: ${link.index}`)
      const registry=loadLensRegistry(link.path)
      try{resolveLens(registry,link.default_lens)}catch{errors.push(`invalid default lens: ${link.default_lens}`)}
      for(const lens of link.secondary_lenses||[])try{resolveLens(registry,lens)}catch{errors.push(`invalid secondary lens: ${lens}`)}
    }catch(error){errors.push(error.message)}
    proposalRoots.push(join(project,'.holoself','proposals'))
  }
  for(const base of proposalRoots){
    if(!existsSync(base))continue
    const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(entry.name.endsWith('.yaml')){try{readProposal(path)}catch(error){errors.push(`${slash(relative(base,path))}: ${error.message}`)}}}}
    walk(base)
  }
  return errors
}

export function holoselfMcpStatus(projectInput){
  const project=resolve(projectInput),link=readLink(project),health=healthStatus(project,link,{})
  let context='valid',contextError=null
  try{contextData({project,manifest:true,budget:'small',noCache:true,surface:'internal-health'})}catch{context='broken';contextError='Context validation failed closed; run holoself link doctor locally.'}
  return {
    schema_version:1,
    state:health.state,
    project:{name:basename(project),linked:true},
    self:{available:existsSync(link.path),access:link.access},
    link:{default_lens:link.default_lens,secondary_lenses:link.secondary_lenses,proposals:link.proposals,index:link.index},
    context:{state:context,...(contextError?{error:contextError}:{})},
    pending_proposals:listProposalData(project).filter(p=>p.status==='pending').length,
    protocol:{transport:'stdio',authority:'.holoself/link.yaml'}
  }
}
export function holoselfMcpContext(project,options={}){return mcpContextData(resolve(project),options)}
export function holoselfMcpSearch(project,input){
  const linked=resolve(project),link=readLink(linked),registry=loadLensRegistry(link.path),lens=input.lens||link.default_lens,allowedLenses=new Set([link.default_lens,...(link.secondary_lenses||[])]);if(!allowedLenses.has(lens)){const error=new Error(`lens is not granted by this project link: ${lens}`);error.code='LENS_NOT_GRANTED';throw error}const resolution=resolveLens(registry,lens),index=readIndex(linked,true,false,{federated:Boolean(input.federated),spaces:input.spaces,lens})
  let results=searchIndex(index,input.query,lens,registry,resolution,input.temporal||'current',{federated:Boolean(input.federated),spaces:input.spaces,effective_allowed_lenses:allowedLenses})
  return {query:input.query,lens,federated:Boolean(input.federated),results:results.slice(0,input.limit||10)}
}
export function holoselfMcpCreateProposal(project,input){
  const p=createProposal(resolve(project),input),clean={...p};delete clean.source_project_path;return clean
}
export function holoselfMcpPreviewProposal(project,id){
  const preview=proposalPreviewData(resolve(project),id)
  return {proposal_id:preview.proposal.proposal_id,status:preview.proposal.status,changes:preview.changes,preview_hash:preview.preview_hash,requires_human_approval:true,canonical_write_performed:false}
}

async function activateLinkedProject(o,project,link,verb='Activate'){
  if(o.noActivate)return null
  const options={activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||readRuntime(project)?.skillInstallPolicy||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force}
  const {plan}=preflightActivation(project,options);console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters.map(({id,name,file,support,delivery,discovery,tested_product,tested_version,evidence,last_verified,detected})=>({id,name,file,support,delivery,discovery,tested_product,tested_version,evidence,last_verified,detected})),skills:plan.skills,global_skills:plan.globalSkills,writes:plan.writes}},null,2))
  if(!await askConfirm(o,`${verb} Holoself by modifying bounded managed files: ${plan.writes.join(', ')}?`))return null
  const result=activateProject(project,link,options);for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`);return result
}
function healthStatus(project,link,o={}){
  const holoselfDir=join(project,'.holoself')
  const isLegacyMount=existsSync(holoselfDir)&&lstatSync(holoselfDir).isSymbolicLink()
  const activation=activationStatus(project,{skillHome:o.skillHome}),selfExists=existsSync(link.path),snapshot=existsSync(join(project,'.holoself','runtime','context-packet.md')),skillPolicy=activation.runtime?.skillInstallPolicy||'auto',errors=[]
  if(isLegacyMount)errors.push('legacy filesystem junction mount detected; run holoself link setup to migrate to a bounded link')
  if(!selfExists)errors.push('self path missing')
  if(!activation.bootstrap&&!snapshot)errors.push('bootstrap missing')
  if(!activation.adapters.length&&!snapshot)errors.push('no activated adapters')
  for(const a of activation.adapters){if(a.marker!=='active')errors.push(`${a.file}: ${a.marker}`);else if(a.drift)errors.push(`${a.file}: managed block drift`)}
  for(const skill of activation.skillInstallations)if(!skill.installed||skill.kind!=='full-public-skill')errors.push(`${skill.file}: ${skill.kind}`)
  if(skillPolicy==='global'){if(!activation.globalSkillInstallations.length)errors.push('no global public skill installation');for(const skill of activation.globalSkillInstallations)if(!skill.installed||skill.kind!=='full-public-skill')errors.push(`${skill.file}: global ${skill.status}`);for(const file of activation.projectSkillOverrides)errors.push(`${file}: unexpected project skill override`)}else if(skillPolicy!=='none'&&!activation.skillInstallations.length)errors.push('no public skill installation')
  const state=isLegacyMount?'legacy-mount':!selfExists?'broken':activation.active&&errors.length===0?'activated':snapshot&&!activation.runtime?'manual-only':activation.runtime?'degraded':'configured'
  const mode=isLegacyMount?'legacy-mount':snapshot&&!activation.runtime?'snapshot':'metadata-link'
  return {state,mode,isLegacyMount,activation,snapshot,skillPolicy,errors}
}
function commandStatus(){const invoked=slash(resolve(process.argv[1]||'')),packageBin=invoked.includes('/node_modules/');return {available:'not-verified',invocation:packageBin?'package-bin':'source-checkout',path:invoked||null,note:packageBin?'This process used a package bin, but PATH availability was not independently verified.':'Run with node bin/holoself.mjs; source checkout does not prove a holoself command is installed on PATH.'}}
export async function runEcosystem(o){
  const sub=o.args?.[0]
  if(o.command==='instructions'){
    const project=projectPath(o),action=sub||'audit',link=readLink(project)
    if(action==='render'){const content=bootstrapText(link);console.log(o.json?JSON.stringify({schema_version:1,project:slash(project),adapter:o.adapter||'generic',content},null,2):content.trimEnd());return true}
    if(action!=='audit')throw new Error('instructions requires render or audit')
    const result=auditInstructions(project,link,readRuntime(project));console.log(JSON.stringify(result,null,2));if(result.status!=='valid')process.exitCode=1;return true
  }
  if(o.command==='skill'){
    if(o.scope&&o.scope!=='user')throw new Error('skill --scope currently supports only user')
    if(sub==='status'){console.log(JSON.stringify(globalSkillStatus(o),null,2));return true}
    if(sub==='install'){
      const preview=installGlobalSkills({...o,dryRun:true});console.log(JSON.stringify({installation_plan:preview},null,2));if(o.dryRun)return true
      if(!await askConfirm(o,`Install the full public Holoself skill for the user at: ${preview.installations.map(x=>x.path).join(', ')}?`))return true
      console.log(JSON.stringify(installGlobalSkills(o),null,2));return true
    }
    throw new Error('skill requires status or install')
  }
  if(o.command==='lens'){
    const root=resolve(o.root)
    if(!existsSync(root)||lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory())throw new Error(`invalid self root: ${root}`)
    const registry=loadLensRegistry(root)
    if(sub==='list'){console.log(JSON.stringify({root:slash(root),registry_path:slash(registry.registry_path),registry_hash:registry.registry_hash,lenses:registry.lenses.map(lens=>({...lens,sensitivity_access:[...lens.sensitivity_access]}))},null,2));return true}
    if(sub==='show'){const id=o.args?.[1];if(!id)throw new Error('lens show requires <id>');const lens=resolveLens(registry,id);console.log(JSON.stringify({root:slash(root),registry_hash:registry.registry_hash,lens:{...lens,sensitivity_access:[...lens.sensitivity_access]}},null,2));return true}
    if(sub==='validate'){console.log(JSON.stringify({status:'valid',root:slash(root),registry_path:slash(registry.registry_path),registry_hash:registry.registry_hash,builtins:registry.builtins.length,custom_lenses:registry.custom.length},null,2));return true}
    throw new Error('lens requires list, show, or validate')
  }
  if(o.command==='link' && sub==='skill'){
    if(o.args?.[1]!=='migrate-global')throw new Error('link skill requires migrate-global')
    const project=projectPath(o),link=readLink(project),preview=migrateProjectSkillsToGlobal(project,link,{...o,dryRun:true});console.log(JSON.stringify({migration_plan:preview},null,2));if(o.dryRun)return true
    if(!await askConfirm(o,`Migrate Holoself project skills to validated user-level installations and remove managed project copies in ${project}?`))return true
    console.log(JSON.stringify(migrateProjectSkillsToGlobal(project,link,o),null,2));return true
  }
  if(o.command==='migrate' && sub==='policy'){
    const selfRoot=slash(safeRealpath(resolve(o.self||o.root)))
    if(!existsSync(selfRoot)||!isCanonicalSelf(selfRoot)){
      throw new Error(`migrate policy requires a valid canonical self root: ${selfRoot}`)
    }
    if(o.apply){
      const receipt=applyPolicyMigration(selfRoot,o.apply,{confirmNarrowing:o.confirmNarrowing})
      console.log(JSON.stringify({status:'applied',receipt_id:receipt.receipt_id,applied_at:receipt.applied_at,entries:receipt.entries.length,narrowing_confirmed:receipt.narrowing_confirmed},null,2))
      return true
    }
    if(o.revert){
      const receipt=revertPolicyMigration(selfRoot,o.revert,{allowPartial:o.allowPartial})
      console.log(JSON.stringify({status:receipt.status,receipt_id:receipt.receipt_id,reverted_at:receipt.reverted_at,entries:receipt.entries.length},null,2))
      return true
    }
    const plan=planPolicyMigration(selfRoot,{includeLinked:o.includeLinked,dryRun:true})
    console.log(JSON.stringify({
      status:'planned',
      plan_id:plan.plan_id,
      generated_at:plan.generated_at,
      self_root:plan.self_root,
      include_linked:plan.include_linked,
      summary:plan.summary,
      plan_file:slash(join(selfRoot,'.holoself','migrations',`plan-${plan.plan_id}.json`))
    },null,2))
    return true
  }

  if(o.command==='link' && ['add','status','remove','setup','activate','deactivate','repair','doctor','approve','backfill','prune'].includes(sub)){
    const project=projectPath(o)
    if(sub==='add'){
      if(!o.self)throw new Error('link add requires --self <path>')
      if(!existsSync(project))throw new Error(`project not found: ${project}`)
      const selfRoot=slash(safeRealpath(resolve(o.self)))
      if(!existsSync(selfRoot))throw new Error(`self path not found: ${resolve(o.self)}`)
      if(!existsSync(join(selfRoot,'profile'))||!existsSync(join(selfRoot,'context')))throw new Error(`self path lacks profile/context layout: ${resolve(o.self)}`)
      const desired={path:selfRoot,access:'read',proposals:'enabled',index:'local',default_lens:o.lens||'general',secondary_lenses:o.secondaryLenses||[]}
      const desiredErrors=linkSchemaErrors(desired,loadLensRegistry(selfRoot))
      if(desiredErrors.length)throw new Error(desiredErrors.join('; '))
      const collisions=inspectLinkCollisions(project)
      if(collisions.length){
        if(!o.force)throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation to preserve README and replace link configuration`)
        if(!await askConfirm(o,`Replace link configuration while preserving existing project metadata (${collisions.join(', ')})?`))return true
      }
      if(!o.noActivate){
        const {plan}=preflightActivation(project,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force})
        console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters.map(x=>({id:x.id,file:x.file,support:x.support,delivery:x.delivery,discovery:x.discovery,tested_product:x.tested_product,tested_version:x.tested_version,evidence:x.evidence,last_verified:x.last_verified,detected:x.detected})),skills:plan.skills,global_skills:plan.globalSkills,writes:plan.writes}},null,2))
        if(!await askConfirm(o,`Create link and modify bounded managed files: ${plan.writes.join(', ')}?`))return true
      }
      const canonicalProj=canonicalProjectPath(project)
      const pId=canonicalSpaceId(project)
      const allowedLenses=[desired.default_lens,...desired.secondary_lenses].filter(l=>l!=='private')
      if(o.dryRun){
        const link={...desired,project_context:{include:o.projectContext?.include||['**/*.md'],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(o.projectContext?.exclude||[])]}}
        console.log(`[dry-run] linked ${project} -> ${link.path}`)
        return true
      }
      let existingReg=readRegistry(selfRoot)
      let prevEntrySnapshot=existingReg.links.find(l=>l.project_id===pId||l.project_path===canonicalProj)||null
      let resolvedBindingSalt=null
      if(prevEntrySnapshot&&typeof prevEntrySnapshot.binding_salt==='string'&&prevEntrySnapshot.binding_salt.length===32&&!o.force){
        resolvedBindingSalt=prevEntrySnapshot.binding_salt
      }else{
        resolvedBindingSalt=randomBytes(16).toString('hex')
      }
      const existingLink=pathExists(linkPath(project))?readFileSync(linkPath(project)):null
      let link
      try{
        createLinkDirs(project,{preserveReadme:o.force})
        link=writeLink(project,selfRoot,desired.default_lens,desired.secondary_lenses,o.projectContext||{},resolvedBindingSalt)
        await withRegistryLock(selfRoot,()=>{
          const currentReg=readRegistry(selfRoot)
          const nowIso=new Date().toISOString()
          writeRegistry(selfRoot,links=>{
            const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
            const entry={
              project_id:pId,
              project_path:canonicalProj,
              binding_salt:resolvedBindingSalt,
              allowed_lenses:allowedLenses,
              status:'active',
              attested_by:'owner:direct',
              created_at:idx>=0?links[idx].created_at:nowIso,
              updated_at:nowIso,
              revoked_at:null
            }
            if(idx>=0)links[idx]=entry
            else links.push(entry)
            return links
          },currentReg.registry_hash)
        })
        console.log(`[ok] linked ${project} -> ${link.path}`)
        if(!o.noActivate){
          const result=activateProject(project,link,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force})
          for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`)
        }
      }catch(error){
        if(existingLink)atomicWrite(linkPath(project),existingLink)
        else if(pathExists(linkPath(project)))rmSync(linkPath(project),{force:true})
        try{
          await withRegistryLock(selfRoot,()=>{
            const currentReg=readRegistry(selfRoot)
            writeRegistry(selfRoot,links=>{
              const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
              if(idx>=0){
                if(prevEntrySnapshot===null)links.splice(idx,1)
                else links[idx]=prevEntrySnapshot
              }
              return links
            },currentReg.registry_hash)
          })
        }catch{}
        throw error
      }
      return true
    }
    if(sub==='setup'){
      const findings=setupFindings(project)
      console.log(JSON.stringify(findings,null,2))
      let self=o.self
      if(!self&&input.isTTY&&output.isTTY){
        const answer=await askValue('Canonical self path')
        if(answer)self=resolve(answer)
      }
      if(!self){
        if(o.yes)throw new Error('link setup requires --self <path> before confirmation')
        console.log('No changes made. Re-run with --self <path> --yes to create link.')
        return true
      }
      const selfRoot=slash(safeRealpath(resolve(self)))
      if(!existsSync(join(selfRoot,'profile'))||!existsSync(join(selfRoot,'context')))throw new Error(`self path lacks profile/context layout: ${resolve(self)}`)
      const setupRegistry=loadLensRegistry(selfRoot)
      const chosenDefaultLens=o.lens||findings.suggested_lens
      const chosenSecondary=o.secondaryLenses||[]
      const desired={
        path:selfRoot,
        access:'read',
        proposals:'enabled',
        index:'local',
        default_lens:chosenDefaultLens,
        secondary_lenses:chosenSecondary
      }
      const desiredErrors=linkSchemaErrors(desired,setupRegistry)
      if(desiredErrors.length)throw new Error(desiredErrors.join('; '))
      const collisions=inspectLinkCollisions(project)
      if(collisions.length&&!o.force)throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation`)
      if(!o.noActivate){
        const {plan}=preflightActivation(project,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force})
        console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters,skills:plan.skills,global_skills:plan.globalSkills,writes:plan.writes}},null,2))
      }
      if(!await askConfirm(o,`${collisions.length?'Replace link configuration while preserving existing README and artifacts':'Create and activate link'} using ${self} and ${chosenDefaultLens} lens?`)){
        console.log('Cancelled.')
        return true
      }
      if(o.dryRun){
        console.log('[dry-run] setup complete; no files deleted or relocated')
        return true
      }
      const canonicalProj=canonicalProjectPath(project)
      const pId=canonicalSpaceId(project)
      const allowedLenses=[chosenDefaultLens,...chosenSecondary].filter(l=>l!=='private')
      let existingReg=readRegistry(selfRoot)
      let prevEntrySnapshot=existingReg.links.find(l=>l.project_id===pId||l.project_path===canonicalProj)||null
      let resolvedBindingSalt=null
      if(prevEntrySnapshot&&typeof prevEntrySnapshot.binding_salt==='string'&&prevEntrySnapshot.binding_salt.length===32&&!o.force){
        resolvedBindingSalt=prevEntrySnapshot.binding_salt
      }else{
        resolvedBindingSalt=randomBytes(16).toString('hex')
      }
      const existingLink=pathExists(linkPath(project))?readFileSync(linkPath(project)):null
      let link
      try{
        createLinkDirs(project,{preserveReadme:o.force})
        link=writeLink(project,selfRoot,chosenDefaultLens,chosenSecondary,o.projectContext||{},resolvedBindingSalt)
        await withRegistryLock(selfRoot,()=>{
          const currentReg=readRegistry(selfRoot)
          const nowIso=new Date().toISOString()
          writeRegistry(selfRoot,links=>{
            const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
            const entry={
              project_id:pId,
              project_path:canonicalProj,
              binding_salt:resolvedBindingSalt,
              allowed_lenses:allowedLenses,
              status:'active',
              attested_by:'owner:direct',
              created_at:idx>=0?links[idx].created_at:nowIso,
              updated_at:nowIso,
              revoked_at:null
            }
            if(idx>=0)links[idx]=entry
            else links.push(entry)
            return links
          },currentReg.registry_hash)
        })
        if(!o.noActivate){
          const result=activateProject(project,link,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force})
          for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`)
        }
        console.log('[ok] setup complete; no files deleted or relocated')
      }catch(error){
        if(existingLink)atomicWrite(linkPath(project),existingLink)
        else if(pathExists(linkPath(project)))rmSync(linkPath(project),{force:true})
        try{
          await withRegistryLock(selfRoot,()=>{
            const currentReg=readRegistry(selfRoot)
            writeRegistry(selfRoot,links=>{
              const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
              if(idx>=0){
                if(prevEntrySnapshot===null)links.splice(idx,1)
                else links[idx]=prevEntrySnapshot
              }
              return links
            },currentReg.registry_hash)
          })
        }catch{}
        throw error
      }
      return true
    }
    if(sub==='approve'){
      if(!project)throw new Error('link approve requires --project <dir>')
      const canonicalProj=canonicalProjectPath(project)
      const pId=canonicalSpaceId(project)
      let selfRoot=o.self||o.root
      if(!selfRoot){
        const lPath=linkPath(project)
        if(existsSync(lPath)){
          try{
            const l=readLink(project,{tolerant:true})
            selfRoot=l.path
          }catch{}
        }
      }
      if(!selfRoot){
        const envRoot=process.env.HOLOSELF_HOME||join(homedir(),'.holoself')
        if(isCanonicalSelf(process.cwd()))selfRoot=process.cwd()
        else if(isCanonicalSelf(envRoot))selfRoot=envRoot
      }
      if(!selfRoot||!existsSync(selfRoot)||!isCanonicalSelf(selfRoot)){
        throw new Error('link approve requires a valid canonical self root (specify with --self or run from self root)')
      }
      selfRoot=slash(safeRealpath(resolve(selfRoot)))
      const lPath=linkPath(project)
      const hasLink=existsSync(lPath)
      let linkObj=null
      if(hasLink){
        assertContainedPath(project,lPath,'project link file')
        if(lstatSync(lPath).isSymbolicLink())throw new Error(`symlink detected at ${lPath}`)
        try{
          linkObj=readLink(project,{tolerant:true})
        }catch(e){
          throw new Error(`cannot read project link at ${lPath}: ${e.message}`)
        }
      }
      const revokeMode=Boolean(o.revoke)
      await withRegistryLock(selfRoot,()=>{
        const currentReg=readRegistry(selfRoot)
        const nowIso=new Date().toISOString()
        writeRegistry(selfRoot,links=>{
          const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
          if(revokeMode){
            if(idx>=0){
              links[idx]={
                ...links[idx],
                status:'revoked',
                revoked_at:nowIso,
                updated_at:nowIso
              }
            }else{
              links.push({
                project_id:pId,
                project_path:canonicalProj,
                binding_salt:randomBytes(16).toString('hex'),
                allowed_lenses:[],
                status:'revoked',
                attested_by:'owner:direct',
                created_at:nowIso,
                updated_at:nowIso,
                revoked_at:nowIso
              })
            }
            return links
          }
          let allowedLenses=[]
          if(o.lenses&&o.lenses.length){
            allowedLenses=o.lenses.filter(l=>l!=='private')
          }else if(linkObj){
            allowedLenses=[linkObj.default_lens,...(linkObj.secondary_lenses||[])].filter(l=>l!=='private')
          }else{
            allowedLenses=['general']
          }
          let salt=null
          if(idx>=0&&typeof links[idx].binding_salt==='string'&&links[idx].binding_salt.length===32){
            salt=links[idx].binding_salt
          }else if(linkObj&&typeof linkObj.binding_salt==='string'&&linkObj.binding_salt.length===32){
            salt=linkObj.binding_salt
          }else{
            salt=randomBytes(16).toString('hex')
          }
          if(hasLink){
            updateLinkBindingSaltInPlace(lPath,salt)
          }
          const entry={
            project_id:pId,
            project_path:canonicalProj,
            binding_salt:salt,
            allowed_lenses:allowedLenses,
            status:'active',
            attested_by:'owner:direct',
            created_at:idx>=0?links[idx].created_at:nowIso,
            updated_at:nowIso,
            revoked_at:null
          }
          if(idx>=0)links[idx]=entry
          else links.push(entry)
          return links
        },currentReg.registry_hash)
      })
      console.log(`[ok] ${revokeMode?'revoked':'approved'} link for ${project}`)
      return true
    }
    if(sub==='backfill'){
      let selfRoot=o.self||o.root
      if(!selfRoot){
        const envRoot=process.env.HOLOSELF_HOME||join(homedir(),'.holoself')
        if(isCanonicalSelf(process.cwd()))selfRoot=process.cwd()
        else if(isCanonicalSelf(envRoot))selfRoot=envRoot
      }
      if(!selfRoot||!existsSync(selfRoot)||!isCanonicalSelf(selfRoot)){
        throw new Error('link backfill requires a valid canonical self root (specify with --self or run from self root)')
      }
      selfRoot=slash(safeRealpath(resolve(selfRoot)))
      const projectsToProcess=[]
      if(project){
        projectsToProcess.push(project)
      }else if(o.all){
        const reg=readRegistry(selfRoot)
        for(const l of reg.links){
          if(l.project_path&&!projectsToProcess.includes(l.project_path))projectsToProcess.push(l.project_path)
        }
      }else{
        throw new Error('link backfill requires --project <dir> or --all')
      }
      let processedCount=0
      await withRegistryLock(selfRoot,()=>{
        const currentReg=readRegistry(selfRoot)
        const nowIso=new Date().toISOString()
        writeRegistry(selfRoot,links=>{
          for(const proj of projectsToProcess){
            const canonicalProj=canonicalProjectPath(proj)
            const pId=canonicalSpaceId(proj)
            const lPath=linkPath(proj)
            if(!existsSync(lPath))continue
            assertContainedPath(proj,lPath,'project link file')
            if(lstatSync(lPath).isSymbolicLink())throw new Error(`symlink detected at ${lPath}`)
            const linkObj=readLink(proj,{tolerant:true})
            const allowedLenses=(o.lenses&&o.lenses.length?o.lenses:[linkObj.default_lens,...(linkObj.secondary_lenses||[])]).filter(l=>l!=='private')
            let salt=linkObj.binding_salt
            if(!salt||typeof salt!=='string'||salt.length!==32){
              salt=randomBytes(16).toString('hex')
              updateLinkBindingSaltInPlace(lPath,salt)
            }
            const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
            const entry={
              project_id:pId,
              project_path:canonicalProj,
              binding_salt:salt,
              allowed_lenses:allowedLenses,
              status:'active',
              attested_by:'owner:direct',
              created_at:idx>=0?links[idx].created_at:nowIso,
              updated_at:nowIso,
              revoked_at:null
            }
            if(idx>=0)links[idx]=entry
            else links.push(entry)
            processedCount++
          }
          return links
        },currentReg.registry_hash)
      })
      console.log(`[ok] backfilled ${processedCount} project link(s)`)
      return true
    }
    if(sub==='prune'){
      let selfRoot=o.self||o.root
      if(!selfRoot){
        const envRoot=process.env.HOLOSELF_HOME||join(homedir(),'.holoself')
        if(isCanonicalSelf(process.cwd()))selfRoot=process.cwd()
        else if(isCanonicalSelf(envRoot))selfRoot=envRoot
      }
      if(!selfRoot||!existsSync(selfRoot)||!isCanonicalSelf(selfRoot)){
        throw new Error('link prune requires a valid canonical self root (specify with --self or run from self root)')
      }
      selfRoot=slash(safeRealpath(resolve(selfRoot)))
      let prunedCount=0
      await withRegistryLock(selfRoot,()=>{
        const currentReg=readRegistry(selfRoot)
        writeRegistry(selfRoot,links=>{
          const kept=[]
          for(const l of links){
            const pPath=l.project_path
            if(pPath&&existsSync(pPath)&&existsSync(linkPath(pPath))){
              kept.push(l)
            }else{
              prunedCount++
            }
          }
          return kept
        },currentReg.registry_hash)
      })
      console.log(`[ok] pruned ${prunedCount} orphaned link entry/entries from registry`)
      return true
    }
    if(sub==='status'){
      const holoselfDir=join(project,'.holoself')
      if(existsSync(holoselfDir)&&lstatSync(holoselfDir).isSymbolicLink()){
        console.log(JSON.stringify({
          project:slash(project),
          state:'legacy-mount',
          mode:'legacy-mount',
          isLegacyMount:true,
          errors:['legacy filesystem junction mount detected; run holoself link setup to migrate to a bounded link']
        },null,2))
        return true
      }
      let link
      try{link=readLink(project)}catch(error){console.log(JSON.stringify({project:slash(project),state:'broken',errors:[error.message]},null,2));process.exitCode=1;return true}
      const health=healthStatus(project,link,o),{project_context,binding_salt,...selfContext}=link,proposalScan=scanProposalStore(project)
      const selfExists=existsSync(link.path)
      let registryAttested=false
      if(selfExists){
        try{
          const reg=readRegistry(link.path)
          const pId=canonicalSpaceId(project)
          const cPath=canonicalProjectPath(project)
          const entry=reg.links.find(l=>l.project_id===pId||l.project_path===cPath)
          if(entry&&entry.status==='active'&&entry.binding_salt===binding_salt)registryAttested=true
        }catch{}
      }
      const status={
        project:slash(project),
        state:health.state,
        mode:health.mode,
        isLegacyMount:health.isLegacyMount,
        self_context:{...selfContext,path:slash(link.path)},
        project_context,
        binding_salt_present:Boolean(binding_salt&&binding_salt.length===32),
        registry_attested:registryAttested,
        self_exists:selfExists,
        pending_proposals:proposalScan.managed.filter(x=>x.status==='pending').length,
        proposal_health:{managed_pending:proposalScan.managed.filter(x=>x.status==='pending').length,unmanaged:proposalScan.diagnostics.filter(x=>x.code.startsWith('UNMANAGED')).length,invalid:proposalScan.diagnostics.filter(x=>x.severity==='error').length},
        index_exists:existsSync(join(project,'.holoself','catalog','catalog.json')),
        bootstrap_exists:health.activation.bootstrap,
        activated_adapters:health.activation.adapters,
        skill_install_policy:health.skillPolicy,
        skill_installations:health.activation.skillInstallations,
        global_skill_installations:health.activation.globalSkillInstallations,
        project_skill_overrides:health.activation.projectSkillOverrides,
        cli_command:commandStatus(),
        errors:health.errors
      }
      console.log(JSON.stringify(status,null,2))
      if(['broken','degraded'].includes(status.state))process.exitCode=1
      return true
    }
    if(sub==='remove'){
      const path=linkPath(project)
      const canonicalProj=canonicalProjectPath(project)
      const pId=canonicalSpaceId(project)
      if(!pathExists(path)){
        console.log('[ok] no link configuration found')
        let selfRoot=o.self||o.root
        if(selfRoot){
          const cSelf=canonicalProjectPath(selfRoot)
          if(existsSync(cSelf)&&isCanonicalSelf(cSelf)){
            const regPath=registryFilePath(cSelf)
            if(existsSync(regPath)){
              await withRegistryLock(cSelf,()=>{
                const currentReg=readRegistry(cSelf)
                const nowIso=new Date().toISOString()
                writeRegistry(cSelf,links=>{
                  const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
                  if(idx>=0)links[idx]={...links[idx],status:'revoked',revoked_at:nowIso,updated_at:nowIso}
                  return links
                },currentReg.registry_hash)
              })
            }
          }
        }
        return true
      }
      if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error(`${path} is not a regular link configuration; refusing to remove`)
      if(!await askConfirm(o,`Remove managed activation and link configuration ${path}?`)){
        console.log('Cancelled.')
        return true
      }
      let parsedRaw=null
      try{parsedRaw=parseYaml(readFileSync(path,'utf8'))}catch(e){throw new Error(`cannot parse link at ${path}: ${e.message}`)}
      let selfRoot=o.self||parsedRaw?.self_context?.path||(o.rootExplicit?o.root:null)
      let selfReachable=false
      if(selfRoot){
        try{
          const cSelf=canonicalProjectPath(selfRoot)
          if(existsSync(cSelf)&&!lstatSync(cSelf).isSymbolicLink()&&isCanonicalSelf(cSelf)){
            selfRoot=cSelf
            const regPath=registryFilePath(selfRoot)
            if(existsSync(regPath)&&!lstatSync(regPath).isSymbolicLink())selfReachable=true
          }
        }catch{}
      }
      if(!selfReachable){
        if(!o.force){
          const err=new Error(`sovereign self at ${selfRoot||'(unspecified)'} is unreachable or invalid; refusing removal without sovereign revocation`)
          err.code='SOVEREIGN_SELF_UNREACHABLE'
          throw err
        }
        console.warn(`Warning: sovereign self at ${selfRoot||'(unspecified)'} is unreachable or invalid; local link configuration and adapters removed, but sovereign registry was NOT updated. Run 'holoself link approve --project <dir> --revoke' from self root to complete sovereign revocation.`)
      }else{
        await withRegistryLock(selfRoot,()=>{
          const currentReg=readRegistry(selfRoot)
          const nowIso=new Date().toISOString()
          writeRegistry(selfRoot,links=>{
            const idx=links.findIndex(l=>l.project_id===pId||l.project_path===canonicalProj)
            if(idx>=0)links[idx]={...links[idx],status:'revoked',revoked_at:nowIso,updated_at:nowIso}
            return links
          },currentReg.registry_hash)
        })
      }
      deactivateProject(project,{dryRun:o.dryRun})
      if(!o.dryRun)rmSync(path)
      console.log(`[ok] removed ${path}; indexes, reports, and proposals preserved`)
      return true
    }
    if(['activate'].includes(sub)){const link=readLink(project);await activateLinkedProject(o,project,link,'Activate');return true}
    if(sub==='repair'){
      let link
      try{link=readLink(project,{tolerant:true})}catch(err){
        console.log(JSON.stringify({healthy:false,error:err.message},null,2))
        return true
      }
      const selfExists=existsSync(link.path)
      let schemaErrors=[]
      if(selfExists){
        const reg=loadLensRegistry(link.path)
        schemaErrors=linkSchemaErrors(link,reg)
      }
      if(schemaErrors.length){
        console.log(JSON.stringify({healthy:false,state:'broken',errors:schemaErrors},null,2))
        return true
      }
      await activateLinkedProject(o,project,link,'Repair')
      return true
    }
    if(sub==='deactivate'){if(!await askConfirm(o,'Remove bounded Holoself activation sections while preserving link metadata?'))return true;const results=deactivateProject(project,{dryRun:o.dryRun});for(const item of results)console.log(` - ${item.file}: ${item.result}`);return true}
    if(sub==='doctor'){const link=readLink(project),health=healthStatus(project,link,o),projectHealthy=health.activation.skillInstallations.length&&health.activation.skillInstallations.every(x=>x.kind==='full-public-skill'&&x.installed),globalHealthy=health.activation.globalSkillInstallations.length&&health.activation.globalSkillInstallations.every(x=>x.kind==='full-public-skill'&&x.installed),skillHealthy=health.skillPolicy==='none'||(health.skillPolicy==='global'?globalHealthy:projectHealthy),checks={link:'valid',self_root:existsSync(link.path)?'valid':'missing',lens:loadLensRegistry(link.path).byId.has(link.default_lens)?'valid':'invalid',bootstrap:health.activation.bootstrap?'valid':'missing',activation:health.activation.active?'valid':'degraded',skill_installation:health.skillPolicy==='none'?'disabled':health.skillPolicy==='global'?(globalHealthy?'global-full-public-skill':'degraded'):skillHealthy?'full-public-skill':'degraded',project_skill_overrides:health.skillPolicy==='global'?(health.activation.projectSkillOverrides.length?'present':'absent'):'not-applicable',cli_command:commandStatus(),context:'unknown'};try{const data=contextData({...o,project});checks.context=data.sources.length?'valid':'empty';checks.warnings=data.warnings}catch(error){checks.context='broken';checks.context_error=error.message}const ok=!Object.values(checks).some(x=>['missing','invalid','degraded','broken','present'].includes(x));console.log(JSON.stringify({state:ok?'activated':'degraded',checks},null,2));if(!ok)process.exitCode=1;return true}
    const findings=setupFindings(project);console.log(JSON.stringify(findings,null,2));let self=o.self;if(!self&&input.isTTY&&output.isTTY){const answer=await askValue('Canonical self path');if(answer)self=resolve(answer)}if(!self){if(o.yes)throw new Error('link setup requires --self <path> before confirmation');console.log('No changes made. Re-run with --self <path> --yes to create link.');return true}if(!existsSync(join(self,'profile'))||!existsSync(join(self,'context')))throw new Error(`self path lacks profile/context layout: ${resolve(self)}`);const setupRegistry=loadLensRegistry(resolve(self));resolveLens(setupRegistry,o.lens||findings.suggested_lens);for(const lens of o.secondaryLenses||[])resolveLens(setupRegistry,lens);const collisions=inspectLinkCollisions(project);if(collisions.length&&!o.force)throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation`);if(!o.noActivate){const {plan}=preflightActivation(project,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force});console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters,skills:plan.skills,global_skills:plan.globalSkills,writes:plan.writes}},null,2))}if(!await askConfirm(o,`${collisions.length?'Replace link configuration while preserving existing README and artifacts':'Create and activate link'} using ${self} and ${o.lens||findings.suggested_lens} lens?`)){console.log('Cancelled.');return true}let link;if(o.dryRun)link={path:resolve(self),access:'read',proposals:'enabled',index:'local',default_lens:o.lens||findings.suggested_lens,secondary_lenses:o.secondaryLenses||[],project_context:{include:o.projectContext?.include||['**/*.md'],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(o.projectContext?.exclude||[])]}};else{createLinkDirs(project,{preserveReadme:o.force});link=writeLink(project,self,o.lens||findings.suggested_lens,o.secondaryLenses||[],o.projectContext||{})}if(!o.noActivate){const result=activateProject(project,link,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force});for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`)}console.log(`${o.dryRun?'[dry-run] ':'[ok] '}setup complete; no files deleted or relocated`);return true
  }
  if(o.command==='context'){
    const data=contextData(o),format=o.json?'json':(o.format||'packet'),packetAdapter=o.restrictedHost?'restricted-host':(o.adapter||format),content=format==='json'?JSON.stringify(data,null,2)+'\n':packetFormat(data,packetAdapter);if(o.output||o.snapshot){const project=projectPath(o),out=o.output||join(project,'.holoself','runtime','context-packet.md');if(!o.yes)throw new Error(`Writing context snapshot requires --yes: ${out}`);assertContainedPath(project,out,'snapshot output');atomicWrite(out,content);console.log(JSON.stringify({status:'written',mode:'snapshot',path:slash(out),lens:data.lens,sources:data.sources.length,packet_metadata:data.packet_metadata,validation:data.validation,warnings:data.warnings},null,2))}else console.log(content.trimEnd());return true
  }
  if(o.command==='analyze'){
    if(!['overlap','conflicts','stale','all'].includes(sub))throw new Error('analyze requires overlap, conflicts, stale, or all')
    const project=projectPath(o),report=analysis(project);report.analysis=sub;report.findings=filterAnalysis(report,sub);const out=join(project,'.holoself','reports',`${sub}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);ensureDir(dirname(out));atomicWrite(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,report_path:slash(out)},null,2));return true
  }
  if(o.command==='propose'){
    const project=projectPath(o),link=readLink(project);if(link.proposals!=='enabled')throw new Error('proposals are not enabled for link')
    const candidates=analysis(project).findings.filter(x=>x.classification==='Candidate for self');const claim=o.claim || (candidates[0]?`Review reusable context from ${candidates[0].project_file}`:null);if(!claim)throw new Error('propose requires --claim <text> when no candidate is detected')
    const sourceFiles=o.sourceFiles?.length?o.sourceFiles:(candidates[0]?[candidates[0].project_file]:[]);if(!sourceFiles.length)throw new Error('propose requires --source-file <path>')
    const p=createProposal(project,{claim,source_files:sourceFiles,target:o.targetFile,proposal_type:o.proposalType,evidence:o.evidence,confidence:o.confidence,visibility:o.visibility});console.log(JSON.stringify(p,null,2));return true
  }
  if(o.command==='proposals'){
    const project=projectPath(o),action=sub;if(action==='list'){console.log(JSON.stringify(listProposalData(project).map(({_path,...p})=>p),null,2));return true}if(action==='audit'){const scan=scanProposalStore(project);console.log(JSON.stringify({managed:scan.managed.map(({_path,...p})=>p),diagnostics:scan.diagnostics},null,2));if(scan.diagnostics.some(x=>x.severity==='error'))process.exitCode=1;return true}
    const id=o.args[1];if(!id)throw new Error(`proposals ${action} requires <id>`);const p=findProposal(project,id)
    if(action==='show'){console.log(proposalText(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='_path'))));return true}
    if(!['approve','reject','defer','supersede'].includes(action))throw new Error('proposals requires list, audit, show, approve, reject, defer, or supersede')
    if(p.status!=='pending')throw new Error(`proposal is ${p.status}, expected pending`)
    if(action==='approve'){
      const prepared=proposalPreviewData(project,p.proposal_id),{link,grouped}=prepared,changes=proposalChanges(p),archive=join(link.path,'proposals','approved',`${p.proposal_id}.yaml`);if(existsSync(archive))throw new Error(`proposal archive collision: ${archive}`);const preErrors=ecosystemValidationErrors(link.path,project);if(preErrors.length)throw new Error(`pre-approval validation failed: ${preErrors.join('; ')}`)
      const previews=prepared.changes,previewHash=prepared.preview_hash;console.log(o.json?JSON.stringify({proposal_id:p.proposal_id,changes:previews,preview_hash:previewHash},null,2):`Affected files: ${[...grouped.keys()].join(', ')}\nPreview hash: ${previewHash}\n--- proposed diff ---\n${previews.map(x=>`--- ${x.change_id}: ${x.target} ---\n+${x.preview.replaceAll('\n','\n+')}`).join('\n')}`)
      if(o.digest&&o.digest!==previewHash){const error=new Error('proposal preview is stale');error.code='STALE_PREVIEW';throw error}if(!await askConfirm(o,'Approve proposal and apply grouped canonical self changes?')){console.log('Cancelled.');return true}
      const proposalBefore=readFileSync(p._path),receipt=join(link.path,'proposals','receipts',`${p.proposal_id}-approved.json`),commitTime=new Date().toISOString(),appliedChanges=previews.map(item=>({...item,after_sha256:hash(grouped.get(safeTarget(link.path,item.target)).after.replaceAll('<commit-time>',commitTime))}));try{for(const item of grouped.values())atomicWrite(item.target,item.after.replaceAll('<commit-time>',commitTime));stateProposal(project,p,'approved',{preview_sha256:previewHash,applied_changes:appliedChanges.map(({change_id,target,before_sha256,after_sha256})=>({change_id,target,before_sha256,after_sha256}))});const errors=ecosystemValidationErrors(link.path,project);if(errors.length)throw new Error(`post-approval validation failed: ${errors.join('; ')}`)}catch(error){for(const item of grouped.values())atomicWrite(item.target,item.before);atomicWrite(p._path,proposalBefore);if(existsSync(archive))rmSync(archive,{force:true});if(existsSync(receipt))rmSync(receipt,{force:true});throw error}console.log(`[ok] approved ${p.proposal_id}; ${changes.length} change(s), validation passed`);return true
    }
    if(!await askConfirm(o,`${action==='reject'?'Reject':action==='supersede'?'Supersede':'Defer'} proposal ${p.proposal_id}?`)){console.log('Cancelled.');return true}const state=action==='reject'?'rejected':action==='supersede'?'superseded':'deferred';stateProposal(project,p,state);console.log(`[ok] ${state} ${p.proposal_id}`);return true
  }
  if(o.command==='index'){
    const project=projectPath(o)
    const link=readLink(project),registry=loadLensRegistry(link.path)
    const catPath=join(project,'.holoself','catalog','catalog.json')
    if(sub==='status'){
      if(!existsSync(catPath)){
        console.log(JSON.stringify({status:'missing',path:slash(catPath)},null,2))
        return true
      }
      let projectCatalog
      try{projectCatalog=JSON.parse(readFileSync(catPath,'utf8'))}catch{throw new Error(`catalog is invalid JSON: ${catPath}`)}
      const val=validateCatalogSchema(projectCatalog)
      if(!val.valid)throw new Error(`catalog schema is stale or invalid: ${catPath}`)
      const selfFiles=canonicalFiles(link.path,{includeHistory:true})
      const projectFiles=projectMarkdownFiles(project,link)
      const expectedProjectContextHash=hash(canonicalJson(link.project_context))
      const selfCatPath=join(link.path,'.holoself','catalog','catalog.json')
      let selfCatalog=null
      if(existsSync(selfCatPath)){try{selfCatalog=JSON.parse(readFileSync(selfCatPath,'utf8'))}catch{}}
      const isSelfFresh=isPartitionFresh(selfCatalog,link.path,selfFiles,registry,null,'self')
      const isProjectFresh=isPartitionFresh(projectCatalog,project,projectFiles,registry,expectedProjectContextHash,basename(project))
      const fresh=Boolean(isSelfFresh&&isProjectFresh)
      const input_state_hash=hash(canonicalJson({
        self:(selfCatalog?.sources||[]).map(s=>[s.file,s.source_text_hash]),
        project:projectCatalog.sources.map(s=>[s.file,s.source_text_hash])
      }))
      console.log(JSON.stringify({
        status:fresh?'ready':'stale',
        fresh,
        path:slash(catPath),
        schema_version:projectCatalog.schema_version,
        privacy_policy_version:4,
        lens_registry_hash:registry.registry_hash,
        engine:'deterministic-json',
        entries:projectCatalog.sources.length+(selfCatalog?.sources?.length||0),
        generated_at:projectCatalog.generated_at,
        input_state_hash,
        skipped_secret_files:0,
        build_assertions:{status:'passed',checks:['include-policy','exclude-policy','required-includes','forbidden-excludes','secret-pattern-scan'],included_project_files:projectCatalog.sources.length}
      },null,2))
      return true
    }
    const rebuild=sub==='rebuild'
    const index=buildIndex(project,o.changed&&!rebuild)
    console.log(JSON.stringify({
      status:'ready',
      fresh:true,
      schema_version:index.schema_version,
      privacy_policy_version:index.privacy_policy_version,
      lens_registry_hash:index.lens_registry_hash,
      engine:index.engine,
      entries:index.entries.length,
      generated_at:index.generated_at,
      input_state_hash:index.input_state_hash,
      skipped_secret_files:index.skipped_secret_files,
      build_assertions:index.build_assertions
    },null,2))
    return true
  }
  if(o.command==='search'){
    const query=o.args.join(' ');if(!query)throw new Error('search requires a query')
    const project=projectPath(o),link=readLink(project),registry=loadLensRegistry(link.path),lens=o.lens||link.default_lens||'general',resolution=resolveLens(registry,lens)
    const index=readIndex(project,true,false,{federated:Boolean(o.federated),spaces:o.spaces,lens})
    let results=searchIndex(index,query,lens,registry,resolution,o.temporal||'current',{federated:Boolean(o.federated),spaces:o.spaces})
    console.log(JSON.stringify({query,federated:Boolean(o.federated),results},null,2));return true
  }
  return false
}

export {
  ensureCatalog,
  ensureCatalogPartition,
  ensureContribPartition,
  buildCatalogSource,
  catalogCandidateRecords,
  readIndex,
  buildIndex,
  searchIndex,
  validateCatalogSchema,
  validateDecisionCacheSchema,
  contextData
}
