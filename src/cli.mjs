import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, cpSync,
  rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

export const VERSION = '0.1.0'
const START = '<!-- holoself-export-start -->'
const END = '<!-- holoself-export-end -->'
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const DEFAULT_CONTRIBS = ['communication']
const PROFILE_FILES = {
  'identity.md': '# Identity\n\nWrite a short description of who you are.\n',
  'preferences.md': '# Preferences\n\nDescribe how you prefer to work with AI tools.\n',
  'voice.md': '# Voice\n\nDescribe your writing voice.\n',
  'thinking.md': '# Thinking\n\nDescribe how you reason and make decisions.\n',
  'work-context.md': '# Work context\n\nDescribe current work and priorities.\n'
}
function defaultRoot(){ return process.env.HOLOSELF_DATA_ROOT || join(homedir(), '.holoself') }
function parse(args){
  const o={rootSetup:false}; const positional=[]
  for(let i=0;i<args.length;i++){
    const a=args[i]
    if(a==='--root'||a==='--data-root') o.root=resolve(args[++i] || '')
    else if(a==='--target') o.target=resolve(args[++i] || '')
    else if(a==='--from') o.from=resolve(args[++i] || '')
    else if(a==='--contribs') o.contribs=(args[++i]||'').split(',').map(x=>x.trim()).filter(Boolean)
    else if(a==='--exclude-contrib') o.exclude=(args[++i]||'').split(',').map(x=>x.trim()).filter(Boolean)
    else if(a==='--yes'||a==='--confirm') o.yes=true
    else if(a==='--root-setup') o.rootSetup=true
    else if(a==='--force') o.force=true
    else if(a==='--dry-run') o.dryRun=true
    else if(a==='--help'||a==='-h') o.help=true
    else positional.push(a)
  }
  o.root=o.root||defaultRoot(); o.command=positional[0]; o.args=positional.slice(1)
  return o
}
function ensureDir(p){ mkdirSync(p,{recursive:true}) }
function json(p,v){ writeFileSync(p,JSON.stringify(v,null,2)+'\n','utf8') }
function configPath(root){return join(root,'config.json')}
function selectedContribs(o){ return (o.contribs || DEFAULT_CONTRIBS).filter(x=>!(o.exclude||[]).includes(x)) }
function packet(root){
  const files=[]
  for(const d of ['profile','context']){
    const dir=join(root,d); if(!existsSync(dir)) continue
    const walk=(p)=>{for(const e of readdirSync(p,{withFileTypes:true})){const x=join(p,e.name); if(e.isDirectory()) walk(x); else if(e.name.endsWith('.md')) files.push(relative(root,x).replaceAll('\\','/'))}}
    walk(dir)
  }
  files.sort()
  return `# Holoself context packet\n\nRead this packet first. It is generated from local files under this data root.\n\n${files.map(f=>`- ${f}`).join('\n')}\n`
}
function rootSection(){return `${START}\n## Holoself context\n\nLoad \.holoself/context-packet.md first.\nIf needed, read relevant files under \.holoself/profile/ and \.holoself/context/.\nDo not write durable context silently: propose changes and ask approval.\n${END}\n`}
function inject(target,file,dryRun){
  const p=join(target,file); const old=existsSync(p)?readFileSync(p,'utf8'):''; const section=rootSection();
  const re=new RegExp(`${START}[\\s\\S]*?${END}\\n?`)
  const next=re.test(old)?old.replace(re,section):(old.trimEnd()?old.trimEnd()+'\n\n':'')+section
  if(!dryRun) writeFileSync(p,next,'utf8')
  return existsSync(p)?(re.test(old)?'updated':'appended'):'created'
}
function copyData(from,to,force=false){
  const walk=(source,dest)=>{ ensureDir(dest); for(const entry of readdirSync(source,{withFileTypes:true})){ const s=join(source,entry.name), d=join(dest,entry.name); if(entry.isDirectory()) walk(s,d); else if(force || !existsSync(d) || Object.values(PROFILE_FILES).includes(readFileSync(d,'utf8'))) cpSync(s,d,{force:true}) } }
  for(const name of ['profile','context','topics']) if(existsSync(join(from,name))) walk(join(from,name),join(to,name))
}
function help(){console.log(`Holoself ${VERSION}\n\nUsage: holoself <command> [options]\n\nCommands:\n  data-root                 Print private data root\n  init [--contribs a,b]     Create private data root and starter files\n  doctor                    Check installation and data root\n  validate                 Validate private data root and generated markers\n  migrate --from <dir>      Import PersonalOS data without publishing it\n  export --target <dir>     Export reviewable packet to a project\n  link --target <dir>       Link project .holoself to data root\n  unlink --target <dir>     Remove only a Holoself-managed link\n  upgrade                   Refresh selected public defaults\n\nOptions: --root <dir> --target <dir> --yes --dry-run --force\n`)}
async function confirm(o,message){if(o.yes)return true; if(!input.isTTY||!output.isTTY) throw new Error(`${message} Re-run with --yes to confirm.`); const rl=createInterface({input,output}); const answer=await rl.question(`${message} Type "yes" to continue: `); rl.close(); return answer.trim().toLowerCase()==='yes'}
export async function run(argv){
  const o=parse(argv); if(o.help||!o.command){help();return}
  const root=o.root
  if(o.command==='data-root'){console.log(root);return}
  if(o.command==='init'){
    ensureDir(root); ensureDir(join(root,'context')); ensureDir(join(root,'topics')); ensureDir(join(root,'contribs','local'))
    for(const [name,body] of Object.entries(PROFILE_FILES)){const p=join(root,'profile',name); ensureDir(join(root,'profile')); if(!existsSync(p))writeFileSync(p,body)}
    const contribs=selectedContribs(o); json(configPath(root),{schemaVersion:1,product:'holoself',selectedContribs:contribs,createdAt:new Date().toISOString()})
    const defaults=join(PACKAGE_ROOT,'contribs','default'); for(const id of contribs){const source=join(defaults,`${id}.md`); if(existsSync(source)) cpSync(source,join(root,'contribs','default',`${id}.md`),{force:true})}
    console.log(`[ok] initialized ${root}`); console.log(`Contribs: ${contribs.join(', ')||'(none)'}`);return
  }
  if(o.command==='doctor'){
    const checks=[['node',Number(process.versions.node.split('.')[0])>=20],['data root',existsSync(root)],['config',existsSync(configPath(root))],['profile',existsSync(join(root,'profile'))]]
    checks.forEach(([n,ok])=>console.log(`${ok?'[ok]':'[!!]'} ${n}`)); if(checks.some(([,ok])=>!ok))process.exitCode=1; return
  }
  if(o.command==='validate'){
    const errors=[]; if(!existsSync(root))errors.push('data root does not exist');
    if(existsSync(configPath(root))){try{const c=JSON.parse(readFileSync(configPath(root),'utf8')); if(c.schemaVersion!==1)errors.push('unsupported config schema'); if(!Array.isArray(c.selectedContribs))errors.push('selectedContribs must be an array')}catch{errors.push('config.json is invalid JSON')}} else errors.push('config.json missing')
    for(const name of Object.keys(PROFILE_FILES))if(!existsSync(join(root,'profile',name)))errors.push(`missing profile/${name}`)
    for(const e of errors)console.error(`[!!] ${e}`); if(errors.length){process.exitCode=1}else console.log(`[ok] ${root} is valid`); return
  }
  if(o.command==='migrate'){
    if(!o.from)throw new Error('migrate requires --from <PersonalOS directory>')
    const source=existsSync(join(o.from,'personal'))?join(o.from,'personal'):o.from
    if(!existsSync(source))throw new Error(`source not found: ${source}`)
    if(!await confirm(o,`Copy personal data from ${source} to ${root}?`)) {console.log('Cancelled.');return}
    if(!o.dryRun)copyData(source,root,o.force); console.log(`${o.dryRun?'[dry-run] ':'[ok] '}migrated private data; nothing was published`); return
  }
  if(o.command==='export'){
    if(!o.target)throw new Error('export requires --target <project>'); if(!existsSync(root))throw new Error('data root missing; run init first')
    ensureDir(o.target); const out=join(o.target,'.holoself'); if(!o.dryRun){ensureDir(out);writeFileSync(join(out,'context-packet.md'),packet(root));writeFileSync(join(out,'README.md'),'# Holoself project context\n\nThis folder is generated locally. Do not commit it unless reviewed.\n')} console.log(`${o.dryRun?'[dry-run] ':''}[ok] exported packet to ${out}`)
    if(o.rootSetup){if(!await confirm(o,'Modify project instruction files with a bounded Holoself section?'))return; for(const f of ['AGENTS.md','CLAUDE.md','CODEX.md'])console.log(` - ${f}: ${inject(o.target,f,o.dryRun)}`)} return
  }
  if(o.command==='link'){
    if(!o.target)throw new Error('link requires --target <project>'); ensureDir(o.target); const p=join(o.target,'.holoself'); if(existsSync(p)&&!o.force)throw new Error(`${p} exists; use --force only to replace it`); if(!o.dryRun){rmSync(p,{recursive:true,force:true});symlinkSync(root,p,process.platform==='win32'?'junction':'dir')} console.log(`${o.dryRun?'[dry-run] ':'[ok] '}linked ${p} -> ${root}`);return
  }
  if(o.command==='unlink'){
    if(!o.target)throw new Error('unlink requires --target <project>'); const p=join(o.target,'.holoself'); if(!existsSync(p)){console.log('[ok] no link found');return} if(!lstatSync(p).isSymbolicLink())throw new Error(`${p} is not a Holoself link; refusing to remove`); if(!o.dryRun)rmSync(p,{recursive:true,force:true}); console.log(`${o.dryRun?'[dry-run] ':''}[ok] unlinked ${p}`);return
  }
  if(o.command==='upgrade'){
    ensureDir(join(root,'contribs','default')); const source=join(PACKAGE_ROOT,'contribs','default'); if(existsSync(source)&&!o.dryRun)cpSync(source,join(root,'contribs','default'),{recursive:true,force:true}); console.log(`${o.dryRun?'[dry-run] ':''}[ok] refreshed public defaults`);return
  }
  throw new Error(`unknown command: ${o.command}`)
}
