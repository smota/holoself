import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  activateProject, auditInstructions, bootstrapText, deactivateProject, globalSkillStatus,
  installGlobalSkills, migrateProjectSkillsToGlobal, preflightActivation, readRuntime, recordedActivation
} from './adapters.mjs'
import { readBindings, resolveBinding, writeBinding, bindingsPath } from './bindings.mjs'
import { loadLensRegistry, resolveLens } from './lenses.mjs'
import { DISCLOSURES, DOCUMENT_ROLES, SENSITIVITIES, VISIBILITIES } from './annotations.mjs'
import { canonicalJson, validateCatalogSchema, validateDecisionCacheSchema } from './catalog.mjs'
import { planPolicyMigration, applyPolicyMigration, revertPolicyMigration } from './migration.mjs'

import { assertContainedPath, atomicWrite, ensureDir, hash, pathExists, safeRealpath, slash } from './shared/fs.mjs'
import { parseYaml } from './shared/yaml.mjs'
import { canonicalProjectPath, canonicalSpaceId, readRegistry, registryFilePath, withRegistryLock, writeRegistry } from './link/registry.mjs'
import {
  DEFAULT_PROJECT_EXCLUDES, createLinkDirs, inspectLinkCollisions, isCanonicalSelf, linkPath,
  linkSchemaErrors, projectContextErrors, readLink, updateLinkBindingSaltInPlace, writeLink
} from './link/config.mjs'
import { linkedLensAuthority } from './link/attestation.mjs'
import { PRIVACY_FIELDS, canonicalPrivacyMetadataErrors, privacyMetadataErrors, privacyValueValid } from './policy/privacy-fields.mjs'
import { LENSES } from './policy/access.mjs'
import { redactRootPaths } from './shared/redact.mjs'
import { catalogCandidateRecords } from './retrieval/records.mjs'
import { contextData } from './retrieval/context.mjs'
import { mcpContextSummary, mcpToolEnvelope, packetFormat } from './render/packet.mjs'
import { holoselfMcpContext, holoselfMcpCreateProposal, holoselfMcpPreviewProposal, holoselfMcpSearch, holoselfMcpStatus } from './retrieval/mcp.mjs'
import {
  PROPOSAL_STATES, PROPOSAL_TYPES, createProposal, findProposal, listProposalData, proposalChanges,
  proposalPreviewData, proposalText, safeTarget, scanProposalStore, stateProposal
} from './proposals/store.mjs'
import { buildCatalogSource } from './catalog/source.mjs'
import { ensureCatalog, ensureCatalogPartition, ensureContribPartition, isPartitionFresh } from './catalog/partitions.mjs'
import { buildIndex, readIndex, searchIndex } from './catalog/index.mjs'
import { catalogBuildWarnings, ecosystemValidationErrors } from './catalog/validation.mjs'
import { canonicalFiles, markdownFiles } from './markdown/files.mjs'
import { healthStatus } from './link/health.mjs'
import { analysis, filterAnalysis } from './proposals/analysis.mjs'
export { DISCLOSURES, DOCUMENT_ROLES, SENSITIVITIES, VISIBILITIES }
// Re-exported so existing imports of these names from ecosystem.mjs keep working.
export { LENSES, PRIVACY_FIELDS, canonicalPrivacyMetadataErrors, canonicalSpaceId, privacyMetadataErrors, privacyValueValid }
export {
  PROPOSAL_STATES, PROPOSAL_TYPES, catalogBuildWarnings, ecosystemValidationErrors, holoselfMcpContext,
  holoselfMcpCreateProposal, holoselfMcpPreviewProposal, holoselfMcpSearch, holoselfMcpStatus,
  mcpContextSummary, mcpToolEnvelope, redactRootPaths
}

function projectPath(o){ return resolve(o.project || o.target || process.cwd()) }
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
  const lower=basename(project).toLowerCase(); const lens=lower.includes('linkedin')?'public-voice':lower.includes('professional')?'professional':'general'
  return {instructions,context,suggested_lens:lens,likely_duplicates:context,migration_recommendations:context.map(path=>`${path}: compare with canonical self; retain project-specific content and propose reusable knowledge`)}
}









// Repair restores what was activated (runtime record, else active markers); `auto` only when nothing is known.
function repairSelection(project){const recorded=recordedActivation(project);return {activate:recorded.ids.join(','),source:recorded.source,dropped:recorded.dropped,skipped:recorded.skipped}}
// selection: {activate, source, dropped, skipped} from repair; activate/setup pass none and report detected|explicit.
async function activateLinkedProject(o,project,link,verb='Activate',selection=null){
  if(o.noActivate)return null
  const explicit=Boolean(o.activate||o.platforms?.length),source=explicit?'explicit':selection?.source||'detected'
  const options={activate:o.activate||selection?.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||readRuntime(project)?.skillInstallPolicy||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force}
  const {plan}=preflightActivation(project,options);console.log(JSON.stringify({activation_plan:{source,adapter_ids:plan.adapters.map(x=>x.id),...(selection?.dropped?.length&&!explicit?{dropped_adapters:selection.dropped}:{}),...(selection?.skipped?.length&&!explicit?{skipped_unmanaged:selection.skipped}:{}),canonical:plan.canonical,adapters:plan.adapters.map(({id,name,file,support,delivery,discovery,tested_product,tested_version,evidence,last_verified,detected})=>({id,name,file,support,delivery,discovery,tested_product,tested_version,evidence,last_verified,detected})),skills:plan.skills,global_skills:plan.globalSkills,writes:plan.writes}},null,2))
  if(!await askConfirm(o,`${verb} Holoself by modifying bounded managed files: ${plan.writes.join(', ')}?`))return null
  const result=activateProject(project,link,options);for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`);return result
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
    if(sub==='bindings'){console.log(JSON.stringify(readBindings(root),null,2));return true}
    if(sub==='bind'||sub==='unbind'){
      if(!o.project)throw new Error(`lens ${sub} requires --project <absolute path>`)
      const choice=sub==='unbind'?null:{default_lens:o.lens||'general',secondary_lenses:o.secondaryLenses||[]},before=readBindings(root)
      if(o.bindingHash!==undefined&&o.bindingHash!==before.hash)throw new Error('lens bindings changed on disk')
      if(choice){resolveLens(registry,choice.default_lens);for(const id of choice.secondary_lenses)resolveLens(registry,id)}
      console.log(JSON.stringify({project:slash(o.project),binding:choice},null,2))
      if(o.dryRun)return true
      if(!await askConfirm(o,`${sub==='unbind'?'Remove':'Save'} self-side lens binding?`))return true
      const file=bindingsPath(root),snapshot=existsSync(file)?readFileSync(file):null
      try{
        await withRegistryLock(root,()=>{
          const attestation=readRegistry(root),pId=canonicalSpaceId(o.project),cPath=canonicalProjectPath(o.project)
          writeBinding(root,o.project,choice,{expectedHash:before.hash})
          writeRegistry(root,links=>links.map(entry=>(entry.project_id===pId||entry.project_path===cPath)?{...entry,allowed_lenses:choice?[choice.default_lens,...choice.secondary_lenses]:[],updated_at:new Date().toISOString()}:entry),attestation.registry_hash)
        })
      }catch(error){if(snapshot)atomicWrite(file,snapshot);else if(existsSync(file))rmSync(file);throw error}
      console.log(JSON.stringify(readBindings(root),null,2));return true
    }
    if(sub==='list'){console.log(JSON.stringify({root:slash(root),registry_path:slash(registry.registry_path),registry_hash:registry.registry_hash,lenses:registry.lenses.map(lens=>({...lens,sensitivity_access:[...lens.sensitivity_access]}))},null,2));return true}
    if(sub==='show'){const id=o.args?.[1];if(!id)throw new Error('lens show requires <id>');const lens=resolveLens(registry,id);console.log(JSON.stringify({root:slash(root),registry_hash:registry.registry_hash,lens:{...lens,sensitivity_access:[...lens.sensitivity_access]}},null,2));return true}
    if(sub==='validate'){console.log(JSON.stringify({status:'valid',root:slash(root),registry_path:slash(registry.registry_path),registry_hash:registry.registry_hash,definitions:registry.lenses.length},null,2));return true}
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
    const plan=planPolicyMigration(selfRoot,{includeLinked:o.includeLinked,dryRun:Boolean(o.dryRun)})
    console.log(JSON.stringify({
      status:'planned',
      plan_id:plan.plan_id,
      generated_at:plan.generated_at,
      self_root:plan.self_root,
      include_linked:plan.include_linked,
      summary:plan.summary,
      plan_file:o.dryRun?null:slash(join(selfRoot,'.holoself','migrations',`plan-${plan.plan_id}.json`))
    },null,2))
    return true
  }

  if(o.command==='link' && ['add','status','remove','setup','activate','deactivate','repair','doctor','approve','backfill','prune'].includes(sub)){
    const project=sub==='backfill'&&o.all&&!o.project&&!o.target?null:projectPath(o)
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
        const link={...desired,project_context:{include:o.projectContext?.include||[],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(o.projectContext?.exclude||[])]}}
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
      const bindingFile=bindingsPath(selfRoot),previousBindings=existsSync(bindingFile)?readFileSync(bindingFile):null
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
        if(previousBindings)atomicWrite(bindingFile,previousBindings);else if(existsSync(bindingFile))rmSync(bindingFile)
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
      const bindingFile=bindingsPath(selfRoot),previousBindings=existsSync(bindingFile)?readFileSync(bindingFile):null
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
        if(previousBindings)atomicWrite(bindingFile,previousBindings);else if(existsSync(bindingFile))rmSync(bindingFile)
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
            updateLinkBindingSaltInPlace(project,salt)
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
              updateLinkBindingSaltInPlace(proj,salt)
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
      try{link=readLink(project,{tolerant:true})}catch(error){console.log(JSON.stringify({project:slash(project),state:'broken',errors:[error.message]},null,2));process.exitCode=1;return true}
      if(link._schemaErrors.length){console.log(JSON.stringify({project:slash(project),state:'broken',errors:link._schemaErrors},null,2));process.exitCode=1;return true}
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
        project_skill_override_details:health.activation.projectSkillOverrideDetails,
        project_skill_deployments:health.activation.projectSkillDeployments,
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
      if(!o.dryRun&&selfReachable)writeBinding(selfRoot,project,null)
      deactivateProject(project,{dryRun:o.dryRun})
      if(!o.dryRun)rmSync(path)
      console.log(`[ok] removed ${path}; indexes, reports, and proposals preserved`)
      return true
    }
    if(['activate'].includes(sub)){const link=readLink(project);await activateLinkedProject(o,project,link,'Activate');return true}
    if(sub==='repair'){
      const diagnostic=readLink(project,{tolerant:true})
      if(diagnostic._schemaErrors.length)throw new Error(diagnostic._schemaErrors.join('; '))
      const rename=id=>({career:'professional',publishing:'public-voice'}[id]||id)
      const legacy=diagnostic._legacyBinding?{default_lens:rename(diagnostic._legacyBinding.default_lens),secondary_lenses:diagnostic._legacyBinding.secondary_lenses.map(rename)}:null
      let current=null;try{current=resolveBinding(diagnostic.path,project)}catch(error){if(error.code!=='LENS_BINDING_REQUIRED')throw error}
      const choice=o.lens?{default_lens:o.lens,secondary_lenses:o.secondaryLenses||[]}:current||legacy
      if(!choice)throw new Error(diagnostic._bindingError)
      if(current&&legacy&&!o.lens&&canonicalJson(current)!==canonicalJson(legacy))throw new Error('legacy lens choice conflicts with self binding; pass --lens and --secondary-lenses to choose explicitly')
      const registry=loadLensRegistry(diagnostic.path);resolveLens(registry,choice.default_lens);for(const id of choice.secondary_lenses)resolveLens(registry,id)
      if(legacy||o.lens||!current){
        console.log(JSON.stringify({binding_migration:{project:slash(project),before:current,legacy,after:choice}},null,2))
        if(o.dryRun){if(!o.noActivate)await activateLinkedProject(o,project,diagnostic,'Repair',repairSelection(project));return true}
        if(!await askConfirm(o,'Migrate lens choice into self-side bindings?'))return true
        const file=bindingsPath(diagnostic.path),before=existsSync(file)?readFileSync(file):null,linkBefore=readFileSync(linkPath(project))
        try{
          await withRegistryLock(diagnostic.path,()=>{
            const attestation=readRegistry(diagnostic.path),pId=canonicalSpaceId(project),cPath=canonicalProjectPath(project)
            writeLink(project,diagnostic.path,choice.default_lens,choice.secondary_lenses,diagnostic.project_context,diagnostic.binding_salt)
            writeRegistry(diagnostic.path,links=>links.map(entry=>(entry.project_id===pId||entry.project_path===cPath)?{...entry,allowed_lenses:[choice.default_lens,...choice.secondary_lenses],updated_at:new Date().toISOString()}:entry),attestation.registry_hash)
          })
        }catch(error){atomicWrite(linkPath(project),linkBefore);if(before)atomicWrite(file,before);else if(existsSync(file))rmSync(file);throw error}
      }
      if(!o.noActivate)await activateLinkedProject(o,project,readLink(project),'Repair',repairSelection(project))
      return true
    }
    if(sub==='deactivate'){
      const line=item=>` - ${item.adapter?`${item.adapter}: `:''}${item.file||'(no files)'}: ${item.result}`,planned=deactivateProject(project,{dryRun:true,adapters:o.adapters})
      console.log(`Deactivation plan${o.adapters?` for ${o.adapters}`:''}:`);for(const item of planned)console.log(line(item))
      if(o.dryRun||!await askConfirm(o,'Apply this deactivation plan? Link metadata is preserved.'))return true
      const results=deactivateProject(project,{adapters:o.adapters});console.log('Applied:');for(const item of results)console.log(line(item));return true
    }
    if(sub==='doctor'){const link=readLink(project),health=healthStatus(project,link,o),projectHealthy=health.activation.skillInstallations.length&&health.activation.skillInstallations.every(x=>x.kind==='full-public-skill'&&x.installed),globalHealthy=health.activation.globalSkillInstallations.length&&health.activation.globalSkillInstallations.every(x=>x.kind==='full-public-skill'&&x.installed),skillHealthy=health.skillPolicy==='none'||(health.skillPolicy==='global'?globalHealthy:projectHealthy),checks={link:'valid',self_root:existsSync(link.path)?'valid':'missing',lens:loadLensRegistry(link.path).byId.has(link.default_lens)?'valid':'invalid',bootstrap:health.activation.bootstrap?'valid':'missing',activation:health.activation.active?'valid':'degraded',skill_installation:health.skillPolicy==='none'?'disabled':health.skillPolicy==='global'?(globalHealthy?'global-full-public-skill':'degraded'):skillHealthy?'full-public-skill':'degraded',project_skill_overrides:health.skillPolicy==='global'?(health.activation.projectSkillOverrides.length?'present':'absent'):'not-applicable',cli_command:commandStatus(),context:'unknown'};try{const data=contextData({...o,project});checks.context=data.sources.length?'valid':'empty';checks.warnings=(data.warnings||[]).map(w=>redactRootPaths(w,[link.path,project]))}catch(error){checks.context='broken';checks.context_error=redactRootPaths(error.message,[link.path,project])}const ok=!Object.values(checks).some(x=>['missing','invalid','degraded','broken','present'].includes(x));console.log(JSON.stringify({state:ok?'activated':'degraded',checks,warnings:checks.warnings||[],errors:health.errors,project_skill_override_details:health.activation.projectSkillOverrideDetails,project_skill_deployments:health.activation.projectSkillDeployments},null,2));if(!ok)process.exitCode=1;return true}
    const findings=setupFindings(project);console.log(JSON.stringify(findings,null,2));let self=o.self;if(!self&&input.isTTY&&output.isTTY){const answer=await askValue('Canonical self path');if(answer)self=resolve(answer)}if(!self){if(o.yes)throw new Error('link setup requires --self <path> before confirmation');console.log('No changes made. Re-run with --self <path> --yes to create link.');return true}if(!existsSync(join(self,'profile'))||!existsSync(join(self,'context')))throw new Error(`self path lacks profile/context layout: ${resolve(self)}`);const setupRegistry=loadLensRegistry(resolve(self));resolveLens(setupRegistry,o.lens||findings.suggested_lens);for(const lens of o.secondaryLenses||[])resolveLens(setupRegistry,lens);const collisions=inspectLinkCollisions(project);if(collisions.length&&!o.force)throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation`);if(!o.noActivate){const {plan}=preflightActivation(project,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force});console.log(JSON.stringify({activation_plan:{canonical:plan.canonical,adapters:plan.adapters,skills:plan.skills,global_skills:plan.globalSkills,writes:plan.writes}},null,2))}if(!await askConfirm(o,`${collisions.length?'Replace link configuration while preserving existing README and artifacts':'Create and activate link'} using ${self} and ${o.lens||findings.suggested_lens} lens?`)){console.log('Cancelled.');return true}let link;if(o.dryRun)link={path:resolve(self),access:'read',proposals:'enabled',index:'local',default_lens:o.lens||findings.suggested_lens,secondary_lenses:o.secondaryLenses||[],project_context:{include:o.projectContext?.include||[],exclude:[...DEFAULT_PROJECT_EXCLUDES,...(o.projectContext?.exclude||[])]}};else{createLinkDirs(project,{preserveReadme:o.force});link=writeLink(project,self,o.lens||findings.suggested_lens,o.secondaryLenses||[],o.projectContext||{})}if(!o.noActivate){const result=activateProject(project,link,{activate:o.activate||'auto',platforms:o.platforms||[],instructions:o.instructions,installSkill:o.installSkill||'auto',skillHome:o.skillHome,dryRun:o.dryRun,force:o.force});for(const item of result.results)console.log(` - ${item.id}: ${item.file} (${item.result})`)}console.log(`${o.dryRun?'[dry-run] ':'[ok] '}setup complete; no files deleted or relocated`);return true
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
      const proposalBefore=readFileSync(p._path),receipt=join(link.path,'proposals','receipts',`${p.proposal_id}-approved.json`),commitTime=new Date().toISOString(),appliedChanges=previews.map(item=>({...item,after_sha256:hash(grouped.get(safeTarget(link.path,item.target)).after.replaceAll('<commit-time>',commitTime))}));try{for(const item of grouped.values())atomicWrite(item.target,item.after.replaceAll('<commit-time>',commitTime));stateProposal(project,p,'approved',{preview_sha256:previewHash,applied_changes:appliedChanges.map(({change_id,target,before_sha256,after_sha256})=>({change_id,target,before_sha256,after_sha256}))});const errors=ecosystemValidationErrors(link.path,project);if(errors.length)throw new Error(`post-approval validation failed: ${errors.join('; ')}`)}catch(error){for(const item of grouped.values()){if(item.existed)atomicWrite(item.target,item.before);else if(existsSync(item.target))rmSync(item.target)};atomicWrite(p._path,proposalBefore);if(existsSync(archive))rmSync(archive,{force:true});if(existsSync(receipt))rmSync(receipt,{force:true});throw error}console.log(`[ok] approved ${p.proposal_id}; ${changes.length} change(s), validation passed`);return true
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
      const projectFiles=[]
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
    const allowedLenses=linkedLensAuthority(project,link,lens)
    const index=readIndex(project,true,false,{federated:Boolean(o.federated),spaces:o.spaces,lens})
    let results=searchIndex(index,query,lens,registry,resolution,o.temporal||'current',{federated:Boolean(o.federated),spaces:o.spaces,effective_allowed_lenses:allowedLenses})
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

// Workbench configuration boundary. The caller supplies validated canonical paths and
// holds the registry lock over its complete transaction, including recovery.
export function spaceLinkConfiguration(project,self,{lens='general',metadataAbsent=false}={}){
  const existing=!metadataAbsent&&pathExists(linkPath(project))?readLink(project,{tolerant:true}):null
  if(!metadataAbsent)inspectLinkCollisions(project)
  const registry=loadLensRegistry(self),binding=readBindings(self,{registry}).bindings[canonicalProjectPath(project)]
  const desired={path:self,access:'read',proposals:'enabled',index:'local',default_lens:binding?.default_lens||existing?.default_lens||lens,secondary_lenses:binding?.secondary_lenses||existing?.secondary_lenses||[],project_context:existing?(parseYaml(readFileSync(linkPath(project),'utf8')).project_context||{}):{include:[],exclude:DEFAULT_PROJECT_EXCLUDES,assert_include:[],assert_exclude:[]}}
  const {project_context,...selfContext}=desired
  const errors=[...linkSchemaErrors(selfContext,registry),...projectContextErrors(project_context)]
  if(errors.length)throw new Error(errors.join('; '))
  const sovereign=readRegistry(self),entry=sovereign.links.find(x=>x.project_id===canonicalSpaceId(project)||x.project_path===canonicalProjectPath(project))
  return {link:desired,registry_hash:sovereign.registry_hash,lens_registry_hash:registry.registry_hash,binding_salt:entry?.binding_salt||existing?.binding_salt||null}
}
export function readSpaceLink(project){return readLink(project)}
export const withSpaceConfigurationLock=(self,fn)=>withRegistryLock(self,fn)
export function configureSpaceLink(project,self,configuration){
  const {link}=configuration,salt=configuration.binding_salt||randomBytes(16).toString('hex'),now=new Date().toISOString()
  createLinkDirs(project,{preserveReadme:true,purgeLegacy:false})
  const written=writeLink(project,self,link.default_lens,link.secondary_lenses,link.project_context,salt)
  writeRegistry(self,links=>{const project_id=canonicalSpaceId(project),project_path=canonicalProjectPath(project),index=links.findIndex(x=>x.project_id===project_id||x.project_path===project_path),entry={project_id,project_path,binding_salt:salt,allowed_lenses:[link.default_lens,...link.secondary_lenses],status:'active',attested_by:'owner:direct',created_at:index>=0?links[index].created_at:now,updated_at:now,revoked_at:null};if(index>=0)links[index]=entry;else links.push(entry);return links},configuration.registry_hash)
  return written
}
