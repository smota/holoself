import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const LENS_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const CUSTOM_SENSITIVITY_CATEGORIES=['compensation-confidential','third-party-personal','recruiter-confidential','employer-confidential','application-private']
const BUILTIN_SENSITIVITY_ACCESS={
  general:[],
  career:['compensation-confidential','recruiter-confidential','employer-confidential','application-private'],
  publishing:[],
  technical:['employer-confidential'],
  leadership:['third-party-personal','employer-confidential'],
  interview:['compensation-confidential','recruiter-confidential','employer-confidential','application-private'],
  private:[...CUSTOM_SENSITIVITY_CATEGORIES,'restricted']
}
const TITLES={general:'General',career:'Career',publishing:'Publishing',technical:'Technical',leadership:'Leadership',interview:'Interview',private:'Private'}
const DEFAULT_INSTRUCTIONS={general:{purpose:'Balanced whole-person context',priorities:['relevance','privacy'],include:[],exclude:[],response_guidance:[]},career:{purpose:'Career positioning and professional decisions',priorities:['evidence','credible positioning'],include:['career history','leadership evidence'],exclude:[],response_guidance:['Prefer evidence-backed claims']},publishing:{purpose:'Public-safe publishing context',priorities:['voice','audience safety'],include:['publish-approved material'],exclude:['private detail'],response_guidance:[]},technical:{purpose:'Technical delivery and architecture context',priorities:['technical evidence'],include:[],exclude:[],response_guidance:[]},leadership:{purpose:'Leadership decisions and communication',priorities:['stakeholders','outcomes'],include:[],exclude:[],response_guidance:[]},interview:{purpose:'Interview preparation and evidence',priorities:['specific examples','truthful calibration'],include:[],exclude:[],response_guidance:[]},private:{purpose:'Full private context',priorities:['completeness'],include:[],exclude:[],response_guidance:[]}}
function validateInstructions(value,file='instructions'){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${file}: instructions must be an object`);const allowed=['purpose','priorities','include','exclude','response_guidance'];for(const key of Object.keys(value))if(!allowed.includes(key))throw new Error(`${file}: unknown instruction field ${key}`);if(typeof (value.purpose??'')!=='string')throw new Error(`${file}: purpose must be text`);for(const key of allowed.slice(1))if(value[key]!==undefined&&(!Array.isArray(value[key])||value[key].some(item=>typeof item!=='string')))throw new Error(`${file}: ${key} must be a string array`);return {purpose:(value.purpose||'').trim(),priorities:[...(value.priorities||[])],include:[...(value.include||[])],exclude:[...(value.exclude||[])],response_guidance:[...(value.response_guidance||[])]}}
export const BUILTIN_LENS_IDS=['general','career','publishing','technical','leadership','interview','private']
export const BUILTIN_LENSES=BUILTIN_LENS_IDS.map(id=>Object.freeze({schema_version:1,id,title:TITLES[id],source:'builtin',base_lens:id,sensitivity_access:Object.freeze([...BUILTIN_SENSITIVITY_ACCESS[id]]),instructions:Object.freeze(DEFAULT_INSTRUCTIONS[id])}))
const BUILTIN_BY_ID=new Map(BUILTIN_LENSES.map(lens=>[lens.id,lens]))
const sha=text=>createHash('sha256').update(text).digest('hex')
const fail=(file,message)=>{throw new Error(`invalid lens definition ${file}: ${message}`)}

function validateDefinition(value,file){
  if(!value||Array.isArray(value)||typeof value!=='object')fail(file,'must be an object')
  const allowed=new Set(['schema_version','id','title','base_lens','sensitivity_access','instructions'])
  for(const key of Object.keys(value))if(!allowed.has(key))fail(file,`unknown field ${key}`)
  for(const key of ['schema_version','id','title','base_lens'])if(!Object.hasOwn(value,key))fail(file,`missing ${key}`)
  if(value.schema_version!==1)fail(file,'schema_version must be 1')
  if(typeof value.id!=='string'||value.id.length>40||!LENS_ID_PATTERN.test(value.id))fail(file,'id must be lowercase kebab-case, start with a letter, and be at most 40 characters')
  if(BUILTIN_BY_ID.has(value.id))fail(file,`reserved built-in id ${value.id}`)
  if(typeof value.title!=='string'||!value.title.trim())fail(file,'title must be a non-empty string')
  if(!BUILTIN_BY_ID.has(value.base_lens))fail(file,'base_lens must be a built-in lens')
  const sensitivity=value.sensitivity_access??[]
  if(!Array.isArray(sensitivity)||new Set(sensitivity).size!==sensitivity.length||sensitivity.some(item=>!CUSTOM_SENSITIVITY_CATEGORIES.includes(item)))fail(file,'sensitivity_access must contain unique supported categories; restricted is not allowed')
  return Object.freeze({schema_version:1,id:value.id,title:value.title.trim(),source:'registry',base_lens:value.base_lens,sensitivity_access:Object.freeze([...sensitivity]),instructions:Object.freeze(validateInstructions(value.instructions||DEFAULT_INSTRUCTIONS[value.base_lens],file))})
}

export function loadLensRegistry(selfRoot){
  if(typeof selfRoot!=='string'||!selfRoot.trim())throw new Error('lens registry requires a self root')
  const root=resolve(selfRoot),registryPath=join(root,'lenses'),records=[]
  if(existsSync(registryPath)){
    const stat=lstatSync(registryPath)
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`unsafe lens registry directory: ${registryPath}`)
    for(const name of readdirSync(registryPath).filter(name=>name.toLowerCase().endsWith('.json')).sort((a,b)=>a.localeCompare(b))){
      const path=join(registryPath,name),entry=lstatSync(path)
      if(entry.isSymbolicLink()||!entry.isFile())throw new Error(`unsafe lens registry entry: ${path}`)
      const raw=readFileSync(path,'utf8');let parsed
      try{parsed=JSON.parse(raw)}catch(error){fail(name,`malformed JSON (${error.message})`)}
      records.push({name,raw,lens:validateDefinition(parsed,name)})
    }
  }
  const instructionsPath=join(registryPath,'instructions'),instructionRecords=[];if(existsSync(instructionsPath))for(const name of readdirSync(instructionsPath).filter(name=>name.endsWith('.json')).sort()){const path=join(instructionsPath,name),raw=readFileSync(path,'utf8');let parsed;try{parsed=JSON.parse(raw)}catch(error){throw new Error(`invalid lens instructions ${name}: ${error.message}`)}instructionRecords.push({id:name.slice(0,-5),raw,instructions:validateInstructions(parsed,name)})}const overrides=new Map(instructionRecords.map(item=>[item.id,item.instructions])),builtins=BUILTIN_LENSES.map(lens=>Object.freeze({...lens,instructions:Object.freeze(overrides.get(lens.id)||lens.instructions)})),custom=records.map(record=>Object.freeze({...record.lens,instructions:Object.freeze(overrides.get(record.lens.id)||record.lens.instructions)})).sort((a,b)=>a.id.localeCompare(b.id)),byId=new Map(builtins.map(lens=>[lens.id,lens]));for(const lens of custom){if(byId.has(lens.id))throw new Error(`duplicate lens id ${lens.id}`);byId.set(lens.id,lens)}for(const id of overrides.keys())if(!byId.has(id))throw new Error(`lens instructions reference unknown lens ${id}`);const registry_hash=sha(JSON.stringify([...records.map(record=>[record.name,sha(record.raw)]),...instructionRecords.map(record=>[`instructions/${record.id}.json`,sha(record.raw)])]));return Object.freeze({root,registry_path:registryPath,registry_hash,builtins:Object.freeze(builtins),custom:Object.freeze(custom),lenses:Object.freeze([...builtins,...custom]),byId})
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
  try{writeFileSync(tmp,JSON.stringify({schema_version:1,id:lens.id,title:lens.title,base_lens:lens.base_lens,sensitivity_access:[...lens.sensitivity_access],instructions:lens.instructions},null,2)+'\n');renameSync(tmp,path);loadLensRegistry(selfRoot)}finally{if(existsSync(tmp))rmSync(tmp,{force:true})}
  return loadLensRegistry(selfRoot)
}

export function saveLensInstructions(selfRoot,id,instructions,expectedHash){const registry=loadLensRegistry(selfRoot);if(expectedHash!==registry.registry_hash){const error=new Error('lens registry changed on disk');error.code='STALE_REGISTRY';error.current_hash=registry.registry_hash;throw error}if(!registry.byId.has(id))throw new Error('unknown lens');const value=validateInstructions(instructions,`${id}.json`),dir=join(registry.registry_path,'instructions'),path=join(dir,`${id}.json`);mkdirSync(dir,{recursive:true});const tmp=`${path}.tmp-${process.pid}`;try{writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');renameSync(tmp,path)}finally{if(existsSync(tmp))rmSync(tmp)}return loadLensRegistry(selfRoot)}

export function removeCustomLens(selfRoot,id,expectedHash){
  const registry=loadLensRegistry(selfRoot)
  if(expectedHash!==registry.registry_hash){const error=new Error('lens registry changed on disk');error.code='STALE_REGISTRY';error.current_hash=registry.registry_hash;throw error}
  if(BUILTIN_BY_ID.has(id))throw new Error('built-in lenses cannot be removed')
  if(!registry.custom.some(lens=>lens.id===id))throw new Error('custom lens not found')
  rmSync(join(registry.registry_path,`${id}.json`));return loadLensRegistry(selfRoot)
}

export function lensIdStructurallyValid(id){return typeof id==='string'&&id.length<=40&&LENS_ID_PATTERN.test(id)}
