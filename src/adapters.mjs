import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const LINK_START='<!-- holoself-link-start schema=1 -->'
export const LINK_END='<!-- holoself-link-end -->'
const SKILL_START='<!-- holoself-skill-start schema=1 -->'
const SKILL_END='<!-- holoself-skill-end -->'
const SKILL_BLOCK=`${SKILL_START}
# Linked Holoself

Read \`.holoself/BOOTSTRAP.md\` before substantive work. Use installed public Holoself skill when available. Resolve context through configured lens, preserve provenance and project ownership, and create proposals instead of editing canonical self directly.
${SKILL_END}
`
const NEW_SKILL=`---
name: holoself
description: Load linked whole-person context for this project.
---

${SKILL_BLOCK}`
const REGISTRY=[
  {id:'agents',name:'Generic AGENTS',files:['AGENTS.md'],dirs:[],support:'native',skillDirs:['.agents/skills/holoself']},
  {id:'claude',name:'Claude Code',files:['CLAUDE.md'],dirs:['.claude'],support:'native',skillDirs:['.claude/skills/holoself']},
  {id:'codex',name:'Codex',files:['CODEX.md','codex.md'],dirs:['.codex'],support:'native',skillDirs:[]},
  {id:'pi',name:'Pi',files:['PI.md'],dirs:['.pi'],support:'native',skillDirs:['.pi/skills/holoself']},
  {id:'agy',name:'AGY',files:['AGY.md'],dirs:['.agy'],support:'native',skillDirs:[]},
  {id:'antigravity',name:'Antigravity',files:['ANTIGRAVITY.md'],dirs:['.antigravity'],support:'native',skillDirs:[]},
  {id:'gemini',name:'Gemini CLI',files:['GEMINI.md'],dirs:['.gemini'],support:'native',skillDirs:[]},
  {id:'copilot',name:'GitHub Copilot',files:['.github/copilot-instructions.md'],dirs:['.github'],support:'native',skillDirs:[]},
  {id:'cursor',name:'Cursor',files:['.cursor/rules/holoself.mdc'],dirs:['.cursor'],support:'native',skillDirs:[]},
  {id:'windsurf',name:'Windsurf',files:['.windsurfrules'],dirs:['.windsurf'],support:'native',skillDirs:[]},
]
function slash(p){return p.replaceAll('\\','/')}
function ensureDir(p){mkdirSync(p,{recursive:true})}
function atomicWrite(p,content){ensureDir(dirname(p));const t=`${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;try{writeFileSync(t,content,'utf8');renameSync(t,p)}finally{if(existsSync(t))rmSync(t,{force:true})}}
function contained(root,path){const rel=relative(root,path);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel))}
export function safeProjectFile(project,rel,label='managed path'){
  if(typeof rel!=='string'||!rel.trim()||isAbsolute(rel))throw new Error(`${label} must be a project-relative path: ${rel}`)
  const lexicalRoot=resolve(project),target=resolve(lexicalRoot,rel);if(!contained(lexicalRoot,target))throw new Error(`${label} escapes project: ${rel}`)
  const rootReal=realpathSync(lexicalRoot);let current=target
  const chain=[];while(current!==lexicalRoot){chain.push(current);current=dirname(current)}
  for(const item of chain.reverse()){if(!existsSync(item))continue;const stat=lstatSync(item);if(stat.isSymbolicLink())throw new Error(`${label} traverses symlink: ${item}`);const actual=realpathSync(item);if(!contained(rootReal,actual))throw new Error(`${label} escapes real project root: ${item}`)}
  return target
}
function evidence(project,adapter){return adapter.files.some(f=>existsSync(safeProjectFile(project,f,'adapter evidence')))||adapter.dirs.some(d=>existsSync(safeProjectFile(project,d,'adapter evidence')))}
export function detectAdapters(project){return REGISTRY.map(a=>({...a,detected:a.id==='agents'||evidence(project,a)}))}
function parseSelection(value){if(!value||value==='auto')return {mode:'auto',ids:[]};if(value==='all')return {mode:'all',ids:[]};return {mode:'list',ids:value.split(',').map(x=>x.trim()).filter(Boolean)}}
function unique(items){return [...new Set(items)]}
function instructionIdentity(project,rel){let path;try{path=safeProjectFile(project,rel,'instruction identity')}catch{const unsafe=resolve(project,rel);return `unsafe:${process.platform==='win32'?unsafe.toLowerCase():unsafe}`}const identity=existsSync(path)?realpathSync(path):resolve(path);return process.platform==='win32'?identity.toLowerCase():identity}
function uniqueInstructionFiles(project,items){const seen=new Set(),result=[];for(const item of items){const identity=instructionIdentity(project,item);if(seen.has(identity))continue;seen.add(identity);result.push(item)}return result}
export function activationPlan(project,options={}){
  if(options.installSkill&&!['auto','project','none'].includes(options.installSkill))throw new Error(`invalid --install-skill value: ${options.installSkill}`)
  const detected=detectAdapters(project),selection=parseSelection(options.activate)
  let adapters=selection.mode==='all'?detected:selection.mode==='list'?detected.filter(a=>selection.ids.includes(a.id)):detected.filter(a=>a.detected)
  const explicit=(options.platforms||[]).flatMap(x=>x.split(',')).map(x=>x.trim()).filter(Boolean);if(explicit.length)adapters=detected.filter(a=>explicit.includes(a.id))
  const unknown=unique([...(selection.mode==='list'?selection.ids:[]),...explicit].filter(id=>!REGISTRY.some(a=>a.id===id)));if(unknown.length)throw new Error(`unknown platform adapter: ${unknown.join(', ')}`)
  if(!adapters.some(a=>a.id==='agents'))adapters.unshift(detected.find(a=>a.id==='agents'))
  const canonical=slash(options.instructions||'AGENTS.md');safeProjectFile(project,canonical,'canonical instructions')
  const mapped=adapters.map(a=>({id:a.id,name:a.name,support:a.support,detected:a.detected,file:slash(a.id==='agents'?canonical:(a.files.find(f=>existsSync(safeProjectFile(project,f,'adapter instructions')))||a.files[0])),skillDirs:a.skillDirs}))
  const install=options.installSkill||'auto',skills=[]
  if(install!=='none')for(const adapter of mapped)for(const dir of adapter.skillDirs){const file=slash(join(dir,'SKILL.md'));if(install==='project'||existsSync(dirname(safeProjectFile(project,file,'skill shim')))||adapter.id==='agents')skills.push({adapter:adapter.id,file})}
  return {canonical,adapters:mapped,skills,writes:unique(['.holoself/BOOTSTRAP.md','.holoself/runtime.json',...mapped.map(x=>x.file),...skills.map(x=>x.file)])}
}
function canonicalSection(){return `${LINK_START}
## Linked Holoself context

Before substantive work:

1. Read \`.holoself/BOOTSTRAP.md\`.
2. Resolve linked self through configured lens and privacy policy.
3. Preserve source provenance and project ownership.
4. Never modify canonical self directly; use proposal/review.

Use Holoself skill when available.
${LINK_END}
`}
function overlaySection(canonical){return `${LINK_START}
## Linked Holoself context

Load \`${canonical}\`, then \`.holoself/BOOTSTRAP.md\`, before substantive work. Use Holoself skill when available.
${LINK_END}
`}
function markerInfo(text,start=LINK_START,end=LINK_END){const starts=[];const ends=[];let i=-1;while((i=text.indexOf(start,i+1))>=0)starts.push(i);i=-1;while((i=text.indexOf(end,i+1))>=0)ends.push(i);if(!starts.length&&!ends.length)return {state:'inactive'};if(starts.length!==1||ends.length!==1||ends[0]<starts[0])return {state:'malformed'};const finish=ends[0]+end.length;return {state:'active',start:starts[0],end:finish,block:text.slice(starts[0],finish)}}
function managedBlockHash(text){const info=markerInfo(text);return info.state==='active'?createHash('sha256').update(info.block).digest('hex'):null}
export function managedMarkerState(path){if(!existsSync(path))return 'missing';if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())return 'unsafe';return markerInfo(readFileSync(path,'utf8')).state}
function nextMarkedContent(old,section){const info=markerInfo(old);if(info.state==='malformed')throw new Error('malformed Holoself markers');return info.state==='active'?old.slice(0,info.start)+section.trimEnd()+old.slice(info.end):(old.trimEnd()?old.trimEnd()+'\n\n':'')+section}
export function injectMarker(project,rel,section,dryRun=false){const p=safeProjectFile(project,rel,'instruction write'),state=managedMarkerState(p);if(state==='unsafe'||state==='malformed')throw new Error(`${p} has unsafe or malformed Holoself markers`);const existed=existsSync(p),old=existed?readFileSync(p,'utf8'):'',next=nextMarkedContent(old,section);if(!dryRun&&next!==old)atomicWrite(p,next);return next===old?'unchanged':state==='active'?'updated':existed?'appended':'created'}
export function removeMarker(project,rel,dryRun=false){const p=safeProjectFile(project,rel,'instruction removal'),state=managedMarkerState(p);if(state==='missing'||state==='inactive')return 'unchanged';if(state!=='active')throw new Error(`${p} has unsafe or malformed Holoself markers`);const old=readFileSync(p,'utf8'),info=markerInfo(old),next=(old.slice(0,info.start)+old.slice(info.end)).replace(/\n{3,}/g,'\n\n').trimEnd()+'\n';if(!dryRun)atomicWrite(p,next);return 'removed'}
function skillState(path){if(!existsSync(path))return 'missing';if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())return 'unsafe';return markerInfo(readFileSync(path,'utf8'),SKILL_START,SKILL_END).state}
function nextSkillContent(old){const info=markerInfo(old,SKILL_START,SKILL_END);if(info.state==='malformed')throw new Error('malformed Holoself skill markers');if(info.state==='active')return old.slice(0,info.start)+SKILL_BLOCK.trimEnd()+old.slice(info.end);return old?null:NEW_SKILL}
function writeSkill(project,rel,dryRun=false,force=false){const p=safeProjectFile(project,rel,'skill shim write'),state=skillState(p);if(['unsafe','malformed'].includes(state))throw new Error(`${p} has unsafe or malformed Holoself skill markers`);const old=existsSync(p)?readFileSync(p,'utf8'):'',generated=nextSkillContent(old),next=generated===null&&force?old.trimEnd()+'\n\n'+SKILL_BLOCK:generated;if(next===null)throw new Error(`existing skill shim collision: ${p}; use --force --yes to append managed shim or choose --install-skill none`);if(!dryRun&&next!==old)atomicWrite(p,next);return next===old?'unchanged':state==='active'?'updated':old?'appended':'created'}
function removeSkill(project,rel,dryRun=false){const p=safeProjectFile(project,rel,'skill shim removal'),state=skillState(p);if(['missing','inactive'].includes(state))return 'unchanged';if(state!=='active')throw new Error(`${p} has unsafe or malformed Holoself skill markers`);const old=readFileSync(p,'utf8'),info=markerInfo(old,SKILL_START,SKILL_END),next=(old.slice(0,info.start)+old.slice(info.end)).trimEnd()+'\n';if(!dryRun)atomicWrite(p,next);return 'removed'}
export function bootstrapText(link){return `# Linked Holoself context

This project links to canonical whole-person context. This file contains no canonical personal data.

## Startup

1. Read \`.holoself/link.yaml\`.
2. Resolve \`self_context.path\` and validate Holoself root.
3. Load self context through default lens \`${link.default_lens}\`.
4. Apply visibility, sensitivity, and field restrictions before output.
5. Preserve source provenance and project-owned artifacts.
6. Never write canonical self directly. Submit reusable discoveries through proposals.

## Runtime

Preferred when command execution is available: \`holoself context --project . --json\`.

If CLI is unavailable, use installed Holoself skill. If external paths are inaccessible, use reviewed \`.holoself/runtime/context-packet.md\`; snapshots are not live context.

## Ownership

Projects own execution artifacts. Self owns approved reusable personal knowledge.
`}
function runtimeFile(project){return safeProjectFile(project,'.holoself/runtime.json','runtime write')}
export function readRuntime(project){try{return JSON.parse(readFileSync(runtimeFile(project),'utf8'))}catch{return null}}
function preflight(project,plan,options={}){
  const collisions=[]
  for(const adapter of plan.adapters){const p=safeProjectFile(project,adapter.file,'instruction preflight'),state=managedMarkerState(p);if(['unsafe','malformed'].includes(state))collisions.push(`${p}: ${state}`)}
  for(const skill of plan.skills){const p=safeProjectFile(project,skill.file,'skill preflight'),state=skillState(p);if(['unsafe','malformed'].includes(state)||(state==='inactive'&&!options.force))collisions.push(`${p}: ${state==='inactive'?'existing unmanaged content (use --force --yes to append managed shim)':state}`)}
  for(const rel of ['.holoself/BOOTSTRAP.md','.holoself/runtime.json']){const p=safeProjectFile(project,rel,'activation artifact');if(existsSync(p)&&!lstatSync(p).isFile())collisions.push(`${p}: not a regular file`)}
  if(collisions.length)throw new Error(`activation preflight failed: ${collisions.join('; ')}`)
  return {plan,collisions:[],writes:plan.writes}
}
export function preflightActivation(project,options={}){const plan=activationPlan(project,options);return preflight(project,plan,options)}
function snapshotPaths(project,rels){return rels.map(rel=>{const path=safeProjectFile(project,rel,'transaction path');return {path,exists:existsSync(path),content:existsSync(path)&&lstatSync(path).isFile()?readFileSync(path):null}})}
function rollback(snapshots){for(const item of snapshots.reverse()){try{if(item.exists&&item.content!==null)atomicWrite(item.path,item.content);else if(!item.exists&&existsSync(item.path))rmSync(item.path,{force:true})}catch{}}}
export function activateProject(project,link,options={}){
  const plan=activationPlan(project,options);preflight(project,plan,options);if(options.dryRun)return {plan,results:plan.adapters.map(x=>({...x,result:'planned'})),skillResults:plan.skills.map(x=>({...x,result:'planned'})),runtime:null}
  const previousRuntime=readRuntime(project),previousOwnedSkills=new Map((previousRuntime?.skillShims||[]).map(x=>[x.file,Boolean(x.owned)])),snapshots=snapshotPaths(project,plan.writes),results=[],skillResults=[]
  try{
    atomicWrite(safeProjectFile(project,'.holoself/BOOTSTRAP.md','bootstrap write'),bootstrapText(link))
    for(const adapter of plan.adapters){const section=adapter.file===plan.canonical?canonicalSection():overlaySection(plan.canonical);results.push({...adapter,result:injectMarker(project,adapter.file,section,false)})}
    for(const skill of plan.skills)skillResults.push({...skill,result:writeSkill(project,skill.file,false,options.force===true)})
    const runtime={schemaVersion:1,project:basename(project),mode:'live-link',defaultLens:link.default_lens,activatedAdapters:results.map(x=>{const text=readFileSync(safeProjectFile(project,x.file,'runtime hash'),'utf8');return {id:x.id,file:x.file,status:'active',markerHash:managedBlockHash(text)}}),skillShims:skillResults.map(x=>({id:x.adapter,file:x.file,status:'active',owned:x.result==='created'||previousOwnedSkills.get(x.file)===true})),fallback:'.holoself/BOOTSTRAP.md',lastValidated:new Date().toISOString(),toolVersion:'0.6.0'}
    atomicWrite(runtimeFile(project),JSON.stringify(runtime,null,2)+'\n');return {plan,results,skillResults,runtime}
  }catch(error){rollback(snapshots);throw error}
}
function registryInstructionFiles(project){const runtime=readRuntime(project),tracked=new Set((runtime?.activatedAdapters||[]).map(x=>x.file)),files=uniqueInstructionFiles(project,[...tracked,...REGISTRY.flatMap(x=>x.files)]);return files.filter(rel=>{if(tracked.has(rel))return true;try{return !['missing','inactive'].includes(managedMarkerState(safeProjectFile(project,rel,'managed marker discovery')))}catch{return true}})}
function registrySkillFiles(project){const runtime=readRuntime(project),files=[...(runtime?.skillShims||[]).map(x=>x.file),...REGISTRY.flatMap(x=>x.skillDirs.map(dir=>slash(join(dir,'SKILL.md'))))];return unique(files)}
export function deactivateProject(project,options={}){const runtime=readRuntime(project),ownedSkills=new Map((runtime?.skillShims||[]).map(x=>[x.file,Boolean(x.owned)])),instructionFiles=registryInstructionFiles(project),skillFiles=registrySkillFiles(project),results=[];for(const file of instructionFiles){const state=managedMarkerState(safeProjectFile(project,file,'deactivation preflight'));if(['unsafe','malformed'].includes(state))throw new Error(`deactivation preflight failed: ${file}: ${state}`)}for(const file of skillFiles){const state=skillState(safeProjectFile(project,file,'skill deactivation preflight'));if(['unsafe','malformed'].includes(state))throw new Error(`deactivation preflight failed: ${file}: ${state}`)}for(const file of instructionFiles)results.push({file,result:removeMarker(project,file,options.dryRun)});for(const file of skillFiles){const path=safeProjectFile(project,file,'skill discovery'),state=skillState(path);if(state==='active'){const generatedOnly=readFileSync(path,'utf8').trim()===NEW_SKILL.trim();if(ownedSkills.get(file)||generatedOnly){if(!options.dryRun)rmSync(path,{force:true});results.push({file,result:'removed'})}else results.push({file,result:removeSkill(project,file,options.dryRun)})}}if(!options.dryRun&&existsSync(runtimeFile(project)))rmSync(runtimeFile(project));return results}
export function activationStatus(project){
  const runtime=readRuntime(project),bootstrap=existsSync(safeProjectFile(project,'.holoself/BOOTSTRAP.md','bootstrap status')),adapters=(runtime?.activatedAdapters||[]).map(a=>{const path=safeProjectFile(project,a.file,'activation status'),marker=managedMarkerState(path),actualHash=marker==='active'?managedBlockHash(readFileSync(path,'utf8')):null;return {...a,marker,actualHash,drift:marker==='active'&&a.markerHash!==actualHash}})
  const discovered=registryInstructionFiles(project).filter(file=>!adapters.some(a=>a.file===file)).map(file=>({file,marker:managedMarkerState(safeProjectFile(project,file,'activation discovery')),drift:true,status:'untracked'}));adapters.push(...discovered)
  const active=bootstrap&&adapters.length>0&&adapters.every(a=>a.marker==='active'&&!a.drift);return {runtime,bootstrap,adapters,active}
}
