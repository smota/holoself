import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, readlinkSync, writeFileSync, cpSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { ecosystemValidationErrors, runEcosystem } from './ecosystem.mjs'
import { BUILTIN_LENS_IDS } from './lenses.mjs'
import { VERSION } from './version.mjs'
import { applyCleanupPlan, buildCleanupPlan } from './cleanup.mjs'

export { VERSION } from './version.mjs'
const START = '<!-- holoself-export-start -->'
const END = '<!-- holoself-export-end -->'
const ROOT_START = '<!-- holoself-root-start -->'
const ROOT_END = '<!-- holoself-root-end -->'
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const metadata=(access,disclosure='internal-only',sensitivity='personal',role='content')=>`---\naccess_lenses: [${access.join(', ')}]\ndisclosure: ${disclosure}\nsensitivity: ${sensitivity}\ndocument_role: ${role}\n---\n`
const ALL_LENSES=BUILTIN_LENS_IDS
const PROFILE_FILES = {
  'identity.md': metadata(ALL_LENSES)+'# Identity\n\nWrite a short description of who you are.\n',
  'preferences.md': metadata(ALL_LENSES,'internal-only','personal','policy')+'# Preferences\n\nDescribe how you prefer to work with AI tools.\n',
  'voice.md': metadata(ALL_LENSES,'internal-only','personal','policy')+'# Voice\n\nDescribe your writing voice.\n',
  'thinking.md': metadata(ALL_LENSES,'internal-only','personal','policy')+'# Thinking\n\nDescribe how you reason and make decisions.\n',
  'work-context.md': metadata(ALL_LENSES)+'# Work context\n\nDescribe current work and priorities.\n',
  'change.md': metadata(ALL_LENSES,'internal-only','personal','policy')+'# Change compass\n\nDescribe current goals and patterns only if useful.\n'
}
const CONTEXT_FILES = {
  'projects.md': metadata(['general','career','technical','leadership','private'])+'# Projects\n\nList active projects and their context.\n',
  'people.md': metadata(['general','leadership','private'])+'# People\n\nRecord useful relationship context with care.\n',
  'decisions.md': metadata(['general','career','technical','leadership','private'])+'# Decisions\n\nRecord decisions, rationale, and date.\n',
  'story-bank.md': metadata(['general','career','publishing','leadership','interview','private'],'review-required','personal','evidence')+'# Story bank\n\nKeep evidence-backed stories and examples.\n',
  'career.md': metadata(['general','career','publishing','interview','private'],'review-required','personal','evidence')+'# Career\n\nKeep career context and evidence.\n',
  'admin.md': metadata(['general','private'])+'# Admin\n\nKeep relevant logistics and recurring details.\n',
  'leadership.md': metadata(['general','career','publishing','leadership','interview','private'],'review-required')+'# Leadership\n\nKeep leadership and reflection context.\n',
  'technical.md': metadata(['general','career','publishing','technical','interview','private'],'review-required')+'# Technical\n\nKeep technical context, constraints, and preferences.\n',
  'publishing.md': metadata(['general','publishing','private'],'internal-only','personal','policy')+'# Publishing\n\nKeep publishing goals, audiences, and format preferences.\n'
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
    if(a==='--root'||a==='--data-root'||a==='--data-dir') { o.root=resolve(requiredValue(args,i++,a));o.rootExplicit=true }
    else if(a==='--target') o.target=resolve(requiredValue(args,i++,a))
    else if(a==='--project') o.project=resolve(requiredValue(args,i++,a))
    else if(a==='--self') o.self=resolve(requiredValue(args,i++,a))
    else if(a==='--from') o.from=resolve(requiredValue(args,i++,a))
    else if(a==='--lens') o.lens=requiredValue(args,i++,a)
    else if(a==='--secondary-lenses') o.secondaryLenses=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean)
    else if(a==='--task') o.task=requiredValue(args,i++,a)
    else if(a==='--budget') o.budget=requiredValue(args,i++,a)
    else if(a==='--temporal') o.temporal=requiredValue(args,i++,a)
    else if(a==='--source') { o.sources=o.sources||[];o.sources.push(requiredValue(args,i++,a)) }
    else if(a==='--manifest') o.manifest=true
    else if(a==='--include-history') o.includeHistory=true
    else if(a==='--no-cache') o.noCache=true
    else if(a==='--format') o.format=requiredValue(args,i++,a)
    else if(a==='--output') o.output=resolve(requiredValue(args,i++,a))
    else if(a==='--plan') o.plan=resolve(requiredValue(args,i++,a))
    else if(a==='--apply') o.apply=resolve(requiredValue(args,i++,a))
    else if(a==='--digest'||a==='--preview-hash') o.digest=requiredValue(args,i++,a)
    else if(a==='--adapter') o.adapter=requiredValue(args,i++,a)
    else if(a==='--activate') o.activate=requiredValue(args,i++,a)
    else if(a==='--platform') { o.platforms=o.platforms||[]; o.platforms.push(requiredValue(args,i++,a)) }
    else if(a==='--instructions') o.instructions=requiredValue(args,i++,a)
    else if(a==='--install-skill') o.installSkill=requiredValue(args,i++,a)
    else if(a==='--skill-home') o.skillHome=resolve(requiredValue(args,i++,a))
    else if(a==='--scope') o.scope=requiredValue(args,i++,a)
    else if(a==='--project-include') { o.projectContext=o.projectContext||{};o.projectContext.include=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean) }
    else if(a==='--project-exclude') { o.projectContext=o.projectContext||{};o.projectContext.exclude=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean) }
    else if(a==='--project-assert-include') { o.projectContext=o.projectContext||{};o.projectContext.assert_include=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean) }
    else if(a==='--project-assert-exclude') { o.projectContext=o.projectContext||{};o.projectContext.assert_exclude=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean) }
    else if(a==='--expires-hours') { const value=Number(requiredValue(args,i++,a));if(!Number.isFinite(value)||value<=0||value>720)throw new Error('--expires-hours must be a number greater than 0 and at most 720');o.expiresHours=value }
    else if(a==='--port') { const value=Number(requiredValue(args,i++,a));if(!Number.isInteger(value)||value<0||value>65535)throw new Error('--port must be between 0 and 65535');o.port=value }
    else if(a==='--restricted-host') o.restrictedHost=true
    else if(a==='--claude-project-dir') o.claudeProjectDir=true
    else if(a==='--claim') o.claim=requiredValue(args,i++,a)
    else if(a==='--evidence') o.evidence=requiredValue(args,i++,a)
    else if(a==='--target-file') o.targetFile=requiredValue(args,i++,a)
    else if(a==='--proposal-type'||a==='--type') o.proposalType=requiredValue(args,i++,a)
    else if(a==='--confidence') o.confidence=requiredValue(args,i++,a)
    else if(a==='--visibility') o.visibility=requiredValue(args,i++,a)
    else if(a==='--source-file') { o.sourceFiles=o.sourceFiles||[]; o.sourceFiles.push(requiredValue(args,i++,a)) }
    else if(a==='--contribs') o.contribs=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean)
    else if(a==='--exclude-contrib') o.exclude=requiredValue(args,i++,a).split(',').map(x=>x.trim()).filter(Boolean)
    else if(a==='--yes'||a==='--confirm') o.yes=true
    else if(a==='--no-activate') o.noActivate=true
    else if(a==='--no-open') o.noOpen=true
    else if(a==='--root-setup') o.rootSetup=true
    else if(a==='--force') o.force=true
    else if(a==='--dry-run') o.dryRun=true
    else if(a==='--packet-only') o.packetOnly=true
    else if(a==='--self-only') o.selfOnly=true
    else if(a==='--snapshot') o.snapshot=true
    else if(a==='--json') o.json=true
    else if(a==='--changed') o.changed=true
    else if(a==='--federated') o.federated=true
    else if(a==='--help'||a==='-h') o.help=true
    else if(a==='--version'||a==='-v') o.version=true
    else if(a.startsWith('-')) throw new Error(`unknown option: ${a}`)
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
function isEcosystemMetadata(out){
  if(!pathExists(out)||lstatSync(out).isSymbolicLink()||!lstatSync(out).isDirectory())return false
  return pathExists(join(out,'link.yaml'))||['index','proposals','reports'].some(name=>pathExists(join(out,name)))
}
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
const MIGRATED_CANONICAL_METADATA=metadata(['private'],'internal-only','restricted','content')
function migrationRelative(root, file){ return relative(root,file).replaceAll('\\','/') }
function migratedCanonicalMarkdown(relativePath){return /^(?:profile|context|topics)\/.+\.md$/i.test(relativePath)}
function migrationContent(item,destination){
  const content=readFileSync(item.path,'utf8').replace(/^\uFEFF/,'')
  return migratedCanonicalMarkdown(destination)&&!content.startsWith('---\n')&&!content.startsWith('---\r\n')?MIGRATED_CANONICAL_METADATA+content:content
}
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
    copied:[], preserved:[], conflicts:[], skipped:[], sensitive:[], generated:[], tagged:[], _detected:detected
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
  report.tagged=report.destinationMappings.filter(mapping=>report.copied.includes(mapping.destination)).filter(mapping=>{
    const item=detected.find(candidate=>candidate.relative===mapping.source),content=readFileSync(item.path,'utf8').replace(/^\uFEFF/,'')
    return migratedCanonicalMarkdown(mapping.destination)&&!content.startsWith('---\n')&&!content.startsWith('---\r\n')
  }).map(mapping=>mapping.destination)
  report.detectedFiles.sort(); report.destinationMappings.sort((a,b)=>a.destination.localeCompare(b.destination))
  for(const key of ['copied','preserved','conflicts','skipped','sensitive','generated','tagged']) report[key].sort()
  report.detectedCount=report.detectedFiles.length
  report.summary={detected:report.detectedCount,mapped:report.destinationMappings.length,copied:report.copied.length,preserved:report.preserved.length,conflicts:report.conflicts.length,skipped:report.skipped.length,sensitive:report.sensitive.length,generated:report.generated.length,tagged:report.tagged.length}
  report.files={detected:report.detectedFiles,copied:report.copied,preserved:report.preserved,conflicts:report.conflicts,skipped:report.skipped,sensitive:report.sensitive,generated:report.generated,tagged:report.tagged}
  return {report,detected}
}
function applyMigration(plan, target){
  for(const mapping of plan.destinationMappings){
    if(!plan.copied.includes(mapping.destination)) continue
    const item=plan._detected.find(x=>x.relative===mapping.source); const dest=join(target,mapping.destination)
    atomicWrite(dest,migrationContent(item,mapping.destination))
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
  for(const key of ['copied','preserved','conflicts','skipped','sensitive','generated','tagged']) console.log(`${key}: ${report[key].length}${report[key].length?` (${report[key].join(', ')})`:''}`)
  console.log(`summary: ${JSON.stringify(report.summary)}`)
  if(manifestPath) console.log(`manifest: ${manifestPath}`)
}
function isHoloselfLink(p, root){
  if(!lstatSync(p).isSymbolicLink()) return false
  try { return resolve(dirname(p), readlinkSync(p)) === resolve(root) } catch { return false }
}
function help(){console.log(`Holoself ${VERSION}\n\nUsage: holoself <command> [options]\n\nCore commands:\n  data-root | init | doctor | validate | migrate | export | upgrade\n  web [--root <self-root>] [--project <linked-project>] [--port <n>] [--no-open]  Optional local Workbench\n  link --target <dir>       Legacy live data-root junction\n  unlink --target <dir>     Remove legacy managed junction\n\nLinked ecosystem:\n  skill status|install --scope user [--platform <id>] [--skill-home <dir>]\n  lens list|show|validate [id] [--root <self-root>]\n  link add|status|remove|setup|activate|deactivate|repair|doctor --project <dir> [--self <dir>]\n  link skill migrate-global --project <dir> [--skill-home <dir>] [--dry-run|--yes]\n  context [--project <dir>] [--lens <lens>] [--task <text>] [--json] [--snapshot --restricted-host --expires-hours <n>]\n  analyze overlap|conflicts|stale|all --project <dir>\n  propose --project <dir> [--claim <text> --source-file <path>]\n  proposals list|audit --project <dir>\n  proposals show|approve|reject|defer|supersede <id> --project <dir>\n  index [status|rebuild] --project <dir> [--changed]\n  search <query> --project <dir> [--federated]\n  instructions render|audit --project <dir> [--json]\n  knowledge cleanup [--output <plan>] | --apply <plan> --digest <sha256> --yes\n\nData root: HOLOSELF_HOME or --data-dir <dir> (argument overrides environment).\nActivation: --activate auto|all|<list> --platform <id> --instructions <file> --install-skill auto|project|global|none --no-activate.\nProject filters: --project-include/--project-exclude and --project-assert-include/--project-assert-exclude <globs>.
Efficiency: context supports --budget small|standard|deep|unbounded, --manifest, repeatable --source, and --temporal current|historical|superseded|all.\nInstruction consolidation: instructions render|audit --project <dir>.\nSafety confirmations: --yes. Packet adapters: --adapter pi|claude|codex|generic|obsidian|restricted-host.\nMCP: mcp [--project <linked-project>] | mcp configure|status --project <dir> [--platform codex|agy|claude].\n`) }
async function confirm(o,message){if(o.yes)return true; if(!input.isTTY||!output.isTTY) throw new Error(`${message} Re-run with --yes to confirm.`); const rl=createInterface({input,output}); try { const answer=await rl.question(`${message} Type "yes" to continue: `); return answer.trim().toLowerCase()==='yes' } finally { rl.close() }}
export async function run(argv){
  const o=parse(argv)
  if(o.version){console.log(o.json?JSON.stringify({schemaVersion:1,product:'holoself',version:VERSION}):`Holoself ${VERSION}`);return}
  if(o.command==='capabilities'){
    console.log(JSON.stringify({schemaVersion:1,product:'holoself',version:VERSION,interface:'local-cli',contextSchemaVersion:1,commands:['doctor','context','search','propose','proposals','instructions','knowledge','link','skill','mcp'],contextFeatures:['need-gate','budgets','manifest','source-handles','lifecycle','receipts','persistent-cache','task-contrib-routing'],proposalSchemaVersions:[1,2],indexSchemaVersion:5,mcp:{transport:'stdio',projectBound:true,linkAuthority:true,tools:['holoself_status','holoself_context_manifest','holoself_context_get','holoself_search','holoself_proposal_create','holoself_proposal_preview']},globalSkillSupported:true},null,2));return
  }
  if(o.help||!o.command){help();return}
  const root=o.root
  if(o.command==='web'){
    const {startWebServer}=await import('./web-server.mjs');const app=await startWebServer({project:o.project||process.cwd(),root:o.rootExplicit?root:undefined,port:o.port??0});console.log(`Holoself Workbench: ${app.url}\nData root: ${app.root}${app.project?`\nLinked project: ${app.project}`:''}`)
    if(!o.noOpen){const {spawn}=await import('node:child_process');const command=process.platform==='win32'?'cmd':process.platform==='darwin'?'open':'xdg-open';const args=process.platform==='win32'?['/c','start','',app.url]:[app.url];spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true}).unref()}
    return
  }
  if(o.command==='mcp'){
    const action=o.args[0]
    if(!action){const {startMcpServer}=await import('./mcp-server.mjs');await startMcpServer({project:o.project,requireClaudeProject:o.claudeProjectDir});return}
    if(!o.project)throw new Error(`mcp ${action} requires --project <linked-project>`)
    const {applyMcpConfiguration,mcpConfigurationPlan,mcpConfigurationStatus}=await import('./mcp-config.mjs')
    if(action==='status'){console.log(JSON.stringify(mcpConfigurationStatus(o.project,{platforms:o.platforms||[]}),null,2));return}
    if(action!=='configure')throw new Error('mcp requires no subcommand, status, or configure')
    const plan=mcpConfigurationPlan(o.project,{platforms:o.platforms||[]}),publicPlan={...plan,_changes:undefined};console.log(JSON.stringify({configuration_plan:publicPlan},null,2));if(o.dryRun)return
    if(!await confirm(o,`Configure local STDIO MCP files for ${plan.changes.map(change=>change.platform).join(', ')} in ${o.project}?`))return
    console.log(JSON.stringify(applyMcpConfiguration(o.project,{platforms:o.platforms||[]}),null,2));return
  }
  if(o.command==='data-root'){console.log(root);return}
  if(o.command==='knowledge'){
    if(o.args[0]!=='cleanup')throw new Error('knowledge requires cleanup')
    if(o.apply){if(!o.yes)throw new Error('knowledge cleanup --apply requires --yes');const plan=JSON.parse(readFileSync(o.apply,'utf8')),result=applyCleanupPlan(root,plan,{expectedDigest:o.digest});console.log(JSON.stringify(result,null,2));return}
    const plan=buildCleanupPlan(root);if(o.output){atomicWrite(o.output,JSON.stringify(plan,null,2)+'\n');console.log(JSON.stringify({status:'planned',plan_path:o.output,digest:plan.digest,operations:plan.operations,review_only:plan.review_only},null,2))}else console.log(JSON.stringify(plan,null,2));return
  }
  if(await runEcosystem(o)) return
  if(o.command==='init'){
    ensureDir(root); for(const name of ['context','topics','reference','me','exports','history']) ensureDir(join(root,name));for(const state of ['pending','approved','rejected','deferred','superseded'])ensureDir(join(root,'proposals',state)); ensureDir(join(root,'contribs','local')); ensureDir(join(root,'profile'))
    if(!existsSync(join(root,'topics','.current'))) atomicWrite(join(root,'topics','.current'),'')
    if(!existsSync(join(root,'reference','README.md'))) atomicWrite(join(root,'reference','README.md'),'# Private reference\n\nKeep private reference material here. It is never published as a public contrib.\n')
    if(!existsSync(join(root,'me','contribs.md'))) atomicWrite(join(root,'me','contribs.md'),'# Local self-model extensions\n\nList private contrib paths here when needed.\n')
    for(const [name,body] of Object.entries(PROFILE_FILES)){const p=join(root,'profile',name); if(!existsSync(p))atomicWrite(p,body)}
    for(const [name,body] of Object.entries(CONTEXT_FILES)){const p=join(root,'context',name); if(!existsSync(p))atomicWrite(p,body)}
    // Keep data-root guidance beside private data. Bounded injection preserves user text.
    inject(root,'AGENTS.md',false,rootSection(),ROOT_START,ROOT_END)
    const old=readConfig(root); const contribs=selectedContribs(o, old?.selectedContribs)
    json(configPath(root),{schemaVersion:1,product:'holoself',selectedContribs:contribs,createdAt:old?.createdAt || new Date().toISOString()})
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
    errors.push(...ecosystemValidationErrors(root,o.project))
    for(const e of [...new Set(errors)])console.error(`[!!] ${e}`); if(errors.length){process.exitCode=1}else console.log(`[ok] ${root} is valid`); return
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
    if(isEcosystemMetadata(out))throw new Error(`${out} contains linked-ecosystem metadata; refusing legacy export overwrite`)
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
    const c=readConfig(root); if(!c)throw new Error('config.json missing; run init first'); const ids=selectedContribs(o,c.selectedContribs); if(!o.dryRun){c.selectedContribs=ids;json(configPath(root),c)} console.log(`${o.dryRun?'[dry-run] ':''}[ok] refreshed public contrib availability; product files remain package-owned`);return
  }
  throw new Error(`unknown command: ${o.command}`)
}
