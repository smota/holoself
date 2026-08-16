import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { ecosystemValidationErrors } from '../src/ecosystem.mjs'

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
  await assert.rejects(run(['proposals','list','--project',project]),/filename does not match proposal_id|invalid proposal/)
})

test('index and search enforce claim, field, compensation, metadata, and secret filters',async()=>{
  const {self,project}=await fixture()
  await writeFile(join(self,'context','privacy.md'),'---\nvisibility: linked-projects\nhome_address: 10 Secret Street\nfield_visibility:\n  Compensation: private\n---\n# Public\n\nApproved public phrase.\n\n## Compensation\n\nGolden package totals $210,000 with annual bonus.\n\n<!-- holoself-claim visibility=private -->\n## Private proof\n\nPrivate unicorn evidence phrase.\n<!-- /holoself-claim -->\n')
  await writeFile(join(project,'Context','role.md'),'# Role\n\nMy annual compensation totals USD 200000 plus bonus and equity.\n')
  await writeFile(join(project,'credentials-notes.md'),'# Credentials\n\nfilename secret phrase\n');await writeFile(join(project,'.env.md'),'# Environment\n\ninternal credential phrase\n');await writeFile(join(project,'bearer.md'),'# Auth\n\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n')
  const built=JSON.parse(await capture(()=>run(['index','rebuild','--project',project])));assert.ok(built.skipped_secret_files>=3)
  const raw=await readFile(join(project,'.holoself','index','index.json'),'utf8');assert.doesNotMatch(raw,/home_address|10 Secret Street|filename secret phrase|internal credential phrase|abcdefghijklmnopqrstuvwxyz/);assert.match(raw,/"schema_version": 2/)
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
  await access(join(project,'.agents','skills','holoself','SKILL.md'));await access(join(project,'.claude','skills','holoself','SKILL.md'));await access(join(project,'.pi','skills','holoself','SKILL.md'))
})

test('real project structures exclude agent skills and tolerate unrelated folded YAML',async()=>{
  const self=await temp(),project=await temp();await run(['init','--root',self]);await mkdir(join(project,'.agents','skills','example'),{recursive:true});await mkdir(join(project,'Master'),{recursive:true});await mkdir(join(project,'Context'),{recursive:true})
  await writeFile(join(project,'.agents','skills','example','SKILL.md'),'---\nname: example\ndescription: >\n  folded YAML that belongs to another skill\n---\n# Private agent skill noise\n')
  await writeFile(join(project,'Master','career.md'),'---\nvisibility: career\npublic_safe: false\ndescription: >\n  valid arbitrary folded frontmatter\n---\n# Career\n\nProject evidence.\n');await writeFile(join(project,'Context','publishing.md'),'# Publishing\n\nProject publishing rules.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','career','--yes','--project-include','Master/**/*.md,Context/**/*.md'])
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--json'])));assert.ok(data.project.documents.some(x=>x.path==='Master/career.md'));assert.ok(!data.project.documents.some(x=>x.path.includes('.agents/skills')));assert.ok(data.warnings.some(x=>x.includes('unsupported project frontmatter parsed conservatively')))
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
