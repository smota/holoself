import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { validateAnnotationMetadata } from './annotations.mjs'

const ROOTS = new Set(['profile','context','topics','reference','me','contribs'])
const hash = value => createHash('sha256').update(value).digest('hex')
export const ANNOTATION_FIELDS={schema_version:'number',access_lenses:'array',disclosure:'string',sensitivity:'string',document_role:'string',confidence:'string',visibility:'string',public_safe:'boolean'}
function parseValue(value){const text=value.trim();if(/^\[.*\]$/.test(text))return text.slice(1,-1).split(',').map(item=>item.trim()).filter(Boolean);if(text==='true'||text==='false')return text==='true';if(/^\d+$/.test(text))return Number(text);return text.replace(/^['"]|['"]$/g,'')}
function formatValue(value){if(Array.isArray(value))return `[${value.join(', ')}]`;if(typeof value==='boolean')return String(value);return String(value)}
export function parseAnnotatedMarkdown(content){const normalized=content.replaceAll('\r\n','\n'),match=normalized.match(/^---\n([\s\S]*?)\n---\n?/),frontmatter=match?match[1].split('\n'):[],body=match?normalized.slice(match[0].length):normalized,metadata={},unknown=[];for(const line of frontmatter){const found=line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);if(!found){unknown.push(line);continue}if(Object.hasOwn(ANNOTATION_FIELDS,found[1]))metadata[found[1]]=parseValue(found[2]);else unknown.push(line)}const markers=[...body.matchAll(/<!--\s*(\/?)os-section(?::\s*([a-zA-Z0-9_-]+))?\s*-->/g)],segments=[];if(!markers.length)segments.push({annotation:null,marker:null,content:body});else{if(markers[0].index>0)segments.push({annotation:null,marker:null,content:body.slice(0,markers[0].index)});for(let index=0;index<markers.length;index++){const marker=markers[index],nextIndex=markers[index+1]?.index??body.length;segments.push({annotation:marker[1]?`end:${marker[2]||''}`:marker[2],marker:marker[0],content:body.slice(marker.index+marker[0].length,nextIndex)})}}return {metadata,unknownMetadata:unknown,segments}}
function serializeAnnotated(original,metadata,segments,{knownLenses=[]}={}){const parsed=parseAnnotatedMarkdown(original),merged={...parsed.metadata,...metadata};for(const [key,value] of Object.entries(merged))if(value===null)delete merged[key];if(!Number.isInteger(merged.schema_version)||merged.schema_version<1)throw new Error('schema_version must be a positive integer');const policy=validateAnnotationMetadata(merged,knownLenses,{allowLegacy:true});if(!policy.valid)throw new Error(policy.errors.join(' '));const known=Object.keys(ANNOTATION_FIELDS).filter(key=>merged[key]!==undefined).map(key=>`${key}: ${formatValue(merged[key])}`),frontmatter=['---',...known,...parsed.unknownMetadata,'---',''].join('\n');if(!Array.isArray(segments)||segments.some(segment=>!segment||typeof segment.content!=='string'||(segment.annotation!==null&&typeof segment.annotation!=='string')))throw new Error('annotated sections are invalid');const originalMarkers=parsed.segments.map(segment=>segment.marker).filter(Boolean),nextMarkers=segments.map(segment=>segment.marker).filter(Boolean);if(JSON.stringify(originalMarkers)!==JSON.stringify(nextMarkers))throw new Error('section annotations cannot be added, removed, or reordered in the content editor');const body=segments.map(segment=>`${segment.marker||''}${segment.content}`).join('');return frontmatter+body}
function safe(root, name, { missing=false }={}) {
  if (typeof name !== 'string' || !name.endsWith('.md')) throw new Error('document path must be a Markdown file')
  const base=resolve(root), path=resolve(base,name), rel=relative(base,path)
  if (!rel || rel.startsWith('..'+sep) || rel==='..' || !ROOTS.has(rel.split(sep)[0]) || (rel.split(sep)[0]==='contribs'&&rel.split(sep)[1]!=='local')) throw new Error('document path escapes editable knowledge')
  let cursor=base
  for(const part of rel.split(sep)){ cursor=join(cursor,part); if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink()) throw new Error('document path contains a symlink') }
  if(!missing && (!existsSync(path)||!lstatSync(path).isFile())) throw new Error('document not found')
  return {path,relative:rel.replaceAll('\\','/')}
}
export function listDocuments(root){
  const out=[]
  for(const top of ['profile','context','topics','reference','me','contribs/local']){
    const base=join(resolve(root),top);if(!existsSync(base))continue
    const walk=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(p);else if(e.isFile()&&e.name.endsWith('.md')){const text=readFileSync(p,'utf8'),s=lstatSync(p);out.push({path:relative(resolve(root),p).replaceAll('\\','/'),bytes:s.size,modified_at:s.mtime.toISOString(),hash:hash(text)})}}};walk(base)
  } return out.sort((a,b)=>a.path.localeCompare(b.path))
}
export function readDocument(root,name){const item=safe(root,name);const content=readFileSync(item.path,'utf8');return {...item,content,annotations:parseAnnotatedMarkdown(content),hash:hash(content)}}
export async function saveAnnotatedDocument(root,name,{metadata,segments,expectedHash},{validate,knownLenses=[]}={}){const item=safe(root,name),original=readFileSync(item.path,'utf8'),content=serializeAnnotated(original,metadata,segments,{knownLenses});return saveDocument(root,name,content,expectedHash,{validate})}
export async function saveDocument(root,name,content,expectedHash,{validate}={}){
  if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)throw new Error('document must be text no larger than 2 MiB')
  const item=safe(root,name,{missing:true}),existed=existsSync(item.path),before=existed?readFileSync(item.path):null,current=existed?hash(before):'missing'
  if(expectedHash!==current){const e=new Error('document changed on disk');e.code='STALE_DOCUMENT';e.current_hash=current;throw e}
  mkdirSync(dirname(item.path),{recursive:true});const tmp=`${item.path}.tmp-${process.pid}`
  try{
    writeFileSync(tmp,content,'utf8');renameSync(tmp,item.path)
    if(validate)await validate()
  }catch(error){
    if(existed){writeFileSync(tmp,before);renameSync(tmp,item.path)}else rmSync(item.path,{force:true})
    const wrapped=new Error(`document validation failed; original content restored: ${error.message}`);wrapped.code='DOCUMENT_INVALID';throw wrapped
  }finally{if(existsSync(tmp))rmSync(tmp,{force:true})}
  return {...item,hash:hash(content),bytes:Buffer.byteLength(content)}
}
