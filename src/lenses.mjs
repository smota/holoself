import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const LENS_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const CUSTOM_SENSITIVITY_CATEGORIES=['compensation-confidential','third-party-personal','recruiter-confidential','employer-confidential','application-private']
const DEFAULT_SENSITIVITY_ACCESS={
  general:[],
  professional:['compensation-confidential','recruiter-confidential','employer-confidential','application-private'],
  'public-voice':[...CUSTOM_SENSITIVITY_CATEGORIES],
  technical:['employer-confidential'],
  leadership:['third-party-personal','employer-confidential'],
  interview:['compensation-confidential','recruiter-confidential','employer-confidential','application-private'],
  private:[...CUSTOM_SENSITIVITY_CATEGORIES,'restricted']
}
const TITLES={general:'General',professional:'Professional','public-voice':'Public voice',technical:'Technical',leadership:'Leadership',interview:'Interview',private:'Private'}
const DEFAULT_INSTRUCTIONS={general:{purpose:'Balanced whole-person context',priorities:['relevance','privacy'],include:[],exclude:[],response_guidance:[]},professional:{purpose:'Career positioning and professional decisions',priorities:['evidence','credible positioning'],include:['professional history','leadership evidence'],exclude:[],response_guidance:['Prefer evidence-backed claims']},'public-voice':{purpose:'Public voice context',priorities:['voice','audience safety'],include:[],exclude:[],response_guidance:[]},technical:{purpose:'Technical delivery and architecture context',priorities:['technical evidence'],include:[],exclude:[],response_guidance:[]},leadership:{purpose:'Leadership decisions and communication',priorities:['stakeholders','outcomes'],include:[],exclude:[],response_guidance:[]},interview:{purpose:'Interview preparation and evidence',priorities:['specific examples','truthful calibration'],include:[],exclude:[],response_guidance:[]},private:{purpose:'Full private context',priorities:['completeness'],include:[],exclude:[],response_guidance:[]}}
function validateInstructions(value,file='instructions'){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${file}: instructions must be an object`);const allowed=['purpose','priorities','include','exclude','response_guidance'];for(const key of Object.keys(value))if(!allowed.includes(key))throw new Error(`${file}: unknown instruction field ${key}`);if(typeof (value.purpose??'')!=='string')throw new Error(`${file}: purpose must be text`);for(const key of allowed.slice(1))if(value[key]!==undefined&&(!Array.isArray(value[key])||value[key].some(item=>typeof item!=='string')))throw new Error(`${file}: ${key} must be a string array`);return {purpose:(value.purpose||'').trim(),priorities:[...(value.priorities||[])],include:[...(value.include||[])],exclude:[...(value.exclude||[])],response_guidance:[...(value.response_guidance||[])]}}
export const DEFAULT_LENS_IDS=['general','professional','public-voice','technical','leadership','interview','private']
export const DEFAULT_LENSES=DEFAULT_LENS_IDS.map(id=>Object.freeze({schema_version:1,id,title:TITLES[id],sensitivity_access:Object.freeze([...DEFAULT_SENSITIVITY_ACCESS[id]]),instructions:Object.freeze(DEFAULT_INSTRUCTIONS[id])}))
const sha=text=>createHash('sha256').update(text).digest('hex')
const fail=(file,message)=>{throw new Error(`invalid lens definition ${file}: ${message}`)}

// Relative POSIX paths or globs with `*` inside one segment; the single entry "*" means every eligible source.
function validateSessionStartSources(value,file){
  if(value===undefined)return undefined
  if(!Array.isArray(value)||value.length>20||new Set(value).size!==value.length)fail(file,'session_start_sources must be an array of at most 20 unique patterns')
  for(const item of value){if(typeof item!=='string'||!item||item.includes('\\')||item.startsWith('/')||/^[A-Za-z]:/.test(item)||item.split('/').some(part=>!part||part==='..'||part==='.')||item.includes('**'))fail(file,`invalid session_start_sources pattern: ${JSON.stringify(item)}`)}
  if(value.includes('*')&&value.length>1)fail(file,'session_start_sources "*" must be the only entry')
  return Object.freeze([...value])
}
function validateDefinition(value,file){
  if(!value||Array.isArray(value)||typeof value!=='object')fail(file,'must be an object')
  const allowed=new Set(['schema_version','id','title','sensitivity_access','instructions','session_start_sources'])
  for(const key of Object.keys(value))if(!allowed.has(key))fail(file,`unknown field ${key}`)
  for(const key of ['schema_version','id','title'])if(!Object.hasOwn(value,key))fail(file,`missing ${key}`)
  if(value.schema_version!==1)fail(file,'schema_version must be 1')
  if(typeof value.id!=='string'||value.id.length>40||!LENS_ID_PATTERN.test(value.id))fail(file,'id must be lowercase kebab-case, start with a letter, and be at most 40 characters')
  if(value.id==='bindings')fail(file,'bindings is a reserved storage name')
  if(typeof value.title!=='string'||!value.title.trim())fail(file,'title must be a non-empty string')
  const sensitivity=value.sensitivity_access??[]
  if(!Array.isArray(sensitivity)||new Set(sensitivity).size!==sensitivity.length||sensitivity.some(item=>!([...CUSTOM_SENSITIVITY_CATEGORIES,...(value.id==='private'?['restricted']:[])]).includes(item)))fail(file,'sensitivity_access must contain unique supported categories; restricted is not allowed')
  const sessionStart=validateSessionStartSources(value.session_start_sources,file)
  return Object.freeze({schema_version:1,id:value.id,title:value.title.trim(),sensitivity_access:Object.freeze([...sensitivity]),instructions:Object.freeze(validateInstructions(value.instructions||{purpose:''},file)),...(sessionStart?{session_start_sources:sessionStart}:{})})
}

export function loadLensRegistry(selfRoot){
  if(typeof selfRoot!=='string'||!selfRoot.trim())throw new Error('lens registry requires a self root')
  const root=resolve(selfRoot);let ancestor=root;while(true){if(existsSync(ancestor)&&lstatSync(ancestor).isSymbolicLink())throw new Error(`unsafe lens root: ${ancestor}`);const parent=resolve(ancestor,'..');if(parent===ancestor)break;ancestor=parent}
  const registryPath=join(root,'lenses'),records=[]
  if(existsSync(registryPath)){
    const stat=lstatSync(registryPath)
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`unsafe lens registry directory: ${registryPath}`)
    for(const name of readdirSync(registryPath).filter(name=>name.toLowerCase().endsWith('.json')&&name.toLowerCase()!=='bindings.json').sort((a,b)=>(a<b?-1:a>b?1:0))){
      const path=join(registryPath,name),entry=lstatSync(path)
      if(entry.isSymbolicLink()||!entry.isFile())throw new Error(`unsafe lens registry entry: ${path}`)
      const raw=readFileSync(path,'utf8');let parsed
      try{parsed=JSON.parse(raw)}catch(error){fail(name,`malformed JSON (${error.message})`)}
      if(name!==`${parsed.id}.json`)fail(name,'filename must match lens id')
      records.push({name,raw,lens:validateDefinition(parsed,name)})
    }
  }
  const lenses=records.map(record=>record.lens),byId=new Map()
  for(const lens of lenses){if(byId.has(lens.id))throw new Error(`duplicate lens id ${lens.id}`);byId.set(lens.id,lens)}
  const registry_hash=sha(JSON.stringify(records.map(record=>[record.name,sha(record.raw)])))
  return Object.freeze({root,registry_path:registryPath,registry_hash,lenses:Object.freeze(lenses),byId})
}

export function resolveLens(registry,id){
  if(!registry?.byId)throw new Error('lens registry is not loaded')
  if(typeof id!=='string'||id.length>40||!LENS_ID_PATTERN.test(id))throw new Error(`invalid lens id: ${id}`)
  const lens=registry.byId.get(id)
  if(!lens)throw new Error(`unknown lens: ${id}`)
  return lens
}

export function saveCustomLens(selfRoot,id,value,expectedHash){
  const registry=loadLensRegistry(selfRoot)
  if(expectedHash!==registry.registry_hash){const error=new Error('lens registry changed on disk');error.code='STALE_REGISTRY';error.current_hash=registry.registry_hash;throw error}
  if(id!==value?.id)throw new Error('lens id must match the definition id')
  const lens=validateDefinition(value,`${id}.json`),dir=registry.registry_path,path=join(dir,`${id}.json`)
  mkdirSync(dir,{recursive:true});const tmp=`${path}.tmp-${process.pid}`
  try{writeFileSync(tmp,JSON.stringify({schema_version:1,id:lens.id,title:lens.title,sensitivity_access:[...lens.sensitivity_access],instructions:lens.instructions,...(lens.session_start_sources?{session_start_sources:[...lens.session_start_sources]}:{})},null,2)+'\n',{flag:'wx'});renameSync(tmp,path);loadLensRegistry(selfRoot)}finally{if(existsSync(tmp))rmSync(tmp,{force:true})}
  return loadLensRegistry(selfRoot)
}

export function saveLensInstructions(selfRoot,id,instructions,expectedHash){const registry=loadLensRegistry(selfRoot),lens=resolveLens(registry,id);return saveCustomLens(selfRoot,id,{...lens,instructions:validateInstructions(instructions)},expectedHash)}

export function removeCustomLens(selfRoot,id,expectedHash){
  const registry=loadLensRegistry(selfRoot)
  if(expectedHash!==registry.registry_hash){const error=new Error('lens registry changed on disk');error.code='STALE_REGISTRY';error.current_hash=registry.registry_hash;throw error}
  if(id==='private')throw new Error('private lens is owner-exclusive and cannot be removed')
  const bindingFile=join(registry.registry_path,'bindings.json');if(existsSync(bindingFile)){const value=JSON.parse(readFileSync(bindingFile,'utf8'));if(Object.values(value.bindings||{}).some(binding=>binding.default_lens===id||(binding.secondary_lenses||[]).includes(id)))throw new Error('lens is bound to a project; unbind or choose another lens first')}
  if(!registry.lenses.some(lens=>lens.id===id))throw new Error('lens not found')
  rmSync(join(registry.registry_path,`${id}.json`));return loadLensRegistry(selfRoot)
}

export function lensIdStructurallyValid(id){return typeof id==='string'&&id.length<=40&&LENS_ID_PATTERN.test(id)}

export function seedLensDefinitions(root){
 loadLensRegistry(root)
 const dir=join(resolve(root),'lenses');mkdirSync(dir,{recursive:true})
 for(const lens of DEFAULT_LENSES){const path=join(dir,`${lens.id}.json`);if(!existsSync(path))writeFileSync(path,JSON.stringify(lens,null,2)+'\n',{flag:'wx'})}
 return loadLensRegistry(root)
}
