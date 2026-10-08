import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync, mkdirSync, writeFileSync, chmodSync, unlinkSync, rmdirSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { preflightActivation, activateProject, deactivateProject, detectAdapters, readRuntime, recordedActivation, safeProjectFile } from './adapters.mjs'
import { spaceLinkConfiguration, readSpaceLink, configureSpaceLink, withSpaceConfigurationLock } from './ecosystem.mjs'
import { loadLensRegistry } from './lenses.mjs'

const actions=new Set(['activate','deactivate','relink','setup'])
const digest=value=>createHash('sha256').update(value).digest('hex')
const identity=path=>{const value=realpathSync(path);return process.platform==='win32'?value.toLowerCase():value}
function stat(path){try{return lstatSync(path)}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error}}
function state(path){const info=stat(path);if(!info)return {type:'absent'};if(info.isSymbolicLink())return {type:'link',target:readlinkSync(path),mode:info.mode};if(info.isDirectory())return {type:'directory',mode:info.mode};if(!info.isFile())throw new Error(`unsupported filesystem object: ${path}`);return {type:'file',mode:info.mode,hash:digest(readFileSync(path))}}
function changed(message='space action plan changed; review it again'){const error=new Error(message);error.code='PLAN_CHANGED';return error}
function metadataChild(path,metadata){return path.startsWith(metadata+sep)}
function safeRoot(root){for(const rel of ['profile','context','lenses','lenses/bindings.json','.holoself','.holoself/links.json','.holoself/links.json.lock'])safeProjectFile(root,rel,'space root metadata');if(!stat(join(root,'profile'))?.isDirectory()||!stat(join(root,'context'))?.isDirectory())throw new Error('space root lacks canonical profile/context layout')}

// Pure filesystem planning: no locks, reconciliation, temporary directories or CLI calls.
export function planSpaceAction({root,project,action,lens='general'},{absentRegistryParent=false}={}){
  if(!actions.has(action))throw new Error(`unsupported space action: ${action}`)
  root=realpathSync(resolve(root));project=realpathSync(resolve(project));safeRoot(root)
  if(identity(root)===identity(project))throw new Error('a canonical root cannot be its own linked space')
  const metadata=join(project,'.holoself'),metadataState=state(metadata),legacy=metadataState.type==='link'
  if(legacy&&(action!=='setup'||identity(metadata)!==identity(root)))throw new Error('setup requires a legacy junction pointing exactly to this canonical root')
  if(!legacy)safeProjectFile(project,'.holoself','space metadata')
  const configuration=['setup','relink'].includes(action)?spaceLinkConfiguration(project,root,{lens,metadataAbsent:legacy}):null
  const link=configuration?.link||readSpaceLink(project)
  if(!configuration&&identity(link.path)!==identity(root))throw new Error('linked space does not belong to this canonical root')
  const runtime=legacy?null:readRuntime(project),selection=recordedActivation(project,runtime)
  const options={activate:selection.ids.join(','),instructions:runtime?.activatedAdapters?.find(x=>x.id==='agents')?.file||'AGENTS.md',installSkill:runtime?.skillInstallPolicy||'auto'}
  let activation=null,deactivation=null
  if(action!=='deactivate')activation=preflightActivation(project,{...options,metadataAbsent:legacy}).plan
  else deactivation=deactivateProject(project,{dryRun:true})
  const mutations=new Map(),inputs=new Map(),registryParent=join(root,'.holoself')
  const inputState=path=>absentRegistryParent&&path===registryParent?{type:'absent'}:state(path)
  const virtual=path=>legacy&&metadataChild(path,metadata)
  const remember=path=>{path=resolve(path);inputs.set(path,virtual(path)?{type:'absent'}:inputState(path));return path}
  const add=(path,operation)=>{path=remember(path);mutations.set(path,{path,operation});let parent=dirname(path);while(parent!==project&&parent!==root&&parent!==dirname(parent)){if(legacy&&parent===metadata){mutations.set(parent,{path:parent,operation:'replace junction with directory'});break}const value=inputState(parent);if(value.type==='absent')mutations.set(parent,{path:parent,operation:'create directory'});else if(value.type!=='directory')throw new Error(`unsafe mutation ancestor: ${parent}`);inputs.set(parent,value);parent=dirname(parent)}}
  remember(metadata)
  for(const rel of ['.holoself/link.yaml','.holoself/runtime.json'])remember(join(project,rel))
  for(const rel of ['lenses/bindings.json','.holoself/links.json'])remember(join(root,rel))
  if(configuration){
    for(const rel of ['.holoself/catalog','.holoself/proposals','.holoself/reports']){const path=join(project,rel);if(virtual(path)||!stat(path))add(path,'create directory')}
    if(legacy||!stat(join(metadata,'README.md')))add(join(metadata,'README.md'),'create file')
    for(const path of [join(metadata,'link.yaml'),join(root,'lenses/bindings.json'),join(root,'.holoself/links.json')])add(path,'write file')
  }
  if(activation){for(const rel of activation.writes)add(join(project,rel),'write file');for(const item of activation.globalSkills||[])remember(item.path)}
  if(deactivation){for(const item of deactivation)if(item.file&&item.result!=='unchanged'&&item.result!=='not-active')add(join(project,item.file),'remove managed content');if(stat(join(metadata,'runtime.json')))add(join(metadata,'runtime.json'),'delete file')}
  // All adapter candidates and skill directories are read dependencies, including absent ones.
  for(const adapter of detectAdapters(project))for(const rel of [...adapter.files,...adapter.dirs,...adapter.skillDirs,...adapter.skillDirs.map(dir=>join(dir,'SKILL.md'))])remember(safeProjectFile(project,rel,'space adapter dependency'))
  for(const item of mutations.values())if(!virtual(item.path)&&item.path!==metadata){const owner=item.path.startsWith(root+sep)?root:project;safeProjectFile(owner,relative(owner,item.path),'space mutation')}
  const files=[...mutations.values()].sort((a,b)=>a.path.localeCompare(b.path)),dependencies=[...inputs].map(([path,before])=>({path,...before})).sort((a,b)=>a.path.localeCompare(b.path))
  const plan={schema_version:1,action,root,project,legacy,configuration,options,activation,files,dependencies,lens_registry_hash:loadLensRegistry(root).registry_hash,transient_files:configuration?[join(root,'.holoself/links.json.lock')]:[]}
  return {...plan,plan_hash:digest(JSON.stringify(plan))}
}

function snapshot(plan){return plan.files.map(item=>{const before=plan.dependencies.find(x=>x.path===item.path)||state(item.path);return {...item,before,content:before.type==='file'?readFileSync(item.path):null}})}
function restore(snapshots,{lockedParent,plan}={}){
  const metadata=join(plan.project,'.holoself'),junction=stat(metadata)?.isSymbolicLink()
  if(junction&&(!plan.legacy||readlinkSync(metadata)!==plan.dependencies.find(x=>x.path===metadata)?.target))throw new Error('refusing rollback through unexpected metadata junction')
  const failures=[]
  for(const item of [...snapshots].sort((a,b)=>b.path.length-a.path.length))try{
    if(item.path===lockedParent&&item.before.type==='absent')continue
    if(junction&&(item.path===metadata||metadataChild(item.path,metadata)))continue
    if(item.path!==metadata){const owner=item.path.startsWith(plan.root+sep)?plan.root:plan.project;safeProjectFile(owner,relative(owner,item.path),'rollback path')}
    const current=stat(item.path)
    if(item.before.type==='file'){if(current?.isSymbolicLink()||current?.isDirectory())throw new Error(`refusing unsafe rollback replacement: ${item.path}`);mkdirSync(dirname(item.path),{recursive:true});writeFileSync(item.path,item.content);chmodSync(item.path,item.before.mode)}
    else if(item.before.type==='absent'&&current){if(current.isSymbolicLink()||current.isFile())unlinkSync(item.path);else if(current.isDirectory())rmdirSync(item.path);else throw new Error(`unexpected rollback object: ${item.path}`)}
    else if(item.before.type==='link'){if(current?.isDirectory())rmdirSync(item.path);else if(current)throw new Error(`refusing to replace unexpected junction state: ${item.path}`);symlinkSync(item.before.target,item.path,process.platform==='win32'?'junction':'dir')}
  }catch(error){failures.push(error.message)}
  if(failures.length)throw new Error(`space action rollback incomplete: ${failures.join('; ')}`)
}
// Shared by HTTP space mutations; an error must not poison the next queued request.
let queue=Promise.resolve()
export function serializeSpaceMutation(operation){const result=queue.then(operation);queue=result.catch(()=>{});return result}
export function applySpaceAction(request,planHash,{afterConfigure}={}){
  return serializeSpaceMutation(async()=>{
    if(typeof planHash!=='string'||!planHash)throw changed('missing plan hash; review the space action first')
    const checked=(options)=>{let plan;try{plan=planSpaceAction(request,options)}catch(error){throw changed(`space action preconditions changed: ${error.message}`)}if(plan.plan_hash!==planHash){const error=changed();error.current_hash=plan.plan_hash;throw error}return plan}
    const initial=checked(),registryParent=join(initial.root,'.holoself'),absentRegistryParent=initial.dependencies.some(x=>x.path===registryParent&&x.type==='absent')
    const perform=()=>{
      const plan=checked({absentRegistryParent}),snapshots=snapshot(plan)
      try{
        if(plan.legacy)unlinkSync(join(plan.project,'.holoself'))
        const link=plan.configuration?configureSpaceLink(plan.project,plan.root,plan.configuration):readSpaceLink(plan.project)
        // Internal synchronous dependency seam for deterministic recovery verification.
        if(afterConfigure)afterConfigure(plan)
        if(plan.action==='deactivate')deactivateProject(plan.project)
        else activateProject(plan.project,link,plan.options)
        return {output:`${plan.action} applied to ${plan.project}`,plan_hash:planHash,files:plan.files}
      }catch(error){try{restore(snapshots,{lockedParent:plan.configuration?registryParent:undefined,plan})}catch(recovery){throw new AggregateError([error,recovery],`${error.message}; ${recovery.message}`)}throw error}
    }
    try{return initial.configuration?await withSpaceConfigurationLock(initial.root,perform):perform()}catch(error){if(absentRegistryParent&&stat(registryParent)){try{rmdirSync(registryParent)}catch(recovery){throw new AggregateError([error,recovery],`${error.message}; registry directory rollback incomplete: ${recovery.message}`)}}throw error}
  })
}
