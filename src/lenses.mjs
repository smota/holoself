import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
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
export const BUILTIN_LENS_IDS=['general','career','publishing','technical','leadership','interview','private']
export const BUILTIN_LENSES=BUILTIN_LENS_IDS.map(id=>Object.freeze({schema_version:1,id,title:TITLES[id],source:'builtin',base_lens:id,sensitivity_access:Object.freeze([...BUILTIN_SENSITIVITY_ACCESS[id]])}))
const BUILTIN_BY_ID=new Map(BUILTIN_LENSES.map(lens=>[lens.id,lens]))
const sha=text=>createHash('sha256').update(text).digest('hex')
const fail=(file,message)=>{throw new Error(`invalid lens definition ${file}: ${message}`)}

function validateDefinition(value,file){
  if(!value||Array.isArray(value)||typeof value!=='object')fail(file,'must be an object')
  const allowed=new Set(['schema_version','id','title','base_lens','sensitivity_access'])
  for(const key of Object.keys(value))if(!allowed.has(key))fail(file,`unknown field ${key}`)
  for(const key of ['schema_version','id','title','base_lens'])if(!Object.hasOwn(value,key))fail(file,`missing ${key}`)
  if(value.schema_version!==1)fail(file,'schema_version must be 1')
  if(typeof value.id!=='string'||value.id.length>40||!LENS_ID_PATTERN.test(value.id))fail(file,'id must be lowercase kebab-case, start with a letter, and be at most 40 characters')
  if(BUILTIN_BY_ID.has(value.id))fail(file,`reserved built-in id ${value.id}`)
  if(typeof value.title!=='string'||!value.title.trim())fail(file,'title must be a non-empty string')
  if(!BUILTIN_BY_ID.has(value.base_lens))fail(file,'base_lens must be a built-in lens')
  const sensitivity=value.sensitivity_access??[]
  if(!Array.isArray(sensitivity)||new Set(sensitivity).size!==sensitivity.length||sensitivity.some(item=>!CUSTOM_SENSITIVITY_CATEGORIES.includes(item)))fail(file,'sensitivity_access must contain unique supported categories; restricted is not allowed')
  return Object.freeze({schema_version:1,id:value.id,title:value.title.trim(),source:'registry',base_lens:value.base_lens,sensitivity_access:Object.freeze([...sensitivity])})
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
  const custom=records.map(record=>record.lens).sort((a,b)=>a.id.localeCompare(b.id)),byId=new Map(BUILTIN_BY_ID)
  for(const lens of custom){if(byId.has(lens.id))throw new Error(`duplicate lens id ${lens.id}`);byId.set(lens.id,lens)}
  const registry_hash=sha(JSON.stringify(records.map(record=>[record.name,sha(record.raw)])))
  return Object.freeze({root,registry_path:registryPath,registry_hash,builtins:BUILTIN_LENSES,custom:Object.freeze(custom),lenses:Object.freeze([...BUILTIN_LENSES,...custom]),byId})
}

export function resolveLens(registry,id){
  if(!registry?.byId)throw new Error('lens registry is not loaded')
  if(typeof id!=='string'||id.length>40||!LENS_ID_PATTERN.test(id))throw new Error(`invalid lens id: ${id}`)
  const lens=registry.byId.get(id)
  if(!lens)throw new Error(`unknown lens: ${id}`)
  return lens
}

export function lensIdStructurallyValid(id){return typeof id==='string'&&id.length<=40&&LENS_ID_PATTERN.test(id)}
