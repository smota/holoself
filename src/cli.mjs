import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, readlinkSync, writeFileSync, cpSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

export const VERSION = '0.5.0'
const START = '<!-- holoself-export-start -->'
const END = '<!-- holoself-export-end -->'
const ROOT_START = '<!-- holoself-root-start -->'
const ROOT_END = '<!-- holoself-root-end -->'
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const PROFILE_FILES = {

  'identity.md': '# Identity\n\nWrite a short description of who you are.\n',
  'preferences.md': '# Preferences\n\nDescribe how you prefer to work with AI tools.\n',
  'voice.md': '# Voice\n\nDescribe your writing voice.\n',
  'thinking.md': '# Thinking\n\nDescribe how you reason and make decisions.\n',
  'work-context.md': '# Work context\n\nDescribe current work and priorities.\n',
  'change.md': '# Change compass\n\nDescribe current goals and patterns only if useful.\n'
}
const CONTEXT_FILES = {
  'projects.md': '# Projects\n\nList active projects and their context.\n',
  'people.md': '# People\n\nRecord useful relationship context with care.\n',
  'decisions.md': '# Decisions\n\nRecord decisions, rationale, and date.\n',
  'story-bank.md': '# Story bank\n\nKeep evidence-backed stories and examples.\n',
  'career.md': '# Career\n\nKeep career context and evidence.\n',
  'admin.md': '# Admin\n\nKeep relevant logistics and recurring details.\n',
  'leadership.md': '# Leadership\n\nKeep leadership and reflection context.\n',
  'technical.md': '# Technical\n\nKeep technical context, constraints, and preferences.\n',
  'publishing.md': '# Publishing\n\nKeep publishing goals, audiences, and format preferences.\n'
}
function defaultRoot(){ return process.env.HOLOSELF_HOME || join(homedir(), '.holoself') }
function requiredValue(args, i, flag){
  const value = args[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}
function parse(args){
  const o={rootSetup:false}; const positional=[]
  for(let i=0;i<args.length;i++){
    const a=args[i]
    if(a==='--root'||a==='--data-root'||a==='--data-dir') o.root=resolve(requiredValue(args,i++,a))
    else if(a==='--target') o.target=resolve(requiredValue(args,i++,a))
    else if(a==='--from') o.from=resolve(requiredValue(args,i++,a))
    else if(a==='--contribs') o.contribs=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean)
    else if(a==='--exclude-contrib') o.exclude=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean)
    else if(a==='--yes'||a==='--confirm') o.yes=true
    else if(a==='--root-setup') o.rootSetup=true
    else if(a==='--force') o.force=true
    else if(a==='--dry-run') o.dryRun=true
    else if(a==='--packet-only') o.packetOnly=true
    else if(a==='--help'||a==='-h') o.help=true
    else positional.push(a)
  }
  o.root=o.root||defaultRoot(); o.command=positional[0]; o.args=positional.slice(1)
  return o
}
function ensureDir(p){ mkdirSync(p,{recursive:true}) }
let tempCounter = 0
function atomicWrite(p, content){
  ensureDir(dirname(p))
  const tmp = `${p}.holoself-tmp-${process.pid}-${tempCounter++}`
  try { writeFileSync(tmp, content, 'utf8'); renameSync(tmp, p) }
  finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
function json(p,v){ atomicWrite(p,JSON.stringify(v,null,2)+'\n') }
function configPath(root){return join(root,'config.json')}
function availableContribs(){
  const catalog=join(PACKAGE_ROOT,'contribs','catalog.json')
  try {
    const data=JSON.parse(readFileSync(catalog,'utf8'))
    if(data.schemaVersion!==1 || !Array.isArray(data.contribs)) return []
    return data.contribs.map(entry=>entry.id).filter(id=>existsSync(join(PACKAGE_ROOT,'contribs','default',`${id}.md`))).sort()
  } catch { return [] }
}
const DEFAULT_CONTRIBS = availableContribs()
function selectedContribs(o, existing){
  const selected = o.contribs || existing || DEFAULT_CONTRIBS
  const exclude = new Set(o.exclude || [])
  const unknown = [...new Set([...selected, ...exclude])].filter(id=>!availableContribs().includes(id))
  if (unknown.length) throw new Error(`unknown public contrib: ${unknown.join(', ')}`)
  return [...new Set(selected)].filter(id=>!exclude.has(id)).sort()
}
function readConfig(root){
  if(!existsSync(configPath(root))) return null
  try { return JSON.parse(readFileSync(configPath(root),'utf8')) } catch { return null }
}
function markerError(p, start=START, end=END){
  if(!existsSync(p)) return null
  if(lstatSync(p).isSymbolicLink() || !lstatSync(p).isFile()) return `${basename(p)} is not a regular file`
  const text=readFileSync(p,'utf8')
  const starts=(text.match(new RegExp(start,'g'))||[]).length
  const ends=(text.match(new RegExp(end,'g'))||[]).length
  return starts===ends && starts<=1 ? null : `${basename(p)} has malformed Holoself markers`
}
function packet(root, packetOnly=false){
  const files=[]
  for(const d of ['profile','context']){
    const dir=join(root,d); if(!existsSync(dir)) continue
    const walk=(p)=>{for(const e of readdirSync(p,{withFileTypes:true})){const x=join(p,e.name); if(e.isDirectory()) walk(x); else if(e.name.endsWith('.md')) files.push(relative(root,x).replaceAll('\\','/'))}}
    walk(dir)
  }
  files.sort()
  const body=packetOnly
    ? files.map(f=>`---\n\n## ${f}\n\n${readFileSync(join(root,f),'utf8').trim()}\n`).join('\n')
    : files.map(f=>`- [${f}](${f})`).join('\n')
  const note=packetOnly ? 'This packet is self-contained; no project-local fallback files are required.' : 'It is generated from local files under this project .holoself directory.'
  return `# Holoself context packet\n\nRead this packet first. ${note}\n\n${body}\n`
}
function rootSection(){
  return readFileSync(join(PACKAGE_ROOT,'templates','AGENTS.md'),'utf8')
}
function projectSection(packetOnly=false){return packetOnly
  ? `${START}\n## Holoself context\n\nLoad .holoself/context-packet.md first. This packet is self-contained.\nDo not write durable context silently: propose changes and ask approval.\n${END}\n`
  : `${START}\n## Holoself context\n\nLoad .holoself/context-packet.md first.\nIf needed, read relevant files under .holoself/profile/ and .holoself/context/.\nDo not write durable context silently: propose changes and ask approval.\n${END}\n`}
function inject(target,file,dryRun,section, start=START, end=END){
  const p=join(target,file); const existed=pathExists(p)
  if(existed && lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a symlink; refusing to modify`)
  if(existed && !lstatSync(p).isFile()) throw new Error(`${p} is not a file; refusing to modify`)
  const old=existed?readFileSync(p,'utf8'):''
  const starts=(old.match(new RegExp(start,'g'))||[]).length
  const ends=(old.match(new RegExp(end,'g'))||[]).length
  if(starts!==ends || starts>1) throw new Error(`${p} has malformed Holoself markers; refusing to modify`)
  const re=new RegExp(`${start}[\\s\\S]*?${end}\\n?`)
  const found=starts===1; const next=found?old.replace(re,section):(old.trimEnd()?old.trimEnd()+'\\n\\n':'')+section
  if(!dryRun && next!==old) atomicWrite(p,next)
  return next===old?'unchanged':(found?'updated':(existed?'appended':'created'))
}
function copyTree(source,dest,force=false){
  const stat=lstatSync(source)
  if(stat.isSymbolicLink()) throw new Error(`refusing symlink in source: ${source}`)
  if(stat.isDirectory()){
    if(existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    ensureDir(dest)
    for(const entry of readdirSync(source,{withFileTypes:true})) copyTree(join(source,entry.name),join(dest,entry.name),force)
    return
  }
  if(!stat.isFile()) return
  if(existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
  if(force || !existsSync(dest) || (lstatSync(dest).isFile() && Object.values({...PROFILE_FILES,...CONTEXT_FILES}).includes(readFileSync(dest,'utf8')))) atomicWrite(dest,readFileSync(source))
}
function copyMarkdownTree(source,dest){
  const stat=lstatSync(source); if(stat.isSymbolicLink()) throw new Error(`refusing symlink in source: ${source}`)
  if(stat.isDirectory()){
    if(existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    ensureDir(dest); for(const entry of readdirSync(source,{withFileTypes:true})) copyMarkdownTree(join(source,entry.name),join(dest,entry.name)); return
  }
  if(stat.isFile() && source.endsWith('.md')){
    if(existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    atomicWrite(dest,readFileSync(source))
  }
}
function pathExists(p){ try { lstatSync(p); return true } catch { return false } }
function backupExport(out,target){
  if(!pathExists(out)) return null
  if(lstatSync(out).isSymbolicLink()) throw new Error(`${out} is a symlink; refusing to refresh it`)
  const stamp=`${Date.now()}-${process.pid}-${tempCounter++}`
  const backup=join(target,`.holoself-backup-${stamp}`)
  renameSync(out,backup)
  return backup
}
const MIGRATION_ROOTS = new Set(['profile','context','topics','reference','me'])
const SENSITIVE_ROOTS = new Set(['reference','me'])
const GENERATED_ROOTS = new Set(['exports'])
function migrationRelative(root, file){ return relative(root,file).replaceAll('\\','/') }
function migrationFiles(root, prefix='', output=[]){
  if(!existsSync(root)) return output
  const walk=(dir)=>{ for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name); const rel=prefix ? `${prefix}/${migrationRelative(root,path)}` : migrationRelative(root,path)
    if(entry.isSymbolicLink()) throw new Error(`refusing symlink in source: ${path}`)
    if(entry.isDirectory()) walk(path)
    else if(entry.isFile()) output.push({path,relative:rel})
  }}
  walk(root); return output
}
function migrationPlan(source, target, sourceInput, force=false){
  const detected=migrationFiles(source)
  // A full PersonalOS checkout stores topics beside personal/; include it without
  // treating package or repository files as private data.
  if(sourceInput!==source && existsSync(join(sourceInput,'topics'))){
    for(const item of migrationFiles(join(sourceInput,'topics'))) { item.relative=`topics/${item.relative}`; detected.push(item) }
  }
  const report={
    sourceRoot:source, sourceInput, targetRoot:target, dryRun:false,
    detectedFiles:detected.map(x=>x.relative).sort(), destinationMappings:[],
    copied:[], preserved:[], conflicts:[], skipped:[], sensitive:[], generated:[], _detected:detected
  }
  for(const item of detected){
    const top=item.relative.split('/')[0]
    if(SENSITIVE_ROOTS.has(top)) report.sensitive.push(item.relative)
    if(GENERATED_ROOTS.has(top) || item.relative==='config.json' || item.relative==='migration-manifest.json'){
      report.generated.push(item.relative); report.skipped.push(item.relative); continue
    }
    if(!MIGRATION_ROOTS.has(top)){ report.skipped.push(item.relative); continue }
    const destination=item.relative
    report.destinationMappings.push({source:item.relative,destination})
    const dest=join(target,destination)
    if(!existsSync(dest)){ report.copied.push(destination); continue }
    const destStat=lstatSync(dest)
    if(destStat.isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    if(force || (destStat.isFile() && Object.values({...PROFILE_FILES,...CONTEXT_FILES}).includes(readFileSync(dest,'utf8')))) report.copied.push(destination)
    else { report.preserved.push(destination); report.conflicts.push(destination) }
  }
  report.detectedFiles.sort(); report.destinationMappings.sort((a,b)=>a.destination.localeCompare(b.destination))
  for(const key of ['copied','preserved','conflicts','skipped','sensitive','generated']) report[key].sort()
  report.detectedCount=report.detectedFiles.length
  report.summary={detected:report.detectedCount,mapped:report.destinationMappings.length,copied:report.copied.length,preserved:report.preserved.length,conflicts:report.conflicts.length,skipped:report.skipped.length,sensitive:report.sensitive.length,generated:report.generated.length}
  report.files={detected:report.detectedFiles,copied:report.copied,preserved:report.preserved,conflicts:report.conflicts,skipped:report.skipped,sensitive:report.sensitive,generated:report.generated}
  return {report,detected}
}
function applyMigration(plan, target){
  for(const mapping of plan.destinationMappings){
    if(!plan.copied.includes(mapping.destination)) continue
    const item=plan._detected.find(x=>x.relative===mapping.source); const dest=join(target,mapping.destination)
    atomicWrite(dest,readFileSync(item.path))
  }
}
function migrationManifest(report){
  const {dryRun:_,_detected:__,...manifestReport}=report
  return {schemaVersion:1,tool:'holoself',toolVersion:VERSION,timestamp:new Date().toISOString(),source:report.sourceRoot,target:report.targetRoot,...manifestReport}
}
function assertMigrationTarget(source,target){
  const from=resolve(source), to=resolve(target)
  if(to===from || to.startsWith(`${from}${'\\'}`) || to.startsWith(`${from}/`)) throw new Error('migration target must not be inside source; source must remain unchanged')
}
function assertDestinationParents(target, destination){
  let current=dirname(join(target,destination)); const boundary=resolve(target)
  while(resolve(current).startsWith(boundary) && resolve(current)!==boundary){
    if(existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`refusing symlink destination: ${current}`)
    current=dirname(current)
  }
}
function printMigrationReport(report, manifestPath=null){
  console.log(`[${report.dryRun?'dry-run':'ok'}] migration report`)
  console.log(`source root: ${report.sourceRoot}`)
  console.log(`target root: ${report.targetRoot}`)
  console.log(`detected files: ${report.detectedCount}`)
  for(const mapping of report.destinationMappings) console.log(`mapping: ${mapping.source} -> ${mapping.destination}`)
  for(const key of ['copied','preserved','conflicts','skipped','sensitive','generated']) console.log(`${key}: ${report[key].length}${report[key].length?` (${report[key].join(', ')})`:''}`)
  console.log(`summary: ${JSON.stringify(report.summary)}`)
  if(manifestPath) console.log(`manifest: ${manifestPath}`)
}
function isHoloselfLink(p, root){
  if(!lstatSync(p).isSymbolicLink()) return false
  try { return resolve(dirname(p), readlinkSync(p)) === resolve(root) } catch { return false }
}
function syncPublicDefaults(root, ids, dryRun=false){
  const dest=join(root,'contribs','default'); if(!dryRun) ensureDir(dest)
  const known=availableContribs()
  for(const id of known){
    const p=join(dest,`${id}.md`)
    if(ids.includes(id)){ if(!dryRun) atomicWrite(p,readFileSync(join(PACKAGE_ROOT,'contribs','default',`${id}.md`))) }
    else if(!dryRun && existsSync(p)) rmSync(p,{force:true})
  }
}
function help(){console.log(`Holoself ${VERSION}\n\nUsage: holoself <command> [options]\n\nCommands:\n  data-root                 Print private data root\n  init [--contribs a,b]     Create private data root and starter files\n  doctor                    Check installation and data root\n  validate                 Validate private data root and generated markers\n  migrate --from <dir>     Import PersonalOS data without publishing it\n  export --target <dir>    Export reviewable packet to a project\n  link --target <dir>      Link project .holoself to data root\n                            Add --root-setup to inject bounded loading instructions\n  unlink --target <dir>    Remove only a Holoself-managed link\n  upgrade                  Refresh selected public defaults\n\nData root: HOLOSELF_HOME or --data-dir <dir> (argument overrides environment).\nOptions: --data-dir <dir> --target <dir> --yes --dry-run --force\n`) }
async function confirm(o,message){if(o.yes)return true; if(!input.isTTY||!output.isTTY) throw new Error(`${message} Re-run with --yes to confirm.`); const rl=createInterface({input,output}); try { const answer=await rl.question(`${message} Type "yes" to continue: `); return answer.trim().toLowerCase()==='yes' } finally { rl.close() }}
export async function run(argv){
  const o=parse(argv); if(o.help||!o.command){help();return}
  const root=o.root
  if(o.command==='data-root'){console.log(root);return}
  if(o.command==='init'){
    ensureDir(root); for(const name of ['context','topics','reference','me','exports']) ensureDir(join(root,name)); ensureDir(join(root,'contribs','local')); ensureDir(join(root,'profile'))
    if(!existsSync(join(root,'topics','.current'))) atomicWrite(join(root,'topics','.current'),'')
    if(!existsSync(join(root,'reference','README.md'))) atomicWrite(join(root,'reference','README.md'),'# Private reference\n\nKeep private reference material here. It is never published as a public contrib.\n')
    if(!existsSync(join(root,'me','contribs.md'))) atomicWrite(join(root,'me','contribs.md'),'# Local self-model extensions\n\nList private contrib paths here when needed.\n')
    for(const [name,body] of Object.entries(PROFILE_FILES)){const p=join(root,'profile',name); if(!existsSync(p))atomicWrite(p,body)}
    for(const [name,body] of Object.entries(CONTEXT_FILES)){const p=join(root,'context',name); if(!existsSync(p))atomicWrite(p,body)}
    // Keep data-root guidance beside private data. Bounded injection preserves user text.
    inject(root,'AGENTS.md',false,rootSection(),ROOT_START,ROOT_END)
    const old=readConfig(root); const contribs=selectedContribs(o, old?.selectedContribs)
    json(configPath(root),{schemaVersion:1,product:'holoself',selectedContribs:contribs,createdAt:old?.createdAt || new Date().toISOString()}); syncPublicDefaults(root,contribs)
    console.log(`[ok] initialized ${root}`); console.log(`Contribs: ${contribs.join(', ')||'(none)'}`);return
  }
  if(o.command==='doctor'){
    const checks=[['node',Number(process.versions.node.split('.')[0])>=20],['data root',existsSync(root)],['config',existsSync(configPath(root))],['profile',existsSync(join(root,'profile'))],['context',existsSync(join(root,'context'))]]
    checks.forEach(([n,ok])=>console.log(`${ok?'[ok]':'[!!]'} ${n}`)); if(checks.some(([,ok])=>!ok))process.exitCode=1; return
  }
  if(o.command==='validate'){
    const errors=[]; if(!existsSync(root))errors.push('data root does not exist')
    const c=readConfig(root); if(c){
      if(c.schemaVersion!==1)errors.push('unsupported config schema')
      if(c.product!=='holoself')errors.push('config product must be holoself')
      if(!Array.isArray(c.selectedContribs))errors.push('selectedContribs must be an array')
      else for(const id of c.selectedContribs)if(!availableContribs().includes(id))errors.push(`unknown selected contrib: ${id}`)
    } else errors.push(existsSync(configPath(root))?'config.json is invalid JSON':'config.json missing')
    for(const name of Object.keys(PROFILE_FILES))if(!existsSync(join(root,'profile',name)))errors.push(`missing profile/${name}`)
    for(const name of Object.keys(CONTEXT_FILES))if(!existsSync(join(root,'context',name)))errors.push(`missing context/${name}`)
    const rootAgentsError=markerError(join(root,'AGENTS.md'),ROOT_START,ROOT_END); if(rootAgentsError)errors.push(rootAgentsError)
    for(const file of ['CLAUDE.md','CODEX.md']) { const error=markerError(join(root,file)); if(error)errors.push(error) }
    for(const e of errors)console.error(`[!!] ${e}`); if(errors.length){process.exitCode=1}else console.log(`[ok] ${root} is valid`); return
  }
  if(o.command==='migrate'){
    if(!o.from)throw new Error('migrate requires --from <PersonalOS directory>')
    const source=existsSync(join(o.from,'personal'))?join(o.from,'personal'):o.from
    if(!existsSync(source))throw new Error(`source not found: ${source}`)
    assertMigrationTarget(source,root)
    const {report}=migrationPlan(source,root,o.from,o.force)
    report.dryRun=Boolean(o.dryRun)
    if(!await confirm(o,`${o.dryRun?'Preview':'Copy'} personal data from ${source} to ${root}?`)){console.log('Cancelled.');return}
    const manifestPath=join(root,'migration-manifest.json')
    if(!o.dryRun){
      ensureDir(root)
      for(const mapping of report.destinationMappings) assertDestinationParents(root,mapping.destination)
      applyMigration(report,root)
      if(source!==o.from && existsSync(join(o.from,'topics'))) ensureDir(join(root,'topics'))
      const c=readConfig(root); if(c) json(configPath(root),c)
      atomicWrite(manifestPath,JSON.stringify(migrationManifest(report),null,2)+'\n')
    }
    printMigrationReport(report,o.dryRun?null:manifestPath)
    return
  }
  if(o.command==='export'){
    if(!o.target)throw new Error('export requires --target <project>'); if(!existsSync(root))throw new Error('data root missing; run init first')
    const out=join(o.target,'.holoself'); let backup=null
    if(!o.dryRun){
      ensureDir(o.target)
      const stage=join(o.target,`.holoself-tmp-${process.pid}-${tempCounter++}`)
      try {
        ensureDir(stage); copyMarkdownTree(join(root,'profile'),join(stage,'profile')); copyMarkdownTree(join(root,'context'),join(stage,'context'))
        atomicWrite(join(stage,'context-packet.md'),packet(root,o.packetOnly)); atomicWrite(join(stage,'README.md'),'# Holoself project context\n\nThis folder is generated locally. Do not commit it unless reviewed.\n')
        backup=backupExport(out,o.target); renameSync(stage,out)
      } finally { if(pathExists(stage)) rmSync(stage,{recursive:true,force:true}) }
    }
    console.log(`${o.dryRun?'[dry-run] ':''}[ok] exported packet to ${out}${backup?` (backup: ${backup})`:''}`)
    if(o.rootSetup){if(!await confirm(o,'Modify project instruction files with a bounded Holoself section? This changes project files.'))return; for(const f of ['AGENTS.md','CLAUDE.md','CODEX.md'])console.log(` - ${f}: ${inject(o.target,f,o.dryRun,projectSection(o.packetOnly))}`)} return
  }
  if(o.command==='link'){
    if(!o.target)throw new Error('link requires --target <project>'); if(!existsSync(root))throw new Error('data root missing; run init first')
    // Validate every instruction file before changing the link, so malformed or
    // unsafe project files cannot leave a partially-applied root setup.
    if(o.rootSetup) for(const f of ['AGENTS.md','CLAUDE.md','CODEX.md']) inject(o.target,f,true,projectSection())
    if(!o.dryRun) ensureDir(o.target); const p=join(o.target,'.holoself')
    if(pathExists(p)){if(!isHoloselfLink(p,root))throw new Error(`${p} exists and is not a Holoself link; refusing to replace`); if(!o.force)throw new Error(`${p} exists; use --force only to replace it`); if(!await confirm(o,`WARNING: replace existing Holoself link ${p}?`))return}
    else if(!await confirm(o,`WARNING: create link ${p} -> ${root}. This exposes private context to project tools.`))return
    if(!o.dryRun){if(pathExists(p))unlinkSync(p);symlinkSync(root,p,process.platform==='win32'?'junction':'dir')} console.log(`${o.dryRun?'[dry-run] ':'[ok] '}linked ${p} -> ${root}`)
    if(o.rootSetup){if(!await confirm(o,'Modify project instruction files with a bounded Holoself section? This changes project files.'))return; for(const f of ['AGENTS.md','CLAUDE.md','CODEX.md'])console.log(` - ${f}: ${inject(o.target,f,o.dryRun,projectSection())}`)} return
  }
  if(o.command==='unlink'){
    if(!o.target)throw new Error('unlink requires --target <project>'); const p=join(o.target,'.holoself'); if(!pathExists(p)){console.log('[ok] no link found');return} if(!isHoloselfLink(p,root))throw new Error(`${p} is not a Holoself link; refusing to remove`); if(!await confirm(o,`WARNING: remove Holoself link ${p}?`))return; if(!o.dryRun)unlinkSync(p); console.log(`${o.dryRun?'[dry-run] ':''}[ok] unlinked ${p}`);return
  }
  if(o.command==='upgrade'){
    const c=readConfig(root); if(!c)throw new Error('config.json missing; run init first'); const ids=selectedContribs(o,c.selectedContribs); if(!o.dryRun){c.selectedContribs=ids;json(configPath(root),c)} syncPublicDefaults(root,ids,o.dryRun); console.log(`${o.dryRun?'[dry-run] ':''}[ok] refreshed public defaults`);return
  }
  throw new Error(`unknown command: ${o.command}`)
}
