import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run } from '../src/cli.mjs'
import { activationStatus, globalSkillStatus, installGlobalSkills, safeProjectFile, deactivateProject } from '../src/adapters.mjs'
import { inspectSkillFile } from '../src/skill-paths.mjs'

const temp=()=>mkdtempSync(join(tmpdir(),'holoself-deployments-'))
const publicSkill=readFileSync(new URL('../skills/holoself/SKILL.md',import.meta.url),'utf8')
async function capture(fn){const original=console.log;let out='';console.log=(...args)=>out+=args.join(' ')+'\n';try{await fn();return out}finally{console.log=original}}
function deployment(root,rel,target){const path=join(root,rel);mkdirSync(dirname(path),{recursive:true});symlinkSync(target,path,'junction');return path}
function library(){const root=temp();writeFileSync(join(root,'SKILL.md'),publicSkill);return root}

test('global terminal deployments are current and read-only; changed or broken deployments remain blocked under force',()=>{
 const home=temp(),target=library(),path=deployment(home,'.codex/skills/holoself',target),options={skillHome:home,platforms:['codex']}
 let item=globalSkillStatus(options).installations[0];assert.equal(item.installed,true);assert.equal(item.readOnly,true);assert.equal(item.status,'full-public-skill-current');assert.equal(installGlobalSkills(options).installations[0].action,'unchanged');assert.equal(readFileSync(join(target,'SKILL.md'),'utf8'),publicSkill);assert.ok(lstatSync(path).isSymbolicLink())
 writeFileSync(join(target,'SKILL.md'),publicSkill+'\nUnreviewed instruction.\n');item=globalSkillStatus(options).installations[0];assert.equal(item.status,'external-content-mismatch');assert.equal(item.installed,false);assert.equal(installGlobalSkills({...options,dryRun:true}).installations[0].action,'blocked');assert.throws(()=>installGlobalSkills({...options,force:true}),/deployment-manager repair/);assert.match(readFileSync(join(target,'SKILL.md'),'utf8'),/Unreviewed/)
 rmSync(join(target,'SKILL.md'));assert.equal(globalSkillStatus(options).installations[0].installed,false);assert.throws(()=>installGlobalSkills({...options,force:true}),/repair/);assert.ok(lstatSync(path).isSymbolicLink())
})

test('global status rejects ancestor links, linked target ancestors and linked SKILL.md without throwing',()=>{
 const target=library(),home=temp();deployment(home,'.claude/skills',target);assert.equal(globalSkillStatus({skillHome:home,platforms:['claude']}).installations[0].installed,false)
 const source=temp(),alias=temp();deployment(alias,'redirect',target);deployment(source,'.codex/skills/holoself',join(alias,'redirect'));assert.equal(globalSkillStatus({skillHome:source,platforms:['codex']}).installations[0].status,'unsafe')
 const second=library(),fileTarget=library(),home2=temp();rmSync(join(second,'SKILL.md'));symlinkSync(join(fileTarget,'SKILL.md'),join(second,'SKILL.md'),'file');deployment(home2,'.codex/skills/holoself',second);assert.equal(globalSkillStatus({skillHome:home2,platforms:['codex']}).installations[0].installed,false)
 const home3=temp(),broken=join(temp(),'absent');deployment(home3,'.codex/skills/holoself',broken);assert.equal(globalSkillStatus({skillHome:home3,platforms:['codex']}).installations[0].installed,false)
 assert.equal(inspectSkillFile(home2,'../outside').status,'unsafe')
})

test('Codex supplies the public global skill while generic instructions remain the fallback; local current deployments do not degrade doctor',async()=>{
 const root=temp(),project=temp(),home=temp(),target=library();deployment(home,'.codex/skills/holoself',target);await capture(()=>run(['init','--root',root]));await capture(()=>run(['link','add','--project',project,'--self',root,'--platform','codex','--install-skill','global','--skill-home',home,'--yes']))
 assert.equal(existsSync(join(home,'.agents','skills','holoself','SKILL.md')),false);assert.ok(existsSync(join(project,'AGENTS.md')));const local=deployment(project,'.claude/skills/holoself',target),before=readFileSync(join(target,'SKILL.md'),'utf8');let status=activationStatus(project,{skillHome:home});assert.deepEqual(status.globalSkillInstallations.map(item=>item.id),['codex']);assert.deepEqual(status.projectSkillOverrides,[]);assert.ok(status.projectSkillDeployments.some(item=>item.external&&item.installed&&item.readOnly))
 const doctor=JSON.parse(await capture(()=>run(['link','doctor','--project',project,'--skill-home',home])));assert.equal(doctor.state,'activated');assert.equal(doctor.checks.project_skill_overrides,'absent');assert.throws(()=>safeProjectFile(project,'.claude/skills/holoself/SKILL.md'),/symlink/);assert.throws(()=>deactivateProject(project),/symlink/);assert.equal(readFileSync(join(target,'SKILL.md'),'utf8'),before);assert.ok(lstatSync(local).isSymbolicLink())
 writeFileSync(join(target,'SKILL.md'),before+'\nChanged.\n');status=activationStatus(project,{skillHome:home});assert.equal(status.projectSkillOverrideDetails[0].status,'external-content-mismatch');const degraded=JSON.parse(await capture(()=>run(['link','doctor','--project',project,'--skill-home',home])));assert.equal(degraded.state,'degraded');assert.match(degraded.errors.join(' '),/deployment manager/);process.exitCode=0
})

test('Pi global discovery uses agent/skills and never the old project-style global folder',()=>{
 const home=temp(),target=library();deployment(home,'.pi/agent/skills/holoself',target);const status=globalSkillStatus({skillHome:home,platforms:['pi']});assert.equal(status.installations[0].file,'.pi/agent/skills/holoself/SKILL.md');assert.equal(status.installations[0].installed,true);assert.equal(existsSync(join(home,'.pi','skills')),false)
})

test('permission-denied inspection stays unreadable and force does not bypass it',()=>{
 const home=temp(),target=library();deployment(home,'.codex/skills/holoself',target);const options={skillHome:home,platforms:['codex']},original=fs.readFileSync
 fs.readFileSync=(path,...args)=>{if(path===join(target,'SKILL.md')){const error=new Error('simulated permission denied');error.code='EACCES';throw error}return original(path,...args)};syncBuiltinESMExports()
 try{const item=globalSkillStatus(options).installations[0];assert.equal(item.status,'unreadable');assert.equal(item.installed,false);assert.throws(()=>installGlobalSkills({...options,force:true}),/repair/)}finally{fs.readFileSync=original;syncBuiltinESMExports()}
 assert.equal(readFileSync(join(target,'SKILL.md'),'utf8'),publicSkill)
})
test('managed project writes reject broken deployment junctions before creating the target',()=>{
 const project=temp(),outside=join(temp(),'absent');deployment(project,'.agents/skills/holoself',outside);assert.throws(()=>safeProjectFile(project,'.agents/skills/holoself/SKILL.md'),/symlink/);assert.equal(existsSync(outside),false)
})
