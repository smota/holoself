import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { loadLensRegistry, resolveLens } from './lenses.mjs'

export function normalizeProjectPath(value){
 if(typeof value!=='string'||!value.trim())throw new Error('binding project path must be absolute')
 if(win32.isAbsolute(value)&&(/^[a-z]:[\\/]/i.test(value)||value.startsWith('\\\\')||value.startsWith('//')))return win32.normalize(value).replaceAll('\\','/').replace(/\/$/,'').toLowerCase()
 if(!isAbsolute(value))throw new Error('binding project path must be absolute')
 return resolve(value).replaceAll('\\','/')
}
export const bindingsPath=root=>join(resolve(root),'lenses','bindings.json')
const hash=value=>createHash('sha256').update(value).digest('hex')
function assertSafe(path){let current=path;while(true){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error(`unsafe bindings path: ${current}`);const parent=dirname(current);if(parent===current)break;current=parent}}
export function validateBinding(value,registry){
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!['default_lens','secondary_lenses'].includes(key)))throw new Error('invalid lens binding fields')
 if(typeof value.default_lens!=='string'||!Array.isArray(value.secondary_lenses))throw new Error('lens binding requires default_lens and secondary_lenses')
 const ids=[value.default_lens,...value.secondary_lenses];if(ids.includes('private'))throw new Error('private is owner-exclusive');if(new Set(ids).size!==ids.length)throw new Error('lens binding contains duplicate lenses')
 for(const id of ids)resolveLens(registry,id)
 return {default_lens:value.default_lens,secondary_lenses:[...value.secondary_lenses]}
}
export function readBindings(root,{registry=loadLensRegistry(root)}={}){
 const path=bindingsPath(root);assertSafe(path);let raw=null,value={schema_version:1,bindings:{}}
 if(existsSync(path)){raw=readFileSync(path,'utf8');try{value=JSON.parse(raw)}catch{throw new Error('malformed lenses/bindings.json') }}
 if(!value||value.schema_version!==1||Object.keys(value).some(key=>!['schema_version','bindings'].includes(key))||!value.bindings||Array.isArray(value.bindings)||typeof value.bindings!=='object')throw new Error('invalid lenses/bindings.json schema')
 const bindings=Object.create(null)
 for(const [project,binding] of Object.entries(value.bindings)){const key=normalizeProjectPath(project);if(Object.hasOwn(bindings,key))throw new Error(`conflicting normalized lens bindings: ${key}`);bindings[key]=validateBinding(binding,registry)}
 return {schema_version:1,bindings,hash:hash(raw||'')}
}
export function resolveBinding(root,project,options={}){
 const key=normalizeProjectPath(project),binding=readBindings(root,options).bindings[key]
 if(!binding){const error=new Error(`No self-side lens binding for ${key}. Run holoself lens bind --root <self-root> --project <project> --lens <lens> --yes`);error.code='LENS_BINDING_REQUIRED';throw error}
 return binding
}
export function writeBinding(root,project,value,{expectedHash}={}){
 const store=readBindings(root),key=normalizeProjectPath(project);if(expectedHash!==undefined&&expectedHash!==store.hash)throw new Error('lens bindings changed on disk')
 if(value===null)delete store.bindings[key];else store.bindings[key]=validateBinding(value,loadLensRegistry(root))
 const path=bindingsPath(root);assertSafe(path);mkdirSync(dirname(path),{recursive:true});const temp=`${path}.tmp-${process.pid}`
 try{writeFileSync(temp,JSON.stringify({schema_version:1,bindings:store.bindings},null,2)+'\n',{flag:'wx'});renameSync(temp,path)}finally{if(existsSync(temp))rmSync(temp)}
 return readBindings(root)
}
