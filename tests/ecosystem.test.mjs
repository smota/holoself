import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run } from '../src/cli.mjs'
import { ecosystemValidationErrors } from '../src/ecosystem.mjs'
import { migrateProjectSkillsToGlobal } from '../src/adapters.mjs'

async function temp(){return mkdtemp(join(tmpdir(),'holoself-eco-'))}
async function capture(fn){const old=console.log;let out='';console.log=(...x)=>{out+=x.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}
async function fixture(){
  const self=await temp(),project=await temp()
  await run(['init','--root',self])
  await writeFile(join(self,'profile','identity.md'),'---\nvisibility: linked-projects\nconfidence: confirmed\n---\n# Identity\n\nBuilds regulated AI systems.\n')
  await writeFile(join(self,'context','career.md'),'---\nvisibility: career\npublic_safe: false\n---\n# Career\n\nLed 20 engineers in regulated AI.\n')
  await writeFile(join(self,'context','publishing.md'),'---\nvisibility: publishing\npublic_safe: true\n---\n# Publishing\n\nWrite evidence-first posts.\n')
  await writeFile(join(self,'context','admin.md'),'---\nvisibility: private\n---\n# Admin\n\nPrivate logistics.\n')
  await mkdir(join(project,'Context'),{recursive:true})
  await writeFile(join(project,'Context','career-profile.md'),'# Career profile\n\nLed 25 engineers in regulated AI.\n')
  await writeFile(join(project,'README.md'),'# Project\n\nRegulated AI execution workspace.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','career','--yes'])
  return {self,project}
}

test('linked configuration is project-local metadata and never copies self',async()=>{
  const {self,project}=await fixture();const yaml=await readFile(join(project,'.holoself','link.yaml'),'utf8')
  assert.match(yaml,/self_context:/);assert.match(yaml,/access: "read"/);assert.match(yaml,/default_lens: "career"/)
  for(const dir of ['index','proposals','reports'])assert.equal((await stat(join(project,'.holoself',dir))).isDirectory(),true)
  await assert.rejects(access(join(project,'.holoself','profile')))
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project])))
  assert.equal(status.self_context.path.replaceAll('\\','/'),self.replaceAll('\\','/'));assert.equal(status.self_exists,true)
})

test('context resolves lens, task, provenance, privacy, and adapters',async()=>{
  const {project}=await fixture()
  const career=JSON.parse(await capture(()=>run(['context','--project',project,'--task','regulated AI','--json'])))
  assert.equal(career.lens,'career');assert.ok(career.sources.some(x=>x.path==='context/career.md'));assert.ok(career.sources.some(x=>x.kind==='project'))
  assert.ok(!career.sources.some(x=>x.path==='context/admin.md'));assert.ok(career.restrictions.some(x=>x.source==='context/admin.md'))
  assert.ok(career.sources.every(x=>x.path&&x.kind&&x.freshness))
  await writeFile(join(project,'Context','compensation.md'),'# Compensation\n\nSalary: 100000\n')
  const packet=await capture(()=>run(['context','--project',project,'--lens','publishing','--format','packet','--adapter','claude']))
  assert.match(packet,/Claude Code context packet/);assert.match(packet,/context\/publishing.md/);assert.doesNotMatch(packet,/Led 20 engineers|100000/);assert.match(packet,/field compensation excluded/)
})

test('analysis writes recommendation reports without mutating source',async()=>{
  const {project}=await fixture();const before=await readFile(join(project,'Context','career-profile.md'),'utf8')
  const report=JSON.parse(await capture(()=>run(['analyze','all','--project',project])))
  assert.ok(report.findings.some(x=>['Contradiction','Candidate for self','Project-specific content','Semantic duplicate'].includes(x.classification)))
  assert.equal(await readFile(join(project,'Context','career-profile.md'),'utf8'),before)
  await access(report.report_path);assert.ok(report.findings.every(x=>x.recommendation&&x.evidence))
})

test('proposal lifecycle requires confirmation, preserves evidence, and validates approval',async()=>{
  const {self,project}=await fixture()
  const made=JSON.parse(await capture(()=>run(['propose','--project',project,'--claim','Led 25 engineers in regulated AI.','--evidence','Context/career-profile.md, reviewed metric','--source-file','Context/career-profile.md','--target-file','context/claims.md','--proposal-type','fact_update','--confidence','confirmed','--visibility','private'])))
  await assert.rejects(run(['proposals','approve',made.proposal_id,'--project',project]),/Re-run with --yes/)
  const approved=await capture(()=>run(['proposals','approve',made.proposal_id,'--project',project,'--yes']))
  assert.match(approved,/proposed diff/);assert.match(approved,/validation passed/)
  const canonical=await readFile(join(self,'context','claims.md'),'utf8');assert.match(canonical,/Led 25 engineers/);assert.match(canonical,/Provenance:/);assert.match(canonical,/holoself-claim visibility=private/)
  const general=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','general','--json'])));assert.ok(!general.self.documents.some(x=>x.content.includes('Led 25 engineers')))
  const local=await readFile(join(project,'.holoself','proposals',`${made.proposal_id}.yaml`),'utf8');assert.match(local,/status: "approved"/)
  await access(join(self,'proposals','approved',`${made.proposal_id}.yaml`))
  const second=JSON.parse(await capture(()=>run(['propose','--project',project,'--claim','New preference','--source-file','README.md'])))
  await run(['proposals','defer',second.proposal_id,'--project',project,'--yes']);assert.match(await readFile(join(project,'.holoself','proposals',`${second.proposal_id}.yaml`),'utf8'),/status: "deferred"/)
})

test('terminal legacy proposal records preserve folded text and external evidence paths',async()=>{
  const {project}=await fixture(),id='11111111-2222-4333-8444-555555555555',file=join(project,'.holoself','proposals',`${id}.yaml`)
  await writeFile(file,`proposal_id: "${id}"\nsource_project: "Legacy review"\nsource_project_path: "C:/legacy"\nsource_files:\n  - "C:/legacy/evidence.md"\ntarget: "context/preferences.md and profile/preferences.md"\nproposal_type: "preference_update"\nclaim: >-\n  Preserve folded legacy preference\n  wording without mutation.\nevidence: |-\n  Historical external evidence.\nconfidence: "confirmed"\nvisibility: "private"\nstatus: "approved"\ncreated_at: "2026-08-24T00:00:00Z"\nprovenance:\n  - "Legacy migration"\n`)
  const listed=JSON.parse(await capture(()=>run(['proposals','list','--project',project]))),record=listed.find(x=>x.proposal_id===id);assert.equal(record.proposal_type,'preference_update');assert.equal(record.claim,'Preserve folded legacy preference wording without mutation.');assert.equal(record.evidence,'Historical external evidence.')
})

test('deterministic index supports changed/rebuild/search and skips secrets',async()=>{
  const {project}=await fixture();await writeFile(join(project,'secret.md'),'# Secret\n\napi_key = abcdefghijklmnop\n')
  const built=JSON.parse(await capture(()=>run(['index','rebuild','--project',project])));assert.equal(built.engine,'deterministic-json');assert.equal(built.skipped_secret_files,1)
  const raw=await readFile(join(project,'.holoself','index','index.json'),'utf8');assert.doesNotMatch(raw,/abcdefghijklmnop/);assert.match(raw,/content_hash/);assert.match(raw,/sections/)
  const found=JSON.parse(await capture(()=>run(['search','regulated AI','--project',project,'--federated'])));assert.ok(found.results.length>0);assert.ok(found.results.every(x=>x.provenance&&x.visibility&&x.freshness))
  await run(['index','--project',project,'--changed']);const status=JSON.parse(await capture(()=>run(['index','status','--project',project])));assert.equal(status.status,'ready')
})

test('canonical duplicate validation ignores repeated structured metadata and compares approved wording',async()=>{
  const self=await temp();await run(['init','--root',self])
  const claimRecord=(id,wording)=>`## CLAIM-${id} — Record\n\n- **Approved wording:** ${wording}\n- **Confidence:** confirmed\n- **Visibility:** private\n- **Sensitivity:** personal\n- **Allowed usage:** linked projects\n- **Evidence:** EVIDENCE-${id}\n- **Last verified:** 2026-08-14\n`
  await writeFile(join(self,'context','claims.md'),`---\nvisibility: private\nsensitivity: personal\nconfidence: confirmed\n---\n# Canonical claims\n\n${claimRecord('ONE','First durable approved claim.') }\n${claimRecord('TWO','Second durable approved claim.')}`)
  await writeFile(join(self,'context','evidence.md'),`---\nvisibility: private\nsensitivity: personal\nconfidence: confirmed\n---\n# Evidence registry\n\n## EVIDENCE-ONE\n\n- **Source project:** Example\n- **Verified:** 2026-08-14\n- **Sensitivity:** personal\n- **Allowed usage:** linked projects\n\n## EVIDENCE-TWO\n\n- **Source project:** Example\n- **Verified:** 2026-08-14\n- **Sensitivity:** personal\n- **Allowed usage:** linked projects\n`)
  let errors=ecosystemValidationErrors(self);assert.ok(!errors.some(x=>x.includes('duplicate canonical claim')))
  await writeFile(join(self,'context','claims.md'),`# Canonical claims\n\n${claimRecord('ONE','Same actual approved claim.') }\n${claimRecord('TWO','Same actual approved claim.')}`)
  errors=ecosystemValidationErrors(self);assert.equal(errors.filter(x=>x.includes('duplicate canonical claim')).length,1);assert.match(errors.find(x=>x.includes('duplicate canonical claim')),/Same actual approved claim/)
})

test('validation reports link, visibility, reference, and proposal provenance errors',async()=>{
  const {self,project}=await fixture();await writeFile(join(self,'context','bad.md'),'---\nvisibility: internet\n---\n# Bad\n\n[missing](nowhere.md)\n');await writeFile(join(project,'.holoself','proposals','bad.yaml'),'proposal_id: "bad"\nstatus: "pending"\n')
  const errors=ecosystemValidationErrors(self,project);assert.ok(errors.some(x=>x.includes('invalid visibility internet')));assert.ok(errors.some(x=>x.includes('broken reference nowhere.md')));assert.ok(errors.some(x=>x.includes('proposal provenance')))
})

test('malformed links fail closed while valid reordered YAML lists parse',async()=>{
  const {self,project}=await fixture(),path=self.replaceAll('\\','/')
  await writeFile(join(project,'.holoself','link.yaml'),`self_context:\n  secondary_lenses:\n    - "leadership"\n    - "technical"\n  path: "${path}"\n  proposals: "enabled"\n  access: "read"\n  default_lens: "career"\n  index: "local"\n`)
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.deepEqual(status.self_context.secondary_lenses,['leadership','technical'])
  await writeFile(join(project,'.holoself','link.yaml'),`self_context:\n  path: "${path}" # canonical root\n  secondary_lenses: [leadership, technical] # valid flow list\n  access: read\n  proposals: enabled\n  index: local\n  default_lens: career\n`);const inline=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.deepEqual(inline.self_context.secondary_lenses,['leadership','technical'])
  await writeFile(join(project,'.holoself','link.yaml'),`self_context:\n  path: "${path}"\n  secondary_lenses: [leadership, leadership]\n  access: read\n  proposals: enabled\n  index: local\n  default_lens: career\n`)
  const broken=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.equal(broken.state,'broken');assert.match(broken.errors[0],/secondary_lenses must contain unique lenses/);process.exitCode=0
  const duplicateProject=await temp()
  await assert.rejects(run(['link','add','--project',duplicateProject,'--self',self,'--lens','career','--secondary-lenses','technical,technical']),/secondary_lenses must contain unique lenses/)
  await writeFile(join(project,'.holoself','link.yaml'),'self_context:\n  path: "broken"\n    access: "read"\n')
  await assert.rejects(run(['context','--project',project,'--root',self,'--json']),/malformed link configuration/)
})

test('proposal identifiers, containment, filenames, and schemas fail closed',async()=>{
  const {project}=await fixture(),id='11111111-1111-4111-8111-111111111111'
  await assert.rejects(run(['proposals','show','../../outside','--project',project]),/invalid proposal id/)
  await writeFile(join(project,'.holoself','proposals',`${id}.yaml`),`proposal_id: "${id}"\nsource_project: "project"\nsource_files:\n  - "README.md"\ntarget: "../../outside.md"\nproposal_type: "new_fact"\nclaim: "unsafe"\nevidence: "README"\nconfidence: "confirmed"\nvisibility: "private"\nstatus: "pending"\ncreated_at: "2026-08-14T00:00:00.000Z"\nprovenance:\n  - "project:README.md"\nunknown_field: "no"\n`)
  await assert.rejects(run(['proposals','show',id,'--project',project]),/unknown proposal field|contained relative Markdown path/)
  await writeFile(join(project,'.holoself','proposals','22222222-2222-4222-8222-222222222222.yaml'),`proposal_id: "33333333-3333-4333-8333-333333333333"\nsource_project: "project"\nsource_files:\n  - "README.md"\ntarget: "context/x.md"\nproposal_type: "new_fact"\nclaim: "claim"\nevidence: "evidence"\nconfidence: "confirmed"\nvisibility: "private"\nstatus: "pending"\ncreated_at: "2026-08-14T00:00:00.000Z"\nprovenance:\n  - "project:README.md"\n`)
  const listed=JSON.parse(await capture(()=>run(['proposals','list','--project',project])));assert.deepEqual(listed,[])
  const audit=JSON.parse(await capture(()=>run(['proposals','audit','--project',project])));assert.ok(audit.diagnostics.some(item=>item.code==='INVALID_PROPOSAL'));process.exitCode=0
})

test('index and search enforce claim, field, compensation, metadata, and secret filters',async()=>{
  const {self,project}=await fixture()
  await writeFile(join(self,'context','privacy.md'),'---\nvisibility: linked-projects\nhome_address: 10 Secret Street\nfield_visibility:\n  Compensation: private\n---\n# Public\n\nApproved public phrase.\n\n## Compensation\n\nGolden package totals $210,000 with annual bonus.\n\n<!-- holoself-claim visibility=private -->\n## Private proof\n\nPrivate unicorn evidence phrase.\n<!-- /holoself-claim -->\n')
  await writeFile(join(project,'Context','role.md'),'# Role\n\nMy annual compensation totals USD 200000 plus bonus and equity.\n')
  await writeFile(join(project,'credentials-notes.md'),'# Credentials\n\nfilename secret phrase\n');await writeFile(join(project,'.env.md'),'# Environment\n\ninternal credential phrase\n');await writeFile(join(project,'bearer.md'),'# Auth\n\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n')
  const built=JSON.parse(await capture(()=>run(['index','rebuild','--project',project])));assert.ok(built.skipped_secret_files>=3)
  const raw=await readFile(join(project,'.holoself','index','index.json'),'utf8');assert.doesNotMatch(raw,/home_address|10 Secret Street|filename secret phrase|internal credential phrase|abcdefghijklmnopqrstuvwxyz/);assert.match(raw,/"schema_version": 5/)
  const generalClaim=JSON.parse(await capture(()=>run(['search','private unicorn','--project',project,'--lens','general'])));assert.equal(generalClaim.results.length,0)
  const privateClaim=JSON.parse(await capture(()=>run(['search','private unicorn','--project',project,'--lens','private'])));assert.ok(privateClaim.results.length>0)
  const field=JSON.parse(await capture(()=>run(['search','golden package','--project',project,'--lens','general'])));assert.equal(field.results.length,0)
  const publishingSearch=JSON.parse(await capture(()=>run(['search','annual compensation bonus equity','--project',project,'--lens','publishing'])));assert.equal(publishingSearch.results.length,0)
  const publishingPacket=await capture(()=>run(['context','--project',project,'--lens','publishing','--format','packet']));assert.doesNotMatch(publishingPacket,/200000|210,000|annual bonus|bonus and equity/);assert.match(publishingPacket,/compensation content excluded|field Compensation excluded/)
})

test('metadata collisions, legacy export overwrite, and unknown flags fail safely',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'.holoself'));await writeFile(join(project,'.holoself','README.md'),'# User metadata\nKeep me.\n')
  await assert.rejects(run(['link','add','--project',project,'--self',self]),/metadata collision/);assert.equal(await readFile(join(project,'.holoself','README.md'),'utf8'),'# User metadata\nKeep me.\n')
  await assert.rejects(run(['link','add','--project',project,'--self',self,'--force']),/Re-run with --yes/)
  await run(['link','add','--project',project,'--self',self,'--force','--yes']);assert.equal(await readFile(join(project,'.holoself','README.md'),'utf8'),'# User metadata\nKeep me.\n')
  await assert.rejects(run(['export','--root',self,'--target',project]),/linked-ecosystem metadata/);await access(join(project,'.holoself','link.yaml'))
  await assert.rejects(run(['link','remove','--project',project,'--yees']),/unknown option: --yees/);await access(join(project,'.holoself','link.yaml'))
})

test('link setup is inspect-first and remove preserves review artifacts',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await writeFile(join(project,'CLAUDE.md'),'# Instructions\n');await writeFile(join(project,'profile.md'),'# Profile\n')
  const preview=await capture(()=>run(['link','setup','--project',project]));assert.match(preview,/suggested_lens/);assert.match(preview,/No changes made/);await assert.rejects(access(join(project,'.holoself','link.yaml')))
  await run(['link','setup','--project',project,'--self',self,'--yes']);await writeFile(join(project,'.holoself','reports','keep.json'),'{}')
  await assert.rejects(run(['link','remove','--project',project]),/Re-run with --yes/);await run(['link','remove','--project',project,'--yes']);await assert.rejects(access(join(project,'.holoself','link.yaml')));await access(join(project,'.holoself','reports','keep.json'))
})

test('link add activates detected agents with private bounded bootstrap and supports lifecycle',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await writeFile(join(project,'AGENTS.md'),'# User rules\n\nKeep me.\n');await writeFile(join(project,'CLAUDE.md'),'# Claude adapter\n')
  await assert.rejects(run(['link','add','--project',project,'--self',self]),/Re-run with --yes/)
  await run(['link','add','--project',project,'--self',self,'--lens','career','--yes'])
  const agents=await readFile(join(project,'AGENTS.md'),'utf8'),claude=await readFile(join(project,'CLAUDE.md'),'utf8'),bootstrap=await readFile(join(project,'.holoself','BOOTSTRAP.md'),'utf8'),runtime=JSON.parse(await readFile(join(project,'.holoself','runtime.json'),'utf8'))
  assert.match(agents,/Keep me/);assert.equal((agents.match(/holoself-link-start/g)||[]).length,1);assert.match(claude,/\.holoself\/BOOTSTRAP\.md/);assert.doesNotMatch(agents+claude+bootstrap,new RegExp(self.replaceAll('\\','\\\\')));assert.ok(runtime.activatedAdapters.some(x=>x.id==='agents'));assert.ok(runtime.activatedAdapters.some(x=>x.id==='claude'))
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.equal(status.state,'activated')
  await run(['link','repair','--project',project,'--yes']);assert.equal(((await readFile(join(project,'AGENTS.md'),'utf8')).match(/holoself-link-start/g)||[]).length,1)
  await run(['link','deactivate','--project',project,'--yes']);assert.doesNotMatch(await readFile(join(project,'AGENTS.md'),'utf8'),/holoself-link-start/);await access(join(project,'.holoself','link.yaml'))
  await run(['link','activate','--project',project,'--yes']);assert.match(await readFile(join(project,'AGENTS.md'),'utf8'),/holoself-link-start/)
})

test('all supported adapters can be activated explicitly',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await run(['link','add','--project',project,'--self',self,'--activate','all','--install-skill','project','--yes'])
  for(const file of ['AGENTS.md','CLAUDE.md','CODEX.md','PI.md','AGY.md','ANTIGRAVITY.md','GEMINI.md','.github/copilot-instructions.md','.cursor/rules/holoself.mdc','.windsurfrules'])assert.match(await readFile(join(project,file),'utf8'),/holoself-link-start/)
  const publicSkill=(await readFile(join(process.cwd(),'skills','holoself','SKILL.md'),'utf8')).replaceAll('\r\n','\n')
  for(const dir of ['.agents','.claude','.pi']){const installed=await readFile(join(project,dir,'skills','holoself','SKILL.md'),'utf8');assert.match(installed,/holoself-skill-start schema=1/);assert.match(installed,/## Canonical-root validation/);assert.ok(installed.includes(publicSkill.slice(publicSkill.indexOf('# Holoself'))))}
  const runtime=JSON.parse(await readFile(join(project,'.holoself','runtime.json'),'utf8'));assert.ok(runtime.skillInstallations.every(x=>x.kind==='full-public-skill'));assert.ok(Array.isArray(runtime.skillShims))
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.ok(status.skill_installations.every(x=>x.kind==='full-public-skill'));assert.equal(status.cli_command.invocation,'source-checkout');assert.equal(status.cli_command.available,'not-verified')
})

test('legacy shims upgrade and deactivation preserves appended user content',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);const file=join(project,'.agents','skills','holoself','SKILL.md');await mkdir(join(project,'.agents','skills','holoself'),{recursive:true});await writeFile(file,'---\nname: holoself\ndescription: Load linked whole-person context for this project.\n---\n\n<!-- holoself-skill-start schema=1 -->\n# Linked Holoself\n\nRead `.holoself/BOOTSTRAP.md` before substantive work. Use installed public Holoself skill when available. Resolve context through configured lens, preserve provenance and project ownership, and create proposals instead of editing canonical self directly.\n<!-- holoself-skill-end -->\n')
  await run(['link','add','--project',project,'--self',self,'--yes']);const upgraded=await readFile(file,'utf8');assert.match(upgraded,/description: Load and apply a user's local, reviewable Holoself context/);assert.match(upgraded,/## Canonical-root validation/);await writeFile(file,upgraded+'\n# User appendix\nKeep this.\n');await run(['link','deactivate','--project',project,'--yes']);const remaining=await readFile(file,'utf8');assert.match(remaining,/# User appendix/);assert.doesNotMatch(remaining,/holoself-skill-start/)
})

test('separately installed public skill is accepted and preserved',async()=>{
  const self=await temp(),project=await temp(),file=join(project,'.agents','skills','holoself','SKILL.md'),publicSkill=(await readFile(join(process.cwd(),'skills','holoself','SKILL.md'),'utf8')).replaceAll('\r\n','\n');await run(['init','--root',self]);await mkdir(dirname(file),{recursive:true});await writeFile(file,publicSkill.replaceAll('\n','\r\n'))
  await run(['link','add','--project',project,'--self',self,'--yes']);assert.equal(await readFile(file,'utf8'),publicSkill.replaceAll('\n','\r\n'));const status=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.equal(status.skill_installations[0].marker,'public');assert.equal(status.skill_installations[0].kind,'full-public-skill');await run(['link','deactivate','--project',project,'--yes']);assert.equal(await readFile(file,'utf8'),publicSkill.replaceAll('\n','\r\n'))
})

test('owned installation hash supports cross-version removal and none policy stays healthy',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await run(['link','add','--project',project,'--self',self,'--yes']);const file=join(project,'.agents','skills','holoself','SKILL.md'),runtimePath=join(project,'.holoself','runtime.json'),changed=(await readFile(file,'utf8')).replace("description: Load and apply a user's local, reviewable Holoself context across AI tools.",'description: Historical public skill metadata.');await writeFile(file,changed);const runtime=JSON.parse(await readFile(runtimePath,'utf8'));runtime.skillInstallations[0].contentHash=createHash('sha256').update(changed).digest('hex');await writeFile(runtimePath,JSON.stringify(runtime,null,2)+'\n');await run(['link','deactivate','--project',project,'--yes']);await assert.rejects(access(file))
  const repairProject=await temp();await run(['link','add','--project',repairProject,'--self',self,'--yes']);const repairFile=join(repairProject,'.agents','skills','holoself','SKILL.md');await writeFile(repairFile,(await readFile(repairFile,'utf8'))+'\n# User appendix\nPreserve after repair.\n');await run(['link','repair','--project',repairProject,'--yes']);await run(['link','deactivate','--project',repairProject,'--yes']);assert.match(await readFile(repairFile,'utf8'),/Preserve after repair/)
  const noneProject=await temp();await run(['link','add','--project',noneProject,'--self',self,'--install-skill','none','--yes']);const status=JSON.parse(await capture(()=>run(['link','status','--project',noneProject])));assert.equal(status.state,'activated');assert.equal(status.skill_install_policy,'none');const doctor=JSON.parse(await capture(()=>run(['link','doctor','--project',noneProject])));assert.equal(doctor.state,'activated');assert.equal(doctor.checks.skill_installation,'disabled')
})

test('real project structures exclude agent skills and parse folded YAML',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'.agents','skills','example'),{recursive:true});await mkdir(join(project,'Master'),{recursive:true});await mkdir(join(project,'Context'),{recursive:true})
  await writeFile(join(project,'.agents','skills','example','SKILL.md'),'---\nname: example\ndescription: >\n  folded YAML that belongs to another skill\n---\n# Private agent skill noise\n')
  await writeFile(join(project,'Master','career.md'),'---\nvisibility: career\npublic_safe: false\ndescription: >\n  valid arbitrary folded frontmatter\n---\n# Career\n\nProject evidence.\n');await writeFile(join(project,'Context','publishing.md'),'# Publishing\n\nProject publishing rules.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','career','--yes','--project-include','Master/**/*.md,Context/**/*.md'])
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--json'])));assert.ok(data.project.documents.some(x=>x.path==='Master/career.md'));assert.ok(!data.project.documents.some(x=>x.path.includes('.agents/skills')));assert.ok(!data.warnings.some(x=>x.includes('unsupported project frontmatter parsed conservatively')))
  const doctor=JSON.parse(await capture(()=>run(['link','doctor','--project',project])));assert.equal(doctor.checks.context,'valid')
  const snapshot=JSON.parse(await capture(()=>run(['context','--project',project,'--snapshot','--adapter','generic','--yes'])));assert.equal(snapshot.mode,'snapshot');assert.match(await readFile(join(project,'.holoself','runtime','context-packet.md'),'utf8'),/Holoself context packet/)
})

test('activation preflight blocks symlink parents, unmanaged skills, and reversed markers before writes',async()=>{
  const self=await temp();await run(['init','--root',self])
  const outside=await temp(),symlinkProject=await temp();await writeFile(join(outside,'CLAUDE.md'),'outside');await symlink(outside,join(symlinkProject,'.claude'),'junction')
  await assert.rejects(run(['link','add','--project',symlinkProject,'--self',self,'--platform','claude','--yes']),/traverses symlink/);assert.equal(await readFile(join(outside,'CLAUDE.md'),'utf8'),'outside');await assert.rejects(access(join(symlinkProject,'.holoself','link.yaml')))
  const skillProject=await temp();await mkdir(join(skillProject,'.agents','skills','holoself'),{recursive:true});await writeFile(join(skillProject,'.agents','skills','holoself','SKILL.md'),'# User-owned skill\n');await assert.rejects(run(['link','add','--project',skillProject,'--self',self,'--yes']),/existing unmanaged content/);assert.equal(await readFile(join(skillProject,'.agents','skills','holoself','SKILL.md'),'utf8'),'# User-owned skill\n');await assert.rejects(access(join(skillProject,'.holoself','link.yaml')));await run(['link','add','--project',skillProject,'--self',self,'--force','--yes']);const preservedSkill=await readFile(join(skillProject,'.agents','skills','holoself','SKILL.md'),'utf8');assert.match(preservedSkill,/User-owned skill/);assert.match(preservedSkill,/holoself-skill-start/)
  const markerProject=await temp();await writeFile(join(markerProject,'AGENTS.md'),'<!-- holoself-link-end -->\ntext\n<!-- holoself-link-start schema=1 -->\n');await assert.rejects(run(['link','add','--project',markerProject,'--self',self,'--yes']),/malformed/);await assert.rejects(access(join(markerProject,'.holoself','link.yaml')))
})

test('runtime hashes only managed blocks and reports actual managed drift',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await writeFile(join(project,'AGENTS.md'),'# User rules\n');await run(['link','add','--project',project,'--self',self,'--yes'])
  await writeFile(join(project,'PI.md'),'# Unmanaged inactive Pi instructions\n');await writeFile(join(project,'AGENTS.md'),(await readFile(join(project,'AGENTS.md'),'utf8'))+'\nOutside user edit.\n');let status=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.equal(status.state,'activated');assert.equal(status.activated_adapters[0].drift,false)
  await writeFile(join(project,'AGENTS.md'),(await readFile(join(project,'AGENTS.md'),'utf8')).replace('Never modify canonical self directly','Never silently replace canonical self'))
  status=JSON.parse(await capture(()=>run(['link','status','--project',project])));assert.equal(status.state,'degraded');assert.ok(status.errors.some(x=>x.includes('managed block drift')));process.exitCode=0
})

test('instruction discovery deduplicates Windows case aliases but preserves distinct case-sensitive files',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await run(['link','add','--project',project,'--self',self,'--platform','codex','--yes']);const managed=await readFile(join(project,'CODEX.md'),'utf8');await writeFile(join(project,'codex.md'),managed)
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project]))),aliases=status.activated_adapters.filter(x=>x.file.toLowerCase()==='codex.md')
  if(process.platform==='win32'){assert.equal(status.state,'activated');assert.equal(aliases.length,1);assert.ok(!status.errors.some(x=>x.includes('codex.md: managed block drift')))}else{assert.equal(status.state,'degraded');assert.equal(aliases.length,2);assert.ok(aliases.some(x=>x.file==='codex.md'&&x.status==='untracked'))}process.exitCode=0
})

test('deactivate discovers registry markers when runtime is narrow or corrupt',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await run(['link','add','--project',project,'--self',self,'--activate','all','--yes'])
  await writeFile(join(project,'.holoself','runtime.json'),JSON.stringify({schemaVersion:1,activatedAdapters:[{id:'agents',file:'AGENTS.md'}]}))
  await run(['link','deactivate','--project',project,'--yes']);for(const file of ['AGENTS.md','CLAUDE.md','ANTIGRAVITY.md','.windsurfrules'])assert.doesNotMatch(await readFile(join(project,file),'utf8'),/holoself-link-start/);await assert.rejects(access(join(project,'.agents','skills','holoself','SKILL.md')))
  await writeFile(join(project,'.holoself','runtime.json'),'{broken');await writeFile(join(project,'PI.md'),'<!-- holoself-link-start schema=1 -->\nmanaged\n<!-- holoself-link-end -->\n');await run(['link','deactivate','--project',project,'--yes']);assert.doesNotMatch(await readFile(join(project,'PI.md'),'utf8'),/holoself-link-start/)
})

test('tolerant project frontmatter preserves privacy fields and unclosed metadata fails private',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'Context'),{recursive:true})
  await writeFile(join(project,'Context','safe.md'),'---\nvisibility: public-safe\npublic_safe: true\ndescription: >\n  unsupported fold\n---\n# Safe\n\nAllowed phrase.\n')
  await writeFile(join(project,'Context','confidential.md'),'---\nvisibility: publishing\nsensitivity: employer-confidential\ndescription: >\n  unsupported fold\n---\n# Confidential\n\nRestricted phrase.\n')
  await writeFile(join(project,'Context','unclosed.md'),'---\nvisibility: public-safe\npublic_safe: true\n# Unclosed\n\nMust remain private.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','publishing','--yes','--project-include','Context/**/*.md'])
  const publishing=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])));assert.ok(publishing.project.documents.some(x=>x.path==='Context/safe.md'));assert.ok(!publishing.project.documents.some(x=>x.path==='Context/confidential.md'));assert.ok(!publishing.project.documents.some(x=>x.path==='Context/unclosed.md'));assert.ok(publishing.warnings.some(x=>x.includes('unclosed project frontmatter restricted')))
  await writeFile(join(self,'context','bad-frontmatter.md'),'---\nvisibility: public-safe\n# Missing delimiter\n');const canonical=JSON.parse(await capture(()=>run(['context','--project',project,'--json'])));assert.ok(!canonical.self.documents.some(x=>x.path==='context/bad-frontmatter.md'));assert.ok(canonical.warnings.some(x=>x.includes('context/bad-frontmatter.md: unclosed frontmatter')))
})

test('publishing context excludes documents when any salvaged privacy scalar is malformed',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'Context'),{recursive:true})
  const malformed={visibility:'visibility: 7',sensitivity:'visibility: public-safe\nsensitivity: true',public_safe:'visibility: public-safe\npublic_safe: yes',exclude_lenses:'visibility: public-safe\nexclude_lenses: publishing',field_visibility:'visibility: public-safe\nfield_visibility: publishing',confidence:'visibility: public-safe\nconfidence: 5'}
  for(const [name,privacy] of Object.entries(malformed))await writeFile(join(project,'Context',`${name}.md`),`---\n${privacy}\ndescription: >\n  unsupported fold\n---\n# ${name}\n\nMust not publish ${name}.\n`)
  await writeFile(join(project,'Context','valid-blocks.md'),'---\nvisibility: public-safe\npublic_safe: true\nexclude_lenses:\n  - career\nfield_visibility:\n  compensation: private\ndescription: >\n  unsupported fold\n---\n# Publishable\n\nSafe block metadata survives.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','publishing','--yes','--project-include','Context/**/*.md']);const publishing=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])));for(const name of Object.keys(malformed)){assert.ok(!publishing.project.documents.some(x=>x.path===`Context/${name}.md`));assert.ok(publishing.restrictions.some(x=>x.source===`Context/${name}.md`))}assert.ok(publishing.project.documents.some(x=>x.path==='Context/valid-blocks.md'))
})

test('publishing context excludes syntactically valid frontmatter with malformed privacy fields',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'Context'),{recursive:true})
  const malformed={visibility:'visibility: 7',sensitivity:'visibility: public-safe\nsensitivity: true',public_safe:'visibility: public-safe\npublic_safe: yes',exclude_lenses:'visibility: public-safe\nexclude_lenses: publishing',field_visibility:'visibility: public-safe\nfield_visibility: publishing',confidence:'visibility: public-safe\nconfidence: 5'}
  for(const [name,privacy] of Object.entries(malformed))await writeFile(join(project,'Context',`${name}.md`),`---\n${privacy}\n---\n# ${name}\n\nSyntactically valid YAML must not publish ${name}.\n`)
  await run(['link','add','--project',project,'--self',self,'--lens','publishing','--yes','--project-include','Context/**/*.md']);const publishing=JSON.parse(await capture(()=>run(['context','--project',project,'--lens','publishing','--json'])));for(const name of Object.keys(malformed)){assert.ok(!publishing.project.documents.some(x=>x.path===`Context/${name}.md`));assert.ok(publishing.restrictions.some(x=>x.source===`Context/${name}.md`));assert.ok(publishing.warnings.some(x=>x.includes(`Context/${name}.md: invalid project privacy metadata restricted`)))}
})

test('activation rollback restores prior files and link when a late write fails',async()=>{
  const self=await temp(),project=await temp(),tooLong=`${'x'.repeat(280)}.md`;await run(['init','--root',self]);await writeFile(join(project,'AGENTS.md'),'# Original\n')
  await assert.rejects(run(['link','add','--project',project,'--self',self,'--instructions',tooLong,'--yes']),/ENAMETOOLONG|ENOENT|filename|path/i);assert.equal(await readFile(join(project,'AGENTS.md'),'utf8'),'# Original\n');await assert.rejects(access(join(project,'.holoself','link.yaml')))
})

test('activation preflight rejects non-file managed artifacts without partial writes',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await writeFile(join(project,'AGENTS.md'),'# Original\n');await mkdir(join(project,'.holoself','runtime.json'),{recursive:true});await assert.rejects(run(['link','add','--project',project,'--self',self,'--yes']),/not a regular file/);assert.equal(await readFile(join(project,'AGENTS.md'),'utf8'),'# Original\n');await assert.rejects(access(join(project,'.holoself','link.yaml')))
})

test('dry-run previews instruction and skill writes without mutation',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);const output=await capture(()=>run(['link','add','--project',project,'--self',self,'--activate','all','--install-skill','project','--dry-run','--yes']));assert.match(output,/ANTIGRAVITY\.md/);assert.match(output,/\.agents\/skills\/holoself\/SKILL\.md/);await assert.rejects(access(join(project,'.holoself')))
})

test('user-scoped skill install is explicit, inspectable, and installs the canonical public skill',async()=>{
  const skillHome=await temp(),canonical=(await readFile(join(process.cwd(),'skills','holoself','SKILL.md'),'utf8')).replaceAll('\r\n','\n')
  const preview=JSON.parse(await capture(()=>run(['skill','install','--scope','user','--skill-home',skillHome,'--dry-run'])))
  assert.equal(preview.installation_plan.installations.length,3);assert.ok(preview.installation_plan.installations.every(x=>x.action==='write'))
  await assert.rejects(access(join(skillHome,'.agents','skills','holoself','SKILL.md')))
  await run(['skill','install','--scope','user','--skill-home',skillHome,'--yes'])
  for(const dir of ['.agents','.claude','.pi'])assert.equal((await readFile(join(skillHome,dir,'skills','holoself','SKILL.md'),'utf8')).replaceAll('\r\n','\n'),canonical)
  const status=JSON.parse(await capture(()=>run(['skill','status','--scope','user','--skill-home',skillHome])));assert.ok(status.installations.every(x=>x.status==='full-public-skill-current'))
})

test('global policy validates user skills and creates no project skill override',async()=>{
  const self=await temp(),project=await temp(),skillHome=await temp();await run(['init','--root',self]);await run(['skill','install','--scope','user','--skill-home',skillHome,'--platform','agents','--yes'])
  await run(['link','add','--project',project,'--self',self,'--install-skill','global','--skill-home',skillHome,'--yes'])
  await assert.rejects(access(join(project,'.agents','skills','holoself','SKILL.md')))
  const runtime=JSON.parse(await readFile(join(project,'.holoself','runtime.json'),'utf8'));assert.equal(runtime.schemaVersion,2);assert.equal(runtime.skillInstallPolicy,'global');assert.equal(runtime.skillInstallations.length,0);assert.equal(runtime.globalSkillInstallations.length,1)
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project,'--skill-home',skillHome])));assert.equal(status.state,'activated');assert.deepEqual(status.project_skill_overrides,[])
  const doctor=JSON.parse(await capture(()=>run(['link','doctor','--project',project,'--skill-home',skillHome])));assert.equal(doctor.checks.skill_installation,'global-full-public-skill');assert.equal(doctor.checks.project_skill_overrides,'absent')
  await run(['link','repair','--project',project,'--skill-home',skillHome,'--yes']);await assert.rejects(access(join(project,'.agents','skills','holoself','SKILL.md')));assert.equal(JSON.parse(await readFile(join(project,'.holoself','runtime.json'),'utf8')).skillInstallPolicy,'global')
})

test('global migration removes owned and untracked generated project skills transactionally',async()=>{
  const self=await temp(),project=await temp(),skillHome=await temp();await run(['init','--root',self]);await run(['skill','install','--scope','user','--skill-home',skillHome,'--yes']);await run(['link','add','--project',project,'--self',self,'--activate','all','--install-skill','project','--yes'])
  const runtimePath=join(project,'.holoself','runtime.json');await rm(runtimePath)
  const preview=JSON.parse(await capture(()=>run(['link','skill','migrate-global','--project',project,'--skill-home',skillHome,'--dry-run'])));assert.equal(preview.migration_plan.project_cleanup.length,3);assert.ok(preview.migration_plan.project_cleanup.every(x=>x.action==='delete'))
  await run(['link','skill','migrate-global','--project',project,'--skill-home',skillHome,'--yes'])
  for(const dir of ['.agents','.claude','.pi'])await assert.rejects(access(join(project,dir,'skills','holoself','SKILL.md')))
  const runtime=JSON.parse(await readFile(runtimePath,'utf8'));assert.equal(runtime.skillInstallPolicy,'global');assert.equal(runtime.globalSkillInstallations.length,3)
  const doctor=JSON.parse(await capture(()=>run(['link','doctor','--project',project,'--skill-home',skillHome])));assert.equal(doctor.state,'activated');assert.equal(doctor.checks.project_skill_overrides,'absent')
})

test('global migration preserves appended user content and reports the residual override',async()=>{
  const self=await temp(),project=await temp(),skillHome=await temp();await run(['init','--root',self]);await run(['skill','install','--scope','user','--skill-home',skillHome,'--platform','agents','--yes']);await run(['link','add','--project',project,'--self',self,'--yes'])
  const local=join(project,'.agents','skills','holoself','SKILL.md');await writeFile(local,(await readFile(local,'utf8'))+'\n# User appendix\nKeep this.\n')
  await run(['link','skill','migrate-global','--project',project,'--skill-home',skillHome,'--yes']);const preserved=await readFile(local,'utf8');assert.match(preserved,/User appendix/);assert.doesNotMatch(preserved,/holoself-skill-start/)
  const status=JSON.parse(await capture(()=>run(['link','status','--project',project,'--skill-home',skillHome])));assert.equal(status.state,'degraded');assert.deepEqual(status.project_skill_overrides,['.agents/skills/holoself/SKILL.md']);process.exitCode=0
})

test('migration refuses missing globals without changing project files',async()=>{
  const self=await temp(),project=await temp(),skillHome=await temp();await run(['init','--root',self]);await run(['link','add','--project',project,'--self',self,'--yes']);const local=join(project,'.agents','skills','holoself','SKILL.md'),before=await readFile(local,'utf8'),runtime=await readFile(join(project,'.holoself','runtime.json'),'utf8')
  await assert.rejects(run(['link','skill','migrate-global','--project',project,'--skill-home',skillHome,'--yes']),/global skill missing/);assert.equal(await readFile(local,'utf8'),before);assert.equal(await readFile(join(project,'.holoself','runtime.json'),'utf8'),runtime)
})

test('global install protects unmanaged files unless replacement is explicitly forced',async()=>{
  const skillHome=await temp(),file=join(skillHome,'.agents','skills','holoself','SKILL.md');await mkdir(dirname(file),{recursive:true});await writeFile(file,'# User-owned skill\n')
  const preview=JSON.parse(await capture(()=>run(['skill','install','--scope','user','--skill-home',skillHome,'--platform','agents','--dry-run'])));assert.equal(preview.installation_plan.installations[0].from,'unmanaged-collision');assert.equal(await readFile(file,'utf8'),'# User-owned skill\n')
  await assert.rejects(run(['skill','install','--scope','user','--skill-home',skillHome,'--platform','agents','--yes']),/use --force --yes/);assert.equal(await readFile(file,'utf8'),'# User-owned skill\n')
  await run(['skill','install','--scope','user','--skill-home',skillHome,'--platform','agents','--force','--yes']);assert.match(await readFile(file,'utf8'),/## Canonical-root validation/)
})

test('migration rollback restores runtime and project skill after a late failure',async()=>{
  const self=await temp(),project=await temp(),skillHome=await temp();await run(['init','--root',self]);await run(['skill','install','--scope','user','--skill-home',skillHome,'--platform','agents','--yes']);await run(['link','add','--project',project,'--self',self,'--yes'])
  const local=join(project,'.agents','skills','holoself','SKILL.md'),runtimePath=join(project,'.holoself','runtime.json'),beforeSkill=await readFile(local,'utf8'),beforeRuntime=await readFile(runtimePath,'utf8'),link={path:self,access:'read',proposals:'enabled',index:'local',default_lens:'general',secondary_lenses:[]}
  assert.throws(()=>migrateProjectSkillsToGlobal(project,link,{skillHome,afterCleanup(){throw new Error('injected late failure')}}),/injected late failure/);assert.equal(await readFile(local,'utf8'),beforeSkill);assert.equal(await readFile(runtimePath,'utf8'),beforeRuntime)
})

test('migration recognizes exact historical generated skill wrappers as removable',async()=>{
  const self=await temp(),project=await temp(),skillHome=await temp(),canonical=await readFile(join(process.cwd(),'skills','holoself','SKILL.md'),'utf8');await run(['init','--root',self]);await run(['skill','install','--scope','user','--skill-home',skillHome,'--platform','agents','--yes']);await run(['link','add','--project',project,'--self',self,'--yes'])
  const local=join(project,'.agents','skills','holoself','SKILL.md'),start=canonical.indexOf('# Holoself'),body=canonical.slice(start).trim(),historical=`---\nname: holoself\ndescription: Load linked whole-person context for this project.\n---\n\n# Linked Holoself\n\nRead \`.holoself/BOOTSTRAP.md\` before substantive work. Use the installed public Holoself skill when available. Resolve context through the configured lens, preserve provenance and project ownership, and create proposals instead of editing canonical self directly.\n\n<!-- holoself-skill-start schema=1 -->\n${body}\n<!-- holoself-skill-end -->\n`;await writeFile(local,historical);await rm(join(project,'.holoself','runtime.json'))
  const preview=JSON.parse(await capture(()=>run(['link','skill','migrate-global','--project',project,'--skill-home',skillHome,'--dry-run'])));assert.equal(preview.migration_plan.project_cleanup[0].action,'delete');await run(['link','skill','migrate-global','--project',project,'--skill-home',skillHome,'--yes']);await assert.rejects(access(local))
})
