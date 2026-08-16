import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { activateProject, activationPlan, activationStatus, deactivateProject, preflightActivation } from './adapters.mjs'

export const LENSES = ['general','career','publishing','technical','leadership','interview','private']
export const VISIBILITIES = ['private','linked-projects','career','publishing','public-safe']
export const DISCLOSURES = ['internal-only','review-required','publish-approved']
export const SENSITIVITIES = ['public','personal','compensation-confidential','third-party-personal','recruiter-confidential','employer-confidential','application-private','restricted','none']
export const DOCUMENT_ROLES = ['policy','evidence','content']
const SENSITIVITY_LENSES={
  'compensation-confidential':['career','interview','private'],
  'third-party-personal':['leadership','private'],
  'recruiter-confidential':['career','interview','private'],
  'employer-confidential':['career','technical','leadership','interview','private'],
  'application-private':['career','interview','private'],
  restricted:['private']
}
export const PROPOSAL_TYPES = ['new_fact','fact_update','fact_correction','new_story','new_preference','new_decision','privacy_warning','conflict_resolution']
export const PROPOSAL_STATES = ['pending','approved','rejected','deferred','superseded']
const SKIP_DIRS = new Set(['.git','node_modules','.holoself','proposals','exports','.agents','.claude','.codex','.pi','.agy','.gemini','.cursor','.github','skills','Generated','generated'])
const DEFAULT_PROJECT_EXCLUDES=['.git/**','node_modules/**','.holoself/**','.agents/**','.claude/**','.codex/**','.pi/**','.agy/**','.gemini/**','.cursor/**','.github/**','skills/**','**/Generated/**','**/generated/**']
const SECRET_RE = /(-----BEGIN [A-Z ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:api[_-]?key|client[_-]?secret|password|passwd|secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?)\s*[:=]\s*["']?(?:bearer\s+)?[^\s"']{8,}|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|sk-(?:proj-)?|npm_)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s]+:[^\s]+@|(?:sig|signature|se|sp|sv)=[^&\s]{8,}(?:&|$))/i
const SECRET_FILE_RE = /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|password|private[-_]?key|access[-_]?token)[^/]*|[^/]+\.(?:pem|p12|pfx|key))(?:\.md)?$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_PREFIX_RE = /^[0-9a-f-]{8,36}$/i
const COMPENSATION_RE = /(?:\b(?:compensation|salary|base\s+pay|pay\s+(?:band|range|package)|remuneration|annual\s+pay|total\s+comp|bonus|equity|stock\s+options?|negotiat(?:e|ion))\b|[$€£]\s?\d[\d,.]*(?:\s?(?:k|m|usd|eur|gbp))?)/i

function pathExists(path){try{lstatSync(path);return true}catch{return false}}
function ensureDir(path){ mkdirSync(path,{recursive:true}) }
function atomicWrite(path, content){
  ensureDir(dirname(path)); const temp=`${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp,content,'utf8'); renameSync(temp,path)
}
function slash(path){ return path.replaceAll('\\','/') }
function hash(text){ return createHash('sha256').update(text).digest('hex') }
function projectPath(o){ return resolve(o.project || o.target || process.cwd()) }
function assertContainedPath(root,target,label='path'){
  const boundary=resolve(root),path=resolve(target),rel=relative(boundary,path);if(rel.startsWith('..')||isAbsolute(rel))throw new Error(`${label} escapes root`)
  let current=path;while(current!==boundary){if(pathExists(current)&&lstatSync(current).isSymbolicLink())throw new Error(`${label} traverses symlink: ${current}`);current=dirname(current)}return path
}
function linkPath(project){ return join(project,'.holoself','link.yaml') }
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
function linkSchemaErrors(link){
  const errors=[],allowedKeys=new Set(['path','access','proposals','index','default_lens','secondary_lenses'])
  if(!link||Array.isArray(link)||typeof link!=='object')return ['self_context must be a mapping']
  for(const key of Object.keys(link))if(!allowedKeys.has(key))errors.push(`unknown self_context field: ${key}`)
  if(typeof link.path!=='string'||!link.path.trim())errors.push('self_context.path must be a non-empty string')
  if(link.access!=='read')errors.push('self_context.access must be read')
  if(!['enabled','disabled'].includes(link.proposals))errors.push('self_context.proposals must be enabled or disabled')
  if(link.index!=='local')errors.push('self_context.index must be local')
  if(!LENSES.includes(link.default_lens))errors.push(`invalid default lens: ${link.default_lens}`)
  if(link.secondary_lenses!==undefined){
    if(!Array.isArray(link.secondary_lenses)||link.secondary_lenses.some(x=>typeof x!=='string'||!LENSES.includes(x)))errors.push('secondary_lenses must contain only known lenses')
    else if(new Set(link.secondary_lenses).size!==link.secondary_lenses.length)errors.push('secondary_lenses must contain unique lenses')
  }
  return errors
}
function projectContextErrors(value){const errors=[];if(value===undefined)return errors;if(!value||Array.isArray(value)||typeof value!=='object')return ['project_context must be a mapping'];for(const key of Object.keys(value))if(!['include','exclude','assert_include','assert_exclude'].includes(key))errors.push(`unknown project_context field: ${key}`);for(const key of ['include','exclude','assert_include','assert_exclude'])if(value[key]!==undefined&&(!Array.isArray(value[key])||value[key].some(x=>typeof x!=='string'||!x.trim())))errors.push(`project_context.${key} must be a string array`);return errors}
function readLink(project){
  const path=assertContainedPath(project,linkPath(project),'link configuration');if(!pathExists(path))throw new Error(`link configuration missing: ${path}`)
  if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error(`link configuration is not a regular file: ${path}`)
  let parsed;try{parsed=parseYaml(readFileSync(path,'utf8'))}catch(error){throw new Error(`malformed link configuration ${path}: ${error.message}`)}
  if(!Object.hasOwn(parsed,'self_context'))throw new Error(`malformed link configuration ${path}: self_context mapping missing`)
  for(const key of Object.keys(parsed))if(!['self_context','project_context'].includes(key))throw new Error(`malformed link configuration ${path}: unknown root field ${key}`)
  const errors=[...linkSchemaErrors(parsed.self_context),...projectContextErrors(parsed.project_context)];if(errors.length)throw new Error(`invalid link configuration ${path}: ${errors.join('; ')}`)
  return {...parsed.self_context,path:resolve(project,parsed.self_context.path),secondary_lenses:[...(parsed.self_context.secondary_lenses||[])],project_context:{include:parsed.project_context?.include||['**/*.md'],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(parsed.project_context?.exclude||[])],assert_include:parsed.project_context?.assert_include||[],assert_exclude:parsed.project_context?.assert_exclude||[]}}
}
function writeLink(project,self,lens='general',secondary=[],projectContext={}){
  const data={self_context:{path:slash(resolve(self)),access:'read',proposals:'enabled',index:'local',default_lens:lens,secondary_lenses:secondary},project_context:{include:projectContext.include||['**/*.md'],exclude:projectContext.exclude||DEFAULT_PROJECT_EXCLUDES,assert_include:projectContext.assert_include||[],assert_exclude:projectContext.assert_exclude||[]}},errors=[...linkSchemaErrors(data.self_context),...projectContextErrors(data.project_context)];if(errors.length)throw new Error(errors.join('; '))
  atomicWrite(linkPath(project),yamlObject(data));return {...data.self_context,project_context:data.project_context}
}
function managedReadme(){ return `# Linked Holoself context\n\nProject owns artifacts. Linked self owns approved reusable knowledge.\n\n- \`link.yaml\` grants read access and proposal delivery; it never copies self files.\n- \`index/\` is local, rebuildable acceleration data. Markdown remains source of truth.\n- \`proposals/\` and \`reports/\` are review artifacts.\n` }
function inspectLinkCollisions(project){
  const root=join(project,'.holoself'),collisions=[]
  if(pathExists(root)){
    const stat=lstatSync(root);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`${root} is not a regular metadata directory; refusing to replace`)
    const readme=join(root,'README.md');if(pathExists(readme)){const rs=lstatSync(readme);if(rs.isSymbolicLink()||!rs.isFile())throw new Error(`${readme} is not a regular file; refusing to replace`);if(readFileSync(readme,'utf8')!==managedReadme())collisions.push(readme)}
    const link=linkPath(project);if(pathExists(link))collisions.push(link)
    for(const dir of ['index','proposals','reports']){const path=join(root,dir);if(pathExists(path)&&(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory()))throw new Error(`${path} is not a regular directory; refusing to replace`)}
  }
  return collisions
}
function createLinkDirs(project,{preserveReadme=false}={}){
  const root=join(project,'.holoself');ensureDir(root)
  for(const dir of ['index','proposals','reports'])ensureDir(join(root,dir))
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
const PRIVACY_FIELDS=new Set(['access_lenses','disclosure','sensitivity','document_role','task_include','task_exclude','visibility','public_safe','confidence','exclude_lenses','field_visibility'])
function privacyValueValid(key,value){
  if(key==='access_lenses')return Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==='string'&&LENSES.includes(item))&&new Set(value).size===value.length
  if(key==='disclosure')return typeof value==='string'&&DISCLOSURES.includes(value)
  if(key==='sensitivity')return typeof value==='string'&&SENSITIVITIES.includes(value)
  if(key==='document_role')return typeof value==='string'&&DOCUMENT_ROLES.includes(value)
  if(key==='task_include'||key==='task_exclude')return Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==='string'&&Boolean(item.trim()))&&new Set(value).size===value.length
  if(key==='visibility')return typeof value==='string'&&VISIBILITIES.includes(value)
  if(key==='public_safe')return typeof value==='boolean'
  if(key==='confidence')return typeof value==='string'&&Boolean(value.trim())
  if(key==='exclude_lenses')return Array.isArray(value)&&value.every(item=>typeof item==='string'&&LENSES.includes(item))
  if(key==='field_visibility')return value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(item=>typeof item==='string'&&VISIBILITIES.includes(item))
  return true
}
function privacyMetadataErrors(metadata){const errors=[];for(const key of PRIVACY_FIELDS)if(Object.hasOwn(metadata,key)&&!privacyValueValid(key,metadata[key])){const value=typeof metadata[key]==='string'?metadata[key]:JSON.stringify(metadata[key]);errors.push(key==='visibility'?`invalid visibility ${value}`:`invalid ${key} value ${value}`)}return errors}
function canonicalPrivacyMetadataErrors(metadata){
  const errors=privacyMetadataErrors(metadata)
  if(!Object.hasOwn(metadata,'access_lenses')&&!Object.hasOwn(metadata,'visibility'))errors.push('canonical privacy metadata missing access_lenses or legacy visibility')
  if(Object.hasOwn(metadata,'access_lenses'))for(const key of ['disclosure','sensitivity','document_role']){
    if(!Object.hasOwn(metadata,key))errors.push(`canonical metadata missing ${key}`)
    else if(!privacyValueValid(key,metadata[key])&&!errors.some(error=>error.startsWith(`invalid ${key} `)))errors.push(`invalid ${key} value`)
  }
  if(metadata.visibility==='public-safe'&&metadata.public_safe===false)errors.push('conflicting legacy privacy metadata: visibility public-safe with public_safe false')
  return [...new Set(errors)]
}
function restrictPrivacyMetadata(metadata){metadata.access_lenses=['private'];metadata.disclosure='internal-only';metadata.document_role='content';metadata.visibility='private';metadata.public_safe=false;metadata.sensitivity='restricted';return metadata}
function salvagePrivacyFrontmatter(raw,{forcePrivate=false}={}){
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
      try{const value=parseScalar(scalar);if(privacyValueValid(key,value))metadata[key]=value;else malformed=true}catch{malformed=true}
      continue
    }
    if(!block)continue
    if(['exclude_lenses','access_lenses','task_include','task_exclude'].includes(block.key)){
      const item=trimmed.match(/^-\s+(.+)$/);if(!item){malformed=true;continue}
      try{const value=parseScalar(item[1]),valid=typeof value==='string'&&(block.key.startsWith('task_')?Boolean(value.trim()):LENSES.includes(value));if(valid){metadata[block.key].push(value);block.items++}else malformed=true}catch{malformed=true}
    }else{
      const item=trimmed.match(/^([^:#][^:]*):\s*(.+)$/);if(!item){malformed=true;continue}
      try{const value=parseScalar(item[2]);if(typeof value==='string'&&VISIBILITIES.includes(value)){metadata.field_visibility[item[1].trim()]=value;block.items++}else malformed=true}catch{malformed=true}
    }
  }
  finishBlock();if(forcePrivate||malformed||privacyMetadataErrors(metadata).length)restrictPrivacyMetadata(metadata);return metadata
}
function frontmatter(text,{tolerant=false}={}){
  if(!text.startsWith('---\n') && !text.startsWith('---\r\n')) return {metadata:{},body:text,warnings:[]}
  const end=text.indexOf('\n---',4)
  if(end<0){if(!tolerant)throw new Error('unclosed frontmatter');return {metadata:salvagePrivacyFrontmatter(text.slice(4),{forcePrivate:true}),body:text.slice(4),warnings:['unclosed project frontmatter restricted to private']}}
  const raw=text.slice(4,end),body=text.slice(end+4).replace(/^\r?\n/,'');let metadata
  try{metadata=parseYaml(raw)}catch(error){if(!tolerant)throw error;metadata=salvagePrivacyFrontmatter(raw);if(!Object.keys(metadata).length)restrictPrivacyMetadata(metadata);return {metadata,body,warnings:[`unsupported project frontmatter parsed conservatively: ${error.message}`]}}
  const privacyErrors=privacyMetadataErrors(metadata)
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
function allowed(meta,lens,adapter='generic',task=null){
  if(!accessLenses(meta).includes(lens))return false
  const excluded=Array.isArray(meta.exclude_lenses)?meta.exclude_lenses:[]
  if(excluded.includes(lens)||!taskAllowed(meta,task))return false
  const sensitivity=meta.sensitivity||'';if(documentRole(meta)!=='policy'&&SENSITIVITY_LENSES[sensitivity]&&!SENSITIVITY_LENSES[sensitivity].includes(lens))return false
  if((adapter==='obsidian-public'||adapter==='public'||adapter==='restricted-host')&&!publicationAllowed(meta))return false
  return true
}
function tokenize(text){ return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]) }
function relevance(text,task){
  if(!task) return 0; const wanted=tokenize(task); const got=tokenize(text); let score=0
  for(const token of wanted) if(got.has(token)) score++
  return score
}
function canonicalFiles(root){
  let files=[...markdownFiles(join(root,'profile')),...markdownFiles(join(root,'context'))]
  const current=join(root,'topics','.current');if(existsSync(current)){const topic=readFileSync(current,'utf8').trim();if(topic){const path=join(root,'topics',topic.endsWith('.md')?topic:`${topic}.md`);if(existsSync(path))files.push(path)}}
  return [...new Set(files)].sort()
}
function filterClaimVisibility(body,lens,source,restrictions){
  return body.replace(/<!-- holoself-claim visibility=([a-z-]+) -->[\s\S]*?<!-- \/holoself-claim -->/g,(block,claimVisibility)=>{if(allowed({visibility:claimVisibility},lens,'generic'))return block;restrictions.push({source,reason:`claim visibility ${claimVisibility} excluded by ${lens} lens`});return ''})
}
function filterFieldVisibility(body,metadata,lens,source,restrictions){
  const configured=metadata.field_visibility&&typeof metadata.field_visibility==='object'&&!Array.isArray(metadata.field_visibility)?metadata.field_visibility:{}
  const policies={...configured};if(lens==='publishing')for(const field of ['compensation','salary','base pay','pay range','bonus','equity','negotiation'])if(!policies[field])policies[field]='private'
  let blockedHeading=false,reportedCompensation=false
  return body.split(/\r?\n/).filter(line=>{
    const heading=line.match(/^#{1,6}\s+(.+)$/)
    if(heading){const key=heading[1].trim().toLowerCase(),rule=Object.entries(policies).find(([field])=>key.includes(field.toLowerCase()));blockedHeading=Boolean(rule&&!allowed({visibility:rule[1]},lens,'generic'));if(lens==='publishing'&&COMPENSATION_RE.test(key))blockedHeading=true;if(blockedHeading)restrictions.push({source,reason:`field ${rule?.[0]||'compensation'} excluded by ${lens} lens`});return !blockedHeading}
    if(blockedHeading)return false
    const field=line.match(/^\s*[-*]?\s*([^:]{2,40}):\s*(.+)$/),rule=field&&Object.entries(policies).find(([name])=>field[1].trim().toLowerCase()===name.toLowerCase())
    if(rule&&!allowed({visibility:rule[1]},lens,'generic')){restrictions.push({source,reason:`field ${rule[0]} excluded by ${lens} lens`});return false}
    if(lens==='publishing'&&COMPENSATION_RE.test(line)){if(!reportedCompensation){restrictions.push({source,reason:'compensation content excluded by publishing lens'});reportedCompensation=true}return false}
    return true
  }).join('\n')
}
function sourceRecords(root,kind,lens,task,adapter,link=null){
  const records=[]; const restrictions=[],warnings=[]
  let files
  if(kind==='self')files=canonicalFiles(root)
  else files=projectMarkdownFiles(root,link)
  for(const path of files){
    const text=readFileSync(path,'utf8'),rel=slash(relative(root,path));let parsed
    try{parsed=frontmatter(text,{tolerant:kind==='project'})}catch(error){restrictions.push({source:rel,reason:'invalid canonical privacy metadata; excluded fail-closed'});warnings.push(`${rel}: ${error.message}`);continue}
    const {metadata,body,warnings:documentWarnings}=parsed;for(const warning of documentWarnings)warnings.push(`${rel}: ${warning}`)
    if(secretFile(path,root)||SECRET_RE.test(text)||['secret','credential','credentials'].includes(metadata.sensitivity)){ restrictions.push({source:rel,reason:'secret-like content excluded'}); continue }
    if(kind==='self'){
      const metadataErrors=canonicalPrivacyMetadataErrors(metadata)
      if(metadataErrors.length){restrictions.push({source:rel,reason:'invalid canonical privacy metadata; excluded fail-closed'});warnings.push(`${rel}: ${metadataErrors.join('; ')}`);continue}
    }
    if(!VISIBILITIES.includes(visibility(metadata))){ restrictions.push({source:rel,reason:`unsupported visibility: ${visibility(metadata)}`}); continue }
    if(!allowed(metadata,lens,adapter,task)){const reason=!taskAllowed(metadata,task)?`task selector excludes ${task||'(unspecified task)'}`:SENSITIVITY_LENSES[metadata.sensitivity]&&!SENSITIVITY_LENSES[metadata.sensitivity].includes(lens)?`sensitivity ${metadata.sensitivity} excludes ${lens} lens`:`access_lenses exclude ${lens} lens`;restrictions.push({source:rel,reason});continue}
    const safeMetadata=privacyMetadata(metadata)
    if(lens==='publishing'&&safeMetadata.sensitivity==='employer-confidential'&&safeMetadata.document_role!=='policy'){restrictions.push({source:rel,reason:'employer-confidential content excluded from publishing context'});continue}
    if(lens==='publishing'&&safeMetadata.document_role==='evidence'&&!safeMetadata.publication_allowed){restrictions.push({source:rel,reason:`evidence disclosure ${safeMetadata.disclosure} is not publish-approved`});continue}
    if(lens==='publishing'&&safeMetadata.document_role!=='policy'&&!safeMetadata.publication_allowed)restrictions.push({source:rel,reason:`readable context is not publication-approved (${safeMetadata.disclosure})`})
    const filteredBody=filterFieldVisibility(filterClaimVisibility(body,lens,rel,restrictions),metadata,lens,rel,restrictions)
    const score=relevance(`${rel}\n${filteredBody}`,task)
    const content=filteredBody.trim();records.push({kind,path:rel,absolute_path:path,access_lenses:safeMetadata.access_lenses,disclosure:safeMetadata.disclosure,document_role:safeMetadata.document_role,publication_allowed:safeMetadata.publication_allowed,visibility:safeMetadata.visibility,public_safe:safeMetadata.public_safe,sensitivity:safeMetadata.sensitivity,confidence:safeMetadata.confidence,freshness:new Date(statSync(path).mtimeMs).toISOString(),source_hash:hash(text),task_relevance:score,content,metadata:safeMetadata})
  }
  if(task){
    records.sort((a,b)=>b.task_relevance-a.task_relevance||a.path.localeCompare(b.path))
    if(kind==='project')for(let i=records.length-1;i>=0;i--)if(records[i].task_relevance===0&&records[i].document_role!=='policy'){restrictions.push({source:records[i].path,reason:`no relevance match for task ${task}`});records.splice(i,1)}
  }
  return {records,restrictions,warnings}
}
function resolvedContextAssertions(records,lens,task,adapter,link){
  const errors=[],projectPaths=records.filter(record=>record.kind==='project').map(record=>record.path)
  for(const record of records){if(!allowed(record.metadata,lens,adapter,task))errors.push(`${record.kind}:${record.path}: policy rejected after resolution`);if(SECRET_RE.test(record.content))errors.push(`${record.kind}:${record.path}: secret-like content survived filtering`)}
  for(const path of projectPaths){if(!matchesAny(path,link?.project_context?.include||['**/*.md']))errors.push(`project:${path}: outside include policy`);if(matchesAny(path,link?.project_context?.exclude||DEFAULT_PROJECT_EXCLUDES))errors.push(`project:${path}: matched exclude policy`)}
  if(errors.length)throw new Error(`context leakage validation failed: ${errors.join('; ')}`)
  return {status:'passed',checks:['privacy-policy-reapplied','secret-pattern-scan','project-include-exclude-reapplied'],selected_sources:records.length}
}
function contextData(o){
  const project=projectPath(o); let link=null; let self=o.self ? resolve(o.self) : null
  if(!self&&pathExists(linkPath(project))){link=readLink(project);self=link.path}
  self=self || o.root
  if(!existsSync(self)) throw new Error(`self path not found: ${self}`)
  const lens=o.lens || link?.default_lens || 'general'; if(!LENSES.includes(lens)) throw new Error(`unknown lens: ${lens}`)
  const adapter=o.restrictedHost?'restricted-host':(o.adapter||'generic')
  const selfData=sourceRecords(self,'self',lens,o.task,adapter,link)
  const local=existsSync(project) && resolve(project)!==resolve(self) ? sourceRecords(project,'project',lens,o.task,adapter,link) : {records:[],restrictions:[],warnings:[]}
  const records=[...selfData.records,...local.records],sources=records.map(({content,metadata,absolute_path,...source})=>source)
  const warnings=[...(selfData.warnings||[]),...(local.warnings||[])]
  if(!link && !o.self && resolve(self)!==resolve(project)) warnings.push('No project link found; resolved explicit/default self root.')
  const generatedAt=new Date().toISOString(),restrictedHost=Boolean(o.snapshot||o.restrictedHost||adapter==='restricted-host'),expiresAt=restrictedHost?new Date(Date.parse(generatedAt)+(o.expiresHours||24)*60*60*1000).toISOString():null
  const validation=resolvedContextAssertions(records,lens,o.task,adapter,link)
  return {
    self:{path:slash(resolve(self)),documents:selfData.records.map(r=>({path:r.path,content:r.content,metadata:r.metadata}))},
    lens,
    project:{path:slash(project),name:basename(project),documents:local.records.map(r=>({path:r.path,content:r.content,metadata:r.metadata}))},
    task:o.task || null,
    packet_metadata:{schema_version:1,packet_id:randomUUID(),generated_at:generatedAt,expires_at:expiresAt,host_mode:restrictedHost?'restricted-host-snapshot':'live-local',source_hash_algorithm:'sha256',source_hashes:sources.map(source=>({kind:source.kind,path:source.path,sha256:source.source_hash,freshness:source.freshness}))},
    sources,
    restrictions:[...selfData.restrictions,...local.restrictions],
    warnings,
    validation,
    proposals:listProposalData(project).filter(p=>p.status==='pending')
  }
}
function packetFormat(data,adapter='generic'){
  const labels={pi:'Pi context packet',claude:'Claude Code context packet',codex:'Codex context packet',generic:'Holoself context packet',obsidian:'Obsidian/Claude context packet','restricted-host':'Restricted-host Holoself context packet'}
  const title=labels[adapter] || labels.generic,metadata=data.packet_metadata
  const docs=[...data.self.documents.map(x=>({...x,owner:'self'})),...data.project.documents.map(x=>({...x,owner:'project'}))]
  return `# ${title}\n\nPacket ID: ${metadata.packet_id}\nGenerated: ${metadata.generated_at}\nExpires: ${metadata.expires_at||'not applicable (live local resolution)'}\nHost mode: ${metadata.host_mode}\nLens: ${data.lens}\nTask: ${data.task || '(none)'}\nPrivacy: access-filtered. Publication requires disclosure=publish-approved; readability alone is never approval. Preserve provenance; never silently write self.\n\n## Source hashes (SHA-256)\n\n${metadata.source_hashes.map(source=>`- ${source.kind}:${source.path} ${source.sha256} (${source.freshness})`).join('\n')||'- None'}\n\n${docs.map(d=>`## ${d.owner}: ${d.path}\n\nAccess lenses: ${(d.metadata.access_lenses||[]).join(', ')}\nDisclosure: ${d.metadata.disclosure}\nSensitivity: ${d.metadata.sensitivity}\nDocument role: ${d.metadata.document_role}\nPublication allowed: ${d.metadata.publication_allowed?'yes':'no'}\n\n${d.content}`).join('\n\n')}\n\n## Restrictions\n\n${data.restrictions.map(x=>`- ${x.source}: ${x.reason}`).join('\n') || '- None'}\n`
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
function validateProposal(p){
  const errors=[],requiredStrings=['proposal_id','source_project','target','proposal_type','claim','evidence','confidence','visibility','status','created_at'],allowedKeys=new Set(['proposal_id','source_project','source_project_path','source_files','target','proposal_type','claim','evidence','confidence','visibility','status','created_at','reviewed_at','provenance','_path'])
  if(!p||Array.isArray(p)||typeof p!=='object')return ['proposal must be a mapping']
  for(const key of Object.keys(p))if(!allowedKeys.has(key))errors.push(`unknown proposal field: ${key}`)
  for(const key of requiredStrings)if(typeof p[key]!=='string'||!p[key].trim())errors.push(`proposal ${key} must be a non-empty string`)
  if(typeof p.proposal_id==='string'&&!UUID_RE.test(p.proposal_id))errors.push('proposal_id must be a UUID')
  if(typeof p.target==='string'&&(isAbsolute(p.target)||slash(p.target).split('/').includes('..')||!p.target.toLowerCase().endsWith('.md')))errors.push('proposal target must be a contained relative Markdown path')
  if(!PROPOSAL_TYPES.includes(p.proposal_type))errors.push(`invalid proposal_type: ${p.proposal_type}`)
  if(!PROPOSAL_STATES.includes(p.status))errors.push(`invalid proposal status: ${p.status}`)
  if(!VISIBILITIES.includes(p.visibility))errors.push(`invalid proposal visibility: ${p.visibility}`)
  if(typeof p.created_at==='string'&&Number.isNaN(Date.parse(p.created_at)))errors.push('proposal created_at must be an ISO date-time')
  if(p.reviewed_at!==undefined&&(typeof p.reviewed_at!=='string'||Number.isNaN(Date.parse(p.reviewed_at))))errors.push('proposal reviewed_at must be an ISO date-time')
  if(p.source_project_path!==undefined&&typeof p.source_project_path!=='string')errors.push('proposal source_project_path must be a string')
  for(const key of ['source_files','provenance'])if(!Array.isArray(p[key])||!p[key].length||p[key].some(x=>typeof x!=='string'||!x.trim()))errors.push(`proposal ${key} must be a non-empty string array`)
  if(Array.isArray(p.source_files)&&p.source_files.some(x=>isAbsolute(x)||slash(x).split('/').includes('..')))errors.push('proposal source_files must be contained relative paths')
  const textFields=[p.claim,p.evidence,p.confidence,...(Array.isArray(p.provenance)?p.provenance:[])];if(textFields.some(x=>typeof x==='string'&&/<!--\s*\/?holoself-claim/i.test(x)))errors.push('proposal text contains reserved claim markers')
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
  const dir=proposalDir(project);if(!existsSync(dir))return []
  if(lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory())throw new Error(`proposal directory is unsafe: ${dir}`)
  return readdirSync(dir).filter(x=>x.endsWith('.yaml')).sort().map(x=>readProposal(join(dir,x)))
}
function findProposal(project,id){
  if(typeof id!=='string'||!UUID_PREFIX_RE.test(id)||id.includes('..')||id.includes('/')||id.includes('\\'))throw new Error(`invalid proposal id: ${id}`)
  const proposals=listProposalData(project),matches=proposals.filter(p=>p.proposal_id===id||p.proposal_id.startsWith(id));if(!matches.length)throw new Error(`proposal not found: ${id}`);if(matches.length>1)throw new Error(`ambiguous proposal id: ${id}`);return matches[0]
}
function proposalProjectErrors(p,project){
  const errors=[];if(p.source_project!==basename(project))errors.push('proposal source_project does not match linked project')
  if(p.source_project_path&&resolve(p.source_project_path)!==resolve(project))errors.push('proposal source_project_path does not match linked project')
  for(const source of p.source_files||[]){try{const path=assertContainedPath(project,resolve(project,source),'proposal source file');if(!existsSync(path)||!lstatSync(path).isFile())errors.push(`proposal source file not found: ${source}`)}catch(error){errors.push(error.message)}}return errors
}
function saveProposal(p,path=p._path){const errors=validateProposal(p);if(errors.length)throw new Error(`invalid proposal: ${errors.join('; ')}`);const clean={...p};delete clean._path;atomicWrite(path,proposalText(clean))}
function stateProposal(project,p,state){
  if(!UUID_RE.test(p.proposal_id))throw new Error('proposal_id must be a UUID')
  const self=readLink(project).path,dir=assertContainedPath(self,join(self,'proposals',state),'proposal archive'),archive=assertContainedPath(self,join(dir,`${p.proposal_id}.yaml`),'proposal archive');if(existsSync(archive))throw new Error(`proposal archive collision: ${archive}`)
  p.status=state;p.reviewed_at=new Date().toISOString();ensureDir(dir);atomicWrite(archive,proposalText(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='_path'))));saveProposal(p)
}
function safeTarget(self,target){
  const root=resolve(self),path=assertContainedPath(root,resolve(root,target),'proposal target'),rel=slash(relative(root,path)),top=rel.split('/')[0]
  if(!['profile','context','reference','contribs','topics'].includes(top)||!path.toLowerCase().endsWith('.md'))throw new Error('proposal target must be Markdown under profile, context, reference, contribs, or topics')
  return path
}
function indexRoot(project){return assertContainedPath(project,join(project,'.holoself','index'),'index directory')}
function privacyMetadata(metadata){
  const rawSensitivity=typeof metadata.sensitivity==='string'?metadata.sensitivity:null,sensitivity=SENSITIVITIES.includes(rawSensitivity)?rawSensitivity:(rawSensitivity?'restricted':'personal')
  const result={access_lenses:accessLenses(metadata).filter(x=>LENSES.includes(x)),disclosure:disclosure(metadata),sensitivity,document_role:documentRole(metadata),publication_allowed:publicationAllowed({...metadata,sensitivity}),task_include:Array.isArray(metadata.task_include)?metadata.task_include:[],task_exclude:Array.isArray(metadata.task_exclude)?metadata.task_exclude:[],visibility:visibility(metadata),public_safe:Object.hasOwn(metadata,'public_safe')?metadata.public_safe:null,confidence:typeof metadata.confidence==='string'?metadata.confidence:null,exclude_lenses:Array.isArray(metadata.exclude_lenses)?metadata.exclude_lenses.filter(x=>LENSES.includes(x)):[],field_visibility:{}}
  if(metadata.field_visibility&&typeof metadata.field_visibility==='object'&&!Array.isArray(metadata.field_visibility))for(const [key,value] of Object.entries(metadata.field_visibility))result.field_visibility[key]=VISIBILITIES.includes(value)?value:'private'
  return result
}
function privacySections(body,policy){
  const chunks=[],claimPattern=/<!-- holoself-claim visibility=([a-z-]+) -->([\s\S]*?)<!-- \/holoself-claim -->/g
  const ordinary=body.replace(claimPattern,(_,claimVisibility,claimBody)=>{const v=VISIBILITIES.includes(claimVisibility)?claimVisibility:'private';for(const section of sections(claimBody))chunks.push({...section,visibility:v,claim:true,disclosure:v==='public-safe'?'publish-approved':'review-required'});return ''})
  for(const section of sections(ordinary)){const heading=section.heading.toLowerCase(),fieldRule=Object.entries(policy.field_visibility||{}).find(([field])=>heading.includes(field.toLowerCase())),v=COMPENSATION_RE.test(heading)?'private':fieldRule?.[1]||policy.visibility;chunks.push({...section,visibility:v,claim:false,disclosure:policy.disclosure})}
  return chunks
}
function indexInputHash(project,link=readLink(project)){
  const state=[]
  for(const [sourceKind,root,files] of [['self',link.path,canonicalFiles(link.path)],['project',project,projectMarkdownFiles(project,link)]])for(const file of files){const stat=statSync(file);state.push([sourceKind,slash(relative(root,file)),stat.size,stat.mtimeMs,hash(readFileSync(file,'utf8'))])}
  return hash(JSON.stringify({project_context:link.project_context,state:state.sort((a,b)=>`${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`))}))
}
function indexFreshness(project,index,link=readLink(project)){const actual=indexInputHash(project,link);return {fresh:index.input_state_hash===actual,expected:index.input_state_hash||null,actual}}
function buildIndex(project,changed=false){
  const link=readLink(project),path=join(indexRoot(project),'index.json');let old={entries:[]};const warnings=[]
  if(changed&&existsSync(path)){try{const parsed=JSON.parse(readFileSync(path,'utf8'));if(parsed.schema_version===3&&parsed.privacy_policy_version===2)old=parsed}catch{}}
  const oldByPath=new Map((old.entries||[]).map(x=>[`${x.source_kind}:${x.file}`,x])),entries=[];let skippedSecrets=0
  for(const [sourceKind,root] of [['self',link.path],['project',project]]){
    for(const file of sourceKind==='self'?canonicalFiles(root):projectMarkdownFiles(root,link)){
      const rel=slash(relative(root,file)),text=readFileSync(file,'utf8');let parsed
      try{parsed=frontmatter(text,{tolerant:sourceKind==='project'})}catch(error){warnings.push(`${sourceKind}:${rel}: ${error.message}; excluded fail-closed`);continue}
      const {metadata,body}=parsed
      if(secretFile(file,root)||SECRET_RE.test(text)||['secret','credential','credentials'].includes(metadata.sensitivity)){skippedSecrets++;continue}
      if(sourceKind==='self'){
        const metadataErrors=canonicalPrivacyMetadataErrors(metadata)
        if(metadataErrors.length){warnings.push(`${sourceKind}:${rel}: ${metadataErrors.join('; ')}; excluded fail-closed`);continue}
      }
      const modified=statSync(file).mtimeMs,oldEntry=oldByPath.get(`${sourceKind}:${rel}`);if(changed&&oldEntry?.modified_ms===modified&&oldEntry?.source_text_hash===hash(text)){entries.push(oldEntry);continue}
      if(!VISIBILITIES.includes(visibility(metadata)))continue
      const policy=privacyMetadata(metadata),indexedSections=privacySections(body,policy)
      const annotatedClaims=indexedSections.flatMap(section=>claims(section.content).map(text=>({text,visibility:COMPENSATION_RE.test(text)?'private':section.visibility})))
      const annotatedLinks=indexedSections.flatMap(section=>links(section.content).map(value=>({value,visibility:section.visibility})))
      const annotatedTags=indexedSections.flatMap(section=>tags(section.content).map(value=>({value,visibility:section.visibility})))
      entries.push({source_kind:sourceKind,source_project:sourceKind==='project'?basename(project):'self',file:rel,source_text_hash:hash(text),content_hash:hash(body),modified_ms:modified,modified_at:new Date(modified).toISOString(),frontmatter:policy,links:annotatedLinks,tags:annotatedTags,claims:annotatedClaims,visibility:policy.visibility,sections:indexedSections})
    }
  }
  entries.sort((a,b)=>`${a.source_kind}:${a.file}`.localeCompare(`${b.source_kind}:${b.file}`))
  const projectEntries=entries.filter(entry=>entry.source_kind==='project'),projectPaths=projectEntries.map(entry=>entry.file),assertionErrors=[]
  for(const entry of projectEntries){if(!matchesAny(entry.file,link.project_context.include))assertionErrors.push(`${entry.file}: outside include policy`);if(matchesAny(entry.file,link.project_context.exclude))assertionErrors.push(`${entry.file}: matched exclude policy`)}
  for(const pattern of link.project_context.assert_include||[])if(!projectPaths.some(file=>globRegex(pattern).test(file)))assertionErrors.push(`assert_include unmatched: ${pattern}`)
  for(const pattern of link.project_context.assert_exclude||[])if(projectPaths.some(file=>globRegex(pattern).test(file)))assertionErrors.push(`assert_exclude matched indexed file: ${pattern}`)
  for(const entry of entries)for(const section of entry.sections||[])if(SECRET_RE.test(section.content))assertionErrors.push(`${entry.source_kind}:${entry.file}: secret-like content survived index build`)
  if(assertionErrors.length)throw new Error(`index post-build assertions failed: ${assertionErrors.join('; ')}`)
  const buildAssertions={status:'passed',checks:['include-policy','exclude-policy','required-includes','forbidden-excludes','secret-pattern-scan'],included_project_files:projectEntries.length}
  const index={schema_version:3,privacy_policy_version:2,engine:'deterministic-json',source_of_truth:'Markdown',generated_at:new Date().toISOString(),input_state_hash:indexInputHash(project,link),project_context_hash:hash(JSON.stringify(link.project_context)),project:slash(project),self:slash(link.path),skipped_secret_files:skippedSecrets,warnings,build_assertions:buildAssertions,entries}
  ensureDir(indexRoot(project));atomicWrite(path,JSON.stringify(index,null,2)+'\n');return index
}
function readIndex(project,auto=true){
  const path=join(indexRoot(project),'index.json');if(!existsSync(path)){if(auto)return buildIndex(project);throw new Error(`index missing: ${path}`)}
  let index;try{index=JSON.parse(readFileSync(path,'utf8'))}catch{if(auto)return buildIndex(project);throw new Error(`index is invalid JSON: ${path}`)}
  if(index.schema_version!==3||index.privacy_policy_version!==2||index.engine!=='deterministic-json'||!Array.isArray(index.entries)||index.build_assertions?.status!=='passed'){if(auto)return buildIndex(project);throw new Error(`index schema is stale or invalid: ${path}`)}
  const freshness=indexFreshness(project,index);if(!freshness.fresh){if(auto)return buildIndex(project);throw new Error(`index content is stale: ${path}`)}return index
}
function searchIndex(index,query,lens='general'){
  const terms=[...tokenize(query)],results=[]
  for(const entry of index.entries){if(!allowed(entry.frontmatter||{},lens,'generic'))continue
    const policy=entry.frontmatter||{}
    if(lens==='publishing'&&policy.sensitivity==='employer-confidential'&&policy.document_role!=='policy')continue
    if(lens==='publishing'&&policy.document_role==='evidence'&&!policy.publication_allowed)continue
    for(const section of entry.sections||[]){const sectionVisibility=VISIBILITIES.includes(section.visibility)?section.visibility:'private';if(!allowed({visibility:sectionVisibility},lens,'generic'))continue
      const restrictions=[],filtered=filterFieldVisibility(filterClaimVisibility(section.content,lens,entry.file,restrictions),entry.frontmatter||{},lens,entry.file,restrictions);if(!filtered.trim())continue
      const hay=`${section.heading} ${filtered}`.toLowerCase(),score=terms.filter(x=>hay.includes(x)).length;if(!score)continue
      const passage=filtered.length>360?filtered.slice(0,357)+'...':filtered
      results.push({source_file:entry.file,source_kind:entry.source_kind,source_project:entry.source_project,section:section.heading,matching_passage:passage,provenance:`${entry.source_kind}:${entry.file}#${section.heading}`,access_lenses:policy.access_lenses||[],disclosure:section.disclosure||policy.disclosure||'internal-only',sensitivity:policy.sensitivity||'personal',document_role:policy.document_role||'content',publication_allowed:Boolean(policy.publication_allowed),visibility:sectionVisibility,freshness:entry.modified_at,score})
    }
  }
  return results.sort((a,b)=>b.score-a.score||a.source_file.localeCompare(b.source_file))
}
export function ecosystemValidationErrors(root,project=null){
  const errors=[]
  const checkMarkdown=base=>{
    for(const path of markdownFiles(base)){
      const text=readFileSync(path,'utf8'),rel=slash(relative(base,path));let metadata={}
      try{metadata=frontmatter(text).metadata}catch(error){errors.push(`${error.message}: ${rel}`)}
      const canonicalContent=/^(?:profile|context|topics)\//.test(rel)
      if(canonicalContent)for(const error of canonicalPrivacyMetadataErrors(metadata))errors.push(`${error}: ${rel}`)
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
  if(existsSync(root))checkMarkdown(root)
  const proposalRoots=[join(root,'proposals')]
  if(project){
    try{
      const link=readLink(project)
      if(!existsSync(link.path))errors.push(`broken self path: ${link.path}`)
      else if(!existsSync(join(link.path,'profile'))||!existsSync(join(link.path,'context')))errors.push(`self path lacks profile/context layout: ${link.path}`)
      if(link.access!=='read')errors.push('link access must be read')
      if(link.proposals!=='enabled'&&link.proposals!=='disabled')errors.push(`invalid proposals mode: ${link.proposals}`)
      if(link.index!=='local')errors.push(`link index must be local: ${link.index}`)
      if(!LENSES.includes(link.default_lens))errors.push(`invalid default lens: ${link.default_lens}`)
      for(const lens of link.secondary_lenses||[])if(!LENSES.includes(lens))errors.push(`invalid secondary lens: ${lens}`)
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

async function activateLinkedProject(o,project,link,verb='Activate'){
  if(o.noActivate)return null
  const options={activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',dryRun:o.dryRun,force:o.force}
  const {plan}=preflightActivation(project,options);console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters.map(({id,name,file,support,delivery,discovery,tested_product,tested_version,evidence,last_verified,detected})=>({id,name,file,support,delivery,discovery,tested_product,tested_version,evidence,last_verified,detected})),skills:plan.skills,writes:plan.writes}},null,2))
  if(!await askConfirm(o,`${verb} Holoself by modifying bounded managed files: ${plan.writes.join(', ')}?`))return null
  const result=activateProject(project,link,options);for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`);return result
}
function healthStatus(project,link){const activation=activationStatus(project),selfExists=existsSync(link.path),snapshot=existsSync(join(project,'.holoself','runtime','context-packet.md')),errors=[];if(!selfExists)errors.push('self path missing');if(!activation.bootstrap&&!snapshot)errors.push('bootstrap missing');if(!activation.adapters.length&&!snapshot)errors.push('no activated adapters');for(const a of activation.adapters){if(a.marker!=='active')errors.push(`${a.file}: ${a.marker}`);else if(a.drift)errors.push(`${a.file}: managed block drift`)}const state=!selfExists?'broken':activation.active?'activated':snapshot&&!activation.runtime?'manual-only':activation.runtime?'degraded':'configured';return {state,activation,snapshot,errors}}
export async function runEcosystem(o){
  const sub=o.args?.[0]
  if(o.command==='link' && ['add','status','remove','setup','activate','deactivate','repair','doctor'].includes(sub)){
    const project=projectPath(o)
    if(sub==='add'){
      if(!o.self)throw new Error('link add requires --self <path>');if(!existsSync(project))throw new Error(`project not found: ${project}`);if(!existsSync(o.self))throw new Error(`self path not found: ${resolve(o.self)}`);if(!existsSync(join(o.self,'profile'))||!existsSync(join(o.self,'context')))throw new Error(`self path lacks profile/context layout: ${resolve(o.self)}`);const desired={path:slash(resolve(o.self)),access:'read',proposals:'enabled',index:'local',default_lens:o.lens||'general',secondary_lenses:o.secondaryLenses||[]},desiredErrors=linkSchemaErrors(desired);if(desiredErrors.length)throw new Error(desiredErrors.join('; '))
      const collisions=inspectLinkCollisions(project);if(collisions.length){if(!o.force)throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation to preserve README and replace link configuration`);if(!await askConfirm(o,`Replace link configuration while preserving existing project metadata (${collisions.join(', ')})?`))return true}
      if(!o.noActivate){const {plan}=preflightActivation(project,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',dryRun:o.dryRun,force:o.force});console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters.map(x=>({id:x.id,file:x.file,support:x.support,delivery:x.delivery,discovery:x.discovery,tested_product:x.tested_product,tested_version:x.tested_version,evidence:x.evidence,last_verified:x.last_verified,detected:x.detected})),skills:plan.skills,writes:plan.writes}},null,2));if(!await askConfirm(o,`Create link and modify bounded managed files: ${plan.writes.join(', ')}?`))return true}
      const existingLink=pathExists(linkPath(project))?readFileSync(linkPath(project)):null;let link;try{if(o.dryRun)link={...desired,project_context:{include:o.projectContext?.include||['**/*.md'],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(o.projectContext?.exclude||[])]}};else{createLinkDirs(project,{preserveReadme:o.force});link=writeLink(project,o.self,o.lens||'general',o.secondaryLenses||[],o.projectContext||{})}console.log(`${o.dryRun?'[dry-run] ':'[ok] '}linked ${project} -> ${link.path}`);if(!o.noActivate){const result=activateProject(project,link,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',dryRun:o.dryRun,force:o.force});for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`)}}catch(error){if(!o.dryRun){if(existingLink)atomicWrite(linkPath(project),existingLink);else if(pathExists(linkPath(project)))rmSync(linkPath(project),{force:true})}throw error}return true
    }
    if(sub==='status'){
      let link;try{link=readLink(project)}catch(error){console.log(JSON.stringify({project:slash(project),state:'broken',errors:[error.message]},null,2));process.exitCode=1;return true}const health=healthStatus(project,link),{project_context,...selfContext}=link,status={project:slash(project),state:health.state,self_context:{...selfContext,path:slash(link.path)},project_context,self_exists:existsSync(link.path),pending_proposals:listProposalData(project).filter(x=>x.status==='pending').length,index_exists:existsSync(join(indexRoot(project),'index.json')),bootstrap_exists:health.activation.bootstrap,activated_adapters:health.activation.adapters,errors:health.errors};console.log(JSON.stringify(status,null,2));if(['broken','degraded'].includes(status.state))process.exitCode=1;return true
    }
    if(sub==='remove'){
      const path=linkPath(project);if(!pathExists(path)){console.log('[ok] no link configuration found');return true}if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error(`${path} is not a regular link configuration; refusing to remove`);if(!await askConfirm(o,`Remove managed activation and link configuration ${path}?`)){console.log('Cancelled.');return true}deactivateProject(project,{dryRun:o.dryRun});if(!o.dryRun)rmSync(path);console.log(`[ok] removed ${path}; indexes, reports, and proposals preserved`);return true
    }
    if(['activate','repair'].includes(sub)){const link=readLink(project);await activateLinkedProject(o,project,link,sub==='repair'?'Repair':'Activate');return true}
    if(sub==='deactivate'){if(!await askConfirm(o,'Remove bounded Holoself activation sections while preserving link metadata?'))return true;const results=deactivateProject(project,{dryRun:o.dryRun});for(const item of results)console.log(` - ${item.file}: ${item.result}`);return true}
    if(sub==='doctor'){const link=readLink(project),health=healthStatus(project,link),checks={link:'valid',self_root:existsSync(link.path)?'valid':'missing',lens:LENSES.includes(link.default_lens)?'valid':'invalid',bootstrap:health.activation.bootstrap?'valid':'missing',activation:health.activation.active?'valid':'degraded',context:'unknown'};try{const data=contextData({...o,project});checks.context=data.sources.length?'valid':'empty';checks.warnings=data.warnings}catch(error){checks.context='broken';checks.context_error=error.message}const ok=!Object.values(checks).some(x=>['missing','invalid','degraded','broken'].includes(x));console.log(JSON.stringify({state:ok?'activated':'degraded',checks},null,2));if(!ok)process.exitCode=1;return true}
    const findings=setupFindings(project);console.log(JSON.stringify(findings,null,2));let self=o.self;if(!self&&input.isTTY&&output.isTTY){const answer=await askValue('Canonical self path');if(answer)self=resolve(answer)}if(!self){if(o.yes)throw new Error('link setup requires --self <path> before confirmation');console.log('No changes made. Re-run with --self <path> --yes to create link.');return true}if(!existsSync(join(self,'profile'))||!existsSync(join(self,'context')))throw new Error(`self path lacks profile/context layout: ${resolve(self)}`);const collisions=inspectLinkCollisions(project);if(collisions.length&&!o.force)throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation`);if(!o.noActivate){const {plan}=preflightActivation(project,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',dryRun:o.dryRun,force:o.force});console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters,skills:plan.skills,writes:plan.writes}},null,2))}if(!await askConfirm(o,`${collisions.length?'Replace link configuration while preserving existing README and artifacts':'Create and activate link'} using ${self} and ${o.lens||findings.suggested_lens} lens?`)){console.log('Cancelled.');return true}let link;if(o.dryRun)link={path:resolve(self),access:'read',proposals:'enabled',index:'local',default_lens:o.lens||findings.suggested_lens,secondary_lenses:o.secondaryLenses||[],project_context:{include:o.projectContext?.include||['**/*.md'],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(o.projectContext?.exclude||[])]}};else{createLinkDirs(project,{preserveReadme:o.force});link=writeLink(project,self,o.lens||findings.suggested_lens,o.secondaryLenses||[],o.projectContext||{})}if(!o.noActivate){const result=activateProject(project,link,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',dryRun:o.dryRun,force:o.force});for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`)}console.log(`${o.dryRun?'[dry-run] ':'[ok] '}setup complete; no files deleted or relocated`);return true
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
    for(const source of sourceFiles){const path=resolve(project,source),rel=relative(project,path);if(rel.startsWith('..')||isAbsolute(rel))throw new Error(`source file escapes project: ${source}`);if(!existsSync(path)||!lstatSync(path).isFile())throw new Error(`source file not found: ${source}`)}
    const p={proposal_id:randomUUID(),source_project:basename(project),source_project_path:slash(project),source_files:sourceFiles,target:o.targetFile||'context/claims.md',proposal_type:o.proposalType||'new_fact',claim,evidence:o.evidence||`Source project files: ${sourceFiles.join(', ')}`,confidence:o.confidence||'unverified',visibility:o.visibility||'private',status:'pending',created_at:new Date().toISOString(),provenance:sourceFiles.map(x=>`${basename(project)}:${x}`)}
    const errors=validateProposal(p);if(errors.length)throw new Error(errors.join('; '));createLinkDirs(project,{preserveReadme:true});saveProposal(p,proposalFile(project,p.proposal_id));console.log(JSON.stringify(p,null,2));return true
  }
  if(o.command==='proposals'){
    const project=projectPath(o),action=sub;if(action==='list'){console.log(JSON.stringify(listProposalData(project).map(({_path,...p})=>p),null,2));return true}
    const id=o.args[1];if(!id)throw new Error(`proposals ${action} requires <id>`);const p=findProposal(project,id)
    if(action==='show'){console.log(proposalText(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='_path'))));return true}
    if(!['approve','reject','defer'].includes(action))throw new Error('proposals requires list, show, approve, reject, or defer')
    if(p.status!=='pending')throw new Error(`proposal is ${p.status}, expected pending`)
    if(action==='approve'){
      const projectErrors=proposalProjectErrors(p,project);if(projectErrors.length)throw new Error(`proposal provenance validation failed: ${projectErrors.join('; ')}`)
      const link=readLink(project),target=safeTarget(link.path,p.target);const preErrors=ecosystemValidationErrors(link.path,project);if(preErrors.length)throw new Error(`pre-approval validation failed: ${preErrors.join('; ')}`);const before=existsSync(target)?readFileSync(target,'utf8'):'---\naccess_lenses: [general, career, publishing, technical, leadership, interview, private]\ndisclosure: review-required\nsensitivity: personal\ndocument_role: evidence\n---\n';if(claims(before).some(x=>normalize(x)===normalize(p.claim)))throw new Error('proposal duplicates an existing canonical claim');const block=`\n\n<!-- holoself-claim visibility=${p.visibility} -->\n## Approved proposal ${p.proposal_id}\n\n${p.claim}\n\n- Evidence: ${p.evidence}\n- Confidence: ${p.confidence}\n- Visibility: ${p.visibility}\n- Provenance: ${p.provenance.join('; ')}\n- Approved: ${new Date().toISOString()}\n<!-- /holoself-claim -->\n`;console.log(`Target: ${target}\nAffected files: ${target}\nEvidence: ${p.evidence}\n--- proposed diff ---\n+${block.trim().replaceAll('\n','\n+')}`)
      if(!await askConfirm(o,'Approve proposal and append canonical self context?')){console.log('Cancelled.');return true}atomicWrite(target,before.trimEnd()+block);stateProposal(project,p,'approved');const errors=ecosystemValidationErrors(link.path,project);if(errors.length)throw new Error(`post-approval validation failed: ${errors.join('; ')}`);console.log(`[ok] approved ${p.proposal_id}; validation passed`);return true
    }
    if(!await askConfirm(o,`${action==='reject'?'Reject':'Defer'} proposal ${p.proposal_id}?`)){console.log('Cancelled.');return true}stateProposal(project,p,action==='reject'?'rejected':'deferred');console.log(`[ok] ${action==='reject'?'rejected':'deferred'} ${p.proposal_id}`);return true
  }
  if(o.command==='index'){
    const project=projectPath(o);if(sub==='status'){const path=join(indexRoot(project),'index.json');if(!existsSync(path)){console.log(JSON.stringify({status:'missing',path:slash(path)},null,2));return true}let index;try{index=JSON.parse(readFileSync(path,'utf8'))}catch{throw new Error(`index is invalid JSON: ${path}`)};if(index.schema_version!==3||index.privacy_policy_version!==2||!Array.isArray(index.entries))throw new Error(`index schema is stale or invalid: ${path}`);const freshness=indexFreshness(project,index);console.log(JSON.stringify({status:freshness.fresh?'ready':'stale',fresh:freshness.fresh,path:slash(path),schema_version:index.schema_version,privacy_policy_version:index.privacy_policy_version,engine:index.engine,entries:index.entries.length,generated_at:index.generated_at,input_state_hash:index.input_state_hash,skipped_secret_files:index.skipped_secret_files,build_assertions:index.build_assertions},null,2));return true}
    const rebuild=sub==='rebuild';const index=buildIndex(project,o.changed&&!rebuild);console.log(JSON.stringify({status:'ready',fresh:true,schema_version:index.schema_version,privacy_policy_version:index.privacy_policy_version,engine:index.engine,entries:index.entries.length,generated_at:index.generated_at,skipped_secret_files:index.skipped_secret_files,build_assertions:index.build_assertions},null,2));return true
  }
  if(o.command==='search'){
    const query=o.args.join(' ');if(!query)throw new Error('search requires a query');const project=projectPath(o),index=readIndex(project);let results=searchIndex(index,query,o.lens||'general')
    if(o.federated){const seen=new Set(results.map(x=>`${x.provenance}:${x.matching_passage}`));results=results.filter(x=>{const key=`${x.provenance}:${x.matching_passage}`;if(seen.has(key)){seen.delete(key);return true}return false})}
    console.log(JSON.stringify({query,federated:Boolean(o.federated),results},null,2));return true
  }
  return false
}
