import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { applyCleanupPlan, buildCleanupPlan } from '../src/cleanup.mjs'
import { classifyContextNeed, contextNeed, selectContextRecords, sourceId, dateValue, temporalDisposition } from '../src/context-selection.mjs'
import { canonicalPrivacyMetadataErrors, privacyMetadataErrors, privacyValueValid, redactRootPaths } from '../src/ecosystem.mjs'
import { runHarness } from '../src/harnesses.mjs'
import { run } from '../src/cli.mjs'

const temp=()=>mkdtempSync(join(tmpdir(),'holoself-efficiency-'))
const record=(path,content,metadata={},kind='self')=>({kind,path,content,metadata,source_hash:`hash-${path}`,document_role:'content'})

test('valid_until supports date-only end-of-day normalization and sentinel 0 fail-closed',()=>{
  assert.equal(dateValue('2026-09-20',true),Date.parse('2026-09-20T23:59:59.999Z'))
  assert.equal(dateValue('2026-09-20T12:00:00Z',true),Date.parse('2026-09-20T12:00:00Z'))
  assert.equal(dateValue('not-a-date',true),0)
  assert.equal(dateValue('',true),null)
  assert.equal(dateValue(null,true),null)

  const validDoc=temporalDisposition({knowledge_status:'current',valid_until:'2026-09-20'},'',{now:'2026-09-20T10:00:00.000Z',temporal:'current'})
  assert.equal(validDoc.include,true)

  const expiredDoc=temporalDisposition({knowledge_status:'current',valid_until:'2026-09-20'},'',{now:'2026-09-21T00:00:00.000Z',temporal:'current'})
  assert.equal(expiredDoc.include,false)
  assert.equal(expiredDoc.status,'historical')

  const malformedDoc=temporalDisposition({knowledge_status:'current',valid_until:'corrupted-date'},'',{now:'2026-09-20T10:00:00.000Z',temporal:'current'})
  assert.equal(malformedDoc.include,false)
  assert.equal(malformedDoc.status,'historical')
})

test('context selection is bounded, manifest-first, lifecycle-aware, and handle-addressable',()=>{
  const records=[record('context/current.md','career evidence '.repeat(2000)),record('context/history.md','career history',{knowledge_status:'historical',temporal_scope:'historical'}),record('context/old.md','superseded claim',{knowledge_status:'superseded',superseded_by:'claim-new'}),record('Context/project.md','career project',{},'project')]
  const selected=selectContextRecords(records,{task:'career evidence',budget:'small',temporal:'current'});assert.ok(selected.selection.content_chars<=8000);assert.equal(selected.records.some(x=>x.path==='context/history.md'),false);assert.equal(selected.selection.context_need,'required')
  const manifest=selectContextRecords(records,{task:'career evidence',budget:'small',manifest:true,temporal:'all'});assert.equal(manifest.records.every(x=>x.content===''),true);assert.ok(manifest.records.every(x=>x.source_id.startsWith('hs-')))
  const id=sourceId(records[0]),exact=selectContextRecords(records,{task:'career evidence',budget:'small',sources:[id],temporal:'current'});assert.deepEqual(exact.records.map(x=>x.path),['context/current.md'])
  assert.equal(contextNeed('format this JSON'),'not-needed');assert.equal(contextNeed('help decide strategy'),'helpful')
})

test('cleanup is redacted, digest-bound, stale-safe, and preserves history',()=>{
  const root=temp(),path=join(root,'context','old.md');mkdirSync(join(root,'context'),{recursive:true});writeFileSync(path,'---\naccess_lenses: [private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\nknowledge_status: historical\ntemporal_scope: historical\n---\n# Secret body\nDo not expose this in plans.\n')
  const plan=buildCleanupPlan(root);assert.equal(plan.operations.length,1);assert.doesNotMatch(JSON.stringify(plan),/Do not expose/);assert.throws(()=>applyCleanupPlan(root,plan,{expectedDigest:'bad'}),/digest mismatch/);assert.equal(existsSync(path),true)
  const receipt=applyCleanupPlan(root,plan,{expectedDigest:plan.digest});assert.equal(existsSync(path),false);assert.equal(existsSync(join(root,'history','context','old.md')),true);assert.equal(JSON.parse(readFileSync(receipt.receipt_path,'utf8')).plan_digest,plan.digest)
})

test('real harness transport covers argument, stdin, unicode, failures, limits, and timeout',async()=>{
  const cwd=temp(),base={schemaVersion:1,id:'codex',executable:process.execPath,timeoutSeconds:5,verifiedAt:null,automatic:false}
  const argument={...base,arguments:['-e','process.stdout.write(process.argv[1])','{prompt}'],promptTransport:'argument'},a=await runHarness(argument,'héllo 世界',{cwd});assert.equal(a.stdout,'héllo 世界')
  const stdin={...base,arguments:['-e','process.stdin.pipe(process.stdout)'],promptTransport:'stdin'},b=await runHarness(stdin,'stdin ✓',{cwd});assert.equal(b.stdout,'stdin ✓')
  await assert.rejects(runHarness({...base,arguments:['-e','process.stderr.write("boom");process.exit(7)'],promptTransport:'stdin'},'',{cwd}),/boom/)
  await assert.rejects(runHarness({...base,arguments:['-e','process.stdout.write("x".repeat(1000))'],promptTransport:'stdin'},'',{cwd,maxStdout:10}),/output limit/)
  await assert.rejects(runHarness({...base,arguments:['-e','setInterval(()=>{},1000)'],promptTransport:'stdin'},'',{cwd,timeoutMs:30}),/timed out/)
})

test('grouped proposal approval binds exact preview and applies two targets with one receipt',async()=>{
  const self=temp(),project=temp(),id='44444444-4444-4444-8444-444444444444';await run(['init','--root',self]);writeFileSync(join(project,'evidence.md'),'# Evidence\nReviewed source.\n');await run(['link','add','--project',project,'--self',self,'--no-activate','--yes']);const dir=join(project,'.holoself','proposals');mkdirSync(dir,{recursive:true})
  const proposal={schema_version:2,proposal_id:id,title:'Grouped review',source_project:basename(project),source_project_path:project.replaceAll('\\','/'),source_files:['evidence.md'],status:'pending',created_at:'2026-08-29T00:00:00.000Z',provenance:[`${basename(project)}:evidence.md`],changes:[{change_id:'one',target:'context/one.md',operation:'append_claim',proposal_type:'new_fact',claim:'First grouped claim.',evidence:'evidence.md',confidence:'confirmed',visibility:'private'},{change_id:'two',target:'context/two.md',operation:'append_claim',proposal_type:'new_fact',claim:'Second grouped claim.',evidence:'evidence.md',confidence:'confirmed',visibility:'private'}]}
  const yaml=Object.entries(proposal).map(([key,value])=>Array.isArray(value)?`${key}:\n${value.map(item=>`  - ${JSON.stringify(item)}`).join('\n')}`:`${key}: ${JSON.stringify(value)}`).join('\n')+'\n';writeFileSync(join(dir,`${id}.yaml`),yaml)
  const cli=join(process.cwd(),'bin','holoself.mjs'),preview=spawnSync(process.execPath,[cli,'proposals','approve',id,'--project',project,'--json'],{encoding:'utf8',shell:false});assert.notEqual(preview.status,0);const parsed=JSON.parse(preview.stdout);assert.equal(parsed.changes.length,2)
  const stale=spawnSync(process.execPath,[cli,'proposals','approve',id,'--project',project,'--preview-hash','0'.repeat(64),'--yes'],{encoding:'utf8',shell:false});assert.notEqual(stale.status,0);assert.equal(existsSync(join(self,'context','one.md')),false)
  const approved=spawnSync(process.execPath,[cli,'proposals','approve',id,'--project',project,'--preview-hash',parsed.preview_hash,'--yes'],{encoding:'utf8',shell:false});assert.equal(approved.status,0,approved.stderr);assert.match(readFileSync(join(self,'context','one.md'),'utf8'),/First grouped claim/);assert.match(readFileSync(join(self,'context','two.md'),'utf8'),/Second grouped claim/);const receipt=JSON.parse(readFileSync(join(self,'proposals','receipts',`${id}-approved.json`),'utf8'));assert.equal(receipt.applied_changes.length,2);assert.equal(receipt.preview_sha256,parsed.preview_hash)
})

test('lifecycle frontmatter fields validate valid and invalid values',()=>{
  for(const status of ['current','historical','superseded'])assert.equal(privacyValueValid('knowledge_status',status),true,status)
  for(const invalid of ['active','archived','',null,42,['current']])assert.equal(privacyValueValid('knowledge_status',invalid),false)

  for(const scope of ['current','time-bounded','historical','timeless'])assert.equal(privacyValueValid('temporal_scope',scope),true,scope)
  for(const invalid of ['forever','past','',null,42,['current']])assert.equal(privacyValueValid('temporal_scope',invalid),false)

  for(const field of ['valid_from','valid_until','review_after']){
    for(const valid of ['2026-09-20','2026-09-20T12:30:00Z','2026-09-20T12:30:00.123+02:00'])assert.equal(privacyValueValid(field,valid),true,`${field}:${valid}`)
    for(const invalid of ['2026/09/20','2026-13-40','not-a-date','','   ',null,123,['2026-09-20']])assert.equal(privacyValueValid(field,invalid),false,`${field}:${String(invalid)}`)
  }

  for(const valid of [[],['context/old.md'],['context/old-1.md','context/old-2.md']])assert.equal(privacyValueValid('supersedes',valid),true)
  for(const invalid of ['context/old.md',[''],['  '],[null],[123],null,{}])assert.equal(privacyValueValid('supersedes',invalid),false)

  for(const valid of ['context/new.md','claim-2026'])assert.equal(privacyValueValid('superseded_by',valid),true,valid)
  for(const invalid of ['','   ',null,123,['context/new.md'],{}])assert.equal(privacyValueValid('superseded_by',invalid),false)

  const base={access_lenses:['general'],disclosure:'internal-only',sensitivity:'personal',document_role:'content'}
  assert.deepEqual(privacyMetadataErrors({...base,knowledge_status:'superseded',superseded_by:'context/new.md',supersedes:['context/prior.md'],valid_from:'2026-01-01',valid_until:'2026-12-31',review_after:'2026-06-01'}),[])
  assert.ok(canonicalPrivacyMetadataErrors({...base,knowledge_status:'superseded'}).some(e=>e.includes('superseded knowledge must name superseded_by')))
  assert.ok(canonicalPrivacyMetadataErrors({...base,valid_from:'2026-12-31',valid_until:'2026-01-01'}).some(e=>e.includes('valid_from must not be after valid_until')))
})

test('canonical document with superseded_by is indexed, excluded from current context, and included with history or --temporal',async()=>{
  const self=temp(),project=temp()
  const capture=async fn=>{const oldLog=console.log,oldErr=console.error;let stdout='',stderr='';console.log=(...x)=>{stdout+=x.join(' ')+'\n'};console.error=(...x)=>{stderr+=x.join(' ')+'\n'};try{await fn()}finally{console.log=oldLog;console.error=oldErr};return {stdout,stderr}}
  await capture(()=>run(['init','--root',self]))
  writeFileSync(join(self,'context','old.md'),'---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\nknowledge_status: superseded\nsuperseded_by: context/new.md\n---\n# Old Approach\n\nLegacy career architecture notes.\n')
  writeFileSync(join(self,'context','new.md'),'---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\nknowledge_status: current\nsupersedes: [context/old.md]\n---\n# New Approach\n\nCurrent career architecture notes.\n')
  await capture(()=>run(['link','add','--project',project,'--self',self,'--lens','general','--no-activate','--yes']))

  const currentRes=await capture(()=>run(['context','--project',project,'--lens','general','--json']))
  const current=JSON.parse(currentRes.stdout)
  assert.equal(current.warnings.some(w=>w.includes('context/old.md')),false)
  const cat=JSON.parse(readFileSync(join(self,'.holoself','catalog','catalog.json'),'utf8'))
  const indexedOld=cat.sources.find(s=>s.file==='context/old.md')
  assert.ok(indexedOld,'context/old.md must be indexed in catalog')
  assert.equal(indexedOld.frontmatter.superseded_by,'context/new.md')
  assert.equal(current.sources.some(s=>s.path==='context/old.md'),false,'excluded from current context')
  assert.equal(current.sources.some(s=>s.path==='context/new.md'),true,'new document included in current context')

  const temporalSuperseded=JSON.parse((await capture(()=>run(['context','--project',project,'--lens','general','--temporal','superseded','--json']))).stdout)
  assert.equal(temporalSuperseded.sources.some(s=>s.path==='context/old.md'),true,'included with --temporal superseded')

  const temporalAll=JSON.parse((await capture(()=>run(['context','--project',project,'--lens','general','--temporal','all','--json']))).stdout)
  assert.equal(temporalAll.sources.some(s=>s.path==='context/old.md'),true,'included with --temporal all')

  const withHistory=JSON.parse((await capture(()=>run(['context','--project',project,'--lens','general','--temporal','all','--include-history','--json']))).stdout)
  assert.equal(withHistory.sources.some(s=>s.path==='context/old.md'),true,'included when history is requested')
})

test('catalog build errors are surfaced in validate and doctor output with root-relative paths',async()=>{
  const self=temp(),project=temp()
  const capture=async fn=>{const oldLog=console.log,oldErr=console.error;let stdout='',stderr='';console.log=(...x)=>{stdout+=x.join(' ')+'\n'};console.error=(...x)=>{stderr+=x.join(' ')+'\n'};try{await fn()}finally{console.log=oldLog;console.error=oldErr};return {stdout,stderr}}
  await capture(()=>run(['init','--root',self]))
  await capture(()=>run(['link','add','--project',project,'--self',self,'--lens','general','--no-activate','--yes']))
  writeFileSync(join(self,'history','broken.md'),'# Untagged history doc\n\nMissing canonical privacy metadata in history.\n')
  const cli=join(process.cwd(),'bin','holoself.mjs')

  const docRoot=spawnSync(process.execPath,[cli,'doctor','--root',self],{encoding:'utf8',shell:false})
  assert.equal(docRoot.status,0,'doctor must exit 0 with catalog build warning')
  assert.match(docRoot.stdout,/\[warn\] history\/broken\.md: canonical privacy metadata missing access_lenses or legacy visibility/)
  assert.equal((docRoot.stdout.match(/history\/broken\.md/g)||[]).length,1,'doctor prints warning once')
  assert.equal(docRoot.stdout.includes(self),false,'doctor output must not contain absolute self path')

  const linkDoc=spawnSync(process.execPath,[cli,'link','doctor','--project',project],{encoding:'utf8',shell:false})
  const linkDocJson=JSON.parse(linkDoc.stdout)
  assert.ok(linkDocJson.warnings.some(w=>w.includes('history/broken.md')&&w.includes('canonical privacy metadata missing')))
  assert.ok(linkDocJson.checks.warnings.some(w=>w.includes('history/broken.md')&&w.includes('canonical privacy metadata missing')))
  assert.equal(linkDoc.stdout.includes(self),false,'link doctor output must not contain absolute self path')
  assert.equal(linkDoc.stdout.includes(project),false,'link doctor output must not contain absolute project path')

  const valRes=spawnSync(process.execPath,[cli,'validate','--root',self],{encoding:'utf8',shell:false})
  assert.equal(valRes.status,0,'validate must exit 0 when only a catalog build warning is present')
  assert.equal(valRes.stderr,'','validate must not emit errors for catalog build warnings')
  assert.match(valRes.stdout,/\[warn\] history\/broken\.md: canonical privacy metadata missing access_lenses or legacy visibility/)
  assert.match(valRes.stdout,/\[ok\] .* is valid/)
  assert.equal((valRes.stdout.match(/history\/broken\.md/g)||[]).length,1,'validate prints warning exactly once')
  const warnLines=valRes.stdout.split('\n').filter(line=>line.startsWith('[warn]'))
  assert.equal(warnLines.length,1,'validate emits one warning line')
  assert.equal(warnLines[0].includes(self),false,'validate warnings must not contain absolute self path')
})

test('proposals approve succeeds when an unrelated canonical file has a catalog build error',async()=>{
  const self=temp(),project=temp(),id='55555555-5555-4555-8555-555555555555'
  await run(['init','--root',self])
  writeFileSync(join(self,'history','broken-unrelated.md'),'# Unrelated untagged history doc\n')
  writeFileSync(join(project,'evidence.md'),'# Evidence\nReviewed source.\n')
  await run(['link','add','--project',project,'--self',self,'--no-activate','--yes'])
  const dir=join(project,'.holoself','proposals');mkdirSync(dir,{recursive:true})
  const proposal={schema_version:2,proposal_id:id,title:'Approve despite catalog warning',source_project:basename(project),source_project_path:project.replaceAll('\\','/'),source_files:['evidence.md'],status:'pending',created_at:'2026-08-29T00:00:00.000Z',provenance:[`${basename(project)}:evidence.md`],changes:[{change_id:'one',target:'context/approved-target.md',operation:'append_claim',proposal_type:'new_fact',claim:'Approved claim despite unrelated catalog build warning.',evidence:'evidence.md',confidence:'confirmed',visibility:'private'}]}
  const yaml=Object.entries(proposal).map(([key,value])=>Array.isArray(value)?`${key}:\n${value.map(item=>`  - ${JSON.stringify(item)}`).join('\n')}`:`${key}: ${JSON.stringify(value)}`).join('\n')+'\n'
  writeFileSync(join(dir,`${id}.yaml`),yaml)
  const cli=join(process.cwd(),'bin','holoself.mjs')
  const preview=spawnSync(process.execPath,[cli,'proposals','approve',id,'--project',project,'--json'],{encoding:'utf8',shell:false})
  const parsed=JSON.parse(preview.stdout)
  const approved=spawnSync(process.execPath,[cli,'proposals','approve',id,'--project',project,'--preview-hash',parsed.preview_hash,'--yes'],{encoding:'utf8',shell:false})
  assert.equal(approved.status,0,approved.stderr)
  assert.match(readFileSync(join(self,'context','approved-target.md'),'utf8'),/Approved claim despite unrelated catalog build warning/)
})

test('redactRootPaths preserves sibling-prefix paths, handles win32 case-insensitivity and separators, and truncates echoed values',()=>{
  assert.equal(redactRootPaths('/tmp/xyz/a.md: error',['/tmp/x'],{platform:'linux'}),'/tmp/xyz/a.md: error')
  assert.equal(redactRootPaths('/tmp/x/a.md: error at /tmp/x',['/tmp/x'],{platform:'linux'}),'a.md: error at ')
  assert.equal(redactRootPaths('C:\\Users\\Alice\\Self\\context\\a.md: error in c:/users/alice/self',['C:/Users/Alice/Self'],{platform:'win32'}),'context/a.md: error in ')
  const longVal='x'.repeat(120)
  const redacted=redactRootPaths(`context/a.md: invalid superseded_by value ${longVal}`,[])
  assert.equal(redacted,`context/a.md: invalid superseded_by value ${'x'.repeat(80)}...`)
})

test('classifyContextNeed scores personal, domain, and mechanical signals in EN and PT and respects explicit override',()=>{
  assert.deepEqual(classifyContextNeed('format this JSON object: {"x":1}'),{need:'not-needed',reason:'matched:mechanical:format'})
  assert.deepEqual(classifyContextNeed('fix lint error in src/foo.js'),{need:'not-needed',reason:'matched:mechanical:lint'})
  assert.deepEqual(classifyContextNeed('indentar este arquivo JSON'),{need:'not-needed',reason:'matched:mechanical:indent'})
  assert.deepEqual(classifyContextNeed('corrija a indentação deste arquivo JSON'),{need:'not-needed',reason:'matched:mechanical:indent'})
  assert.deepEqual(classifyContextNeed('summarize my career trajectory'),{need:'required',reason:'matched:personal:career'})
  assert.deepEqual(classifyContextNeed('qual é meu estilo de liderança em engenharia?'),{need:'required',reason:'matched:personal:leadership'})
  assert.deepEqual(classifyContextNeed('refine my leadership voice for the onboarding plan'),{need:'required',reason:'matched:personal:leadership'})
  assert.deepEqual(classifyContextNeed('Fix the 30-60-90 day onboarding plan for new senior engineers'),{need:'helpful',reason:'default'})
  assert.deepEqual(classifyContextNeed('Corrija o tom deste artigo técnico para soar mais direto'),{need:'helpful',reason:'default'})
  assert.deepEqual(classifyContextNeed('Format the README intro in our house style'),{need:'helpful',reason:'default'})
  assert.deepEqual(classifyContextNeed('How should we structure our deterministic simulation testing harness?'),{need:'helpful',reason:'default'})
  assert.deepEqual(classifyContextNeed('Como devemos testar hipóteses de produto com clientes enterprise?'),{need:'helpful',reason:'default'})
  assert.deepEqual(classifyContextNeed('help decide our roadmap'),{need:'helpful',reason:'default'})
  for(const need of ['required','helpful','not-needed']){
    assert.deepEqual(classifyContextNeed('format this JSON',need),{need,reason:'explicit'})
    assert.equal(contextNeed('format this JSON',need),need)
  }
  assert.throws(()=>classifyContextNeed('task','invalid'),/invalid context need/)
})

test('softened not-needed keeps policy, session-start sources, and overlapping self records while explicit not-needed drops all self records',async()=>{
  const records=[
    {...record('lenses/general.md','general lens policy',{document_role:'policy'}),document_role:'policy'},
    record('profile/identity.md','Sam identity and engineering background'),
    record('profile/preferences.md','Prefer concise direct writing'),
    record('context/testing-philosophy.md','Deterministic simulation testing harness and property-based checks'),
    record('context/career.md','Unrelated executive career biography and history'),
    record('Context/project.md','Project local docs for lint and property-based checks',{},'project')
  ]
  const softMechanical=selectContextRecords(records,{
    task:'fix lint error in foo.js',
    budget:'small',
    sessionStartSources:['profile/identity.md','profile/preferences.md']
  })
  assert.equal(softMechanical.selection.context_need,'not-needed')
  assert.equal(softMechanical.selection.need,'not-needed')
  assert.equal(softMechanical.selection.need_reason,'matched:mechanical:lint')
  assert.equal(softMechanical.receipt.need,'not-needed')
  assert.equal(softMechanical.receipt.need_reason,'matched:mechanical:lint')
  assert.deepEqual(softMechanical.records.map(r=>r.path),['profile/identity.md','profile/preferences.md','lenses/general.md','Context/project.md'])
  assert.equal(softMechanical.omitted.some(o=>o.source==='context/career.md'&&o.reason==='personal context not needed for this task'),true)
  assert.equal(softMechanical.omitted.some(o=>o.source==='context/testing-philosophy.md'&&o.reason==='personal context not needed for this task'),true)

  const softOverlap=selectContextRecords(records,{
    task:'test property-based checks in foo.js',
    budget:'small',
    sessionStartSources:['profile/identity.md','profile/preferences.md']
  })
  assert.equal(softOverlap.selection.context_need,'not-needed')
  assert.equal(softOverlap.selection.need_reason,'matched:mechanical:test')
  assert.equal(softOverlap.records.some(r=>r.path==='context/testing-philosophy.md'),true,'overlapping self record kept under soft not-needed')
  assert.equal(softOverlap.records.some(r=>r.path==='context/career.md'),false,'non-overlapping self record omitted under soft not-needed')

  const strictExplicit=selectContextRecords(records,{
    task:'test property-based checks in foo.js',
    need:'not-needed',
    budget:'small',
    sessionStartSources:['profile/identity.md','profile/preferences.md']
  })
  assert.equal(strictExplicit.selection.context_need,'not-needed')
  assert.equal(strictExplicit.selection.need,'not-needed')
  assert.equal(strictExplicit.selection.need_reason,'explicit')
  assert.deepEqual(strictExplicit.records.map(r=>r.path),['Context/project.md'])
  assert.equal(strictExplicit.omitted.filter(o=>o.reason==='personal context not needed for this task').length,5)

  const self=temp(),project=temp(),cli=join(process.cwd(),'bin','holoself.mjs')
  await run(['init','--root',self])
  writeFileSync(join(self,'context','career.md'),'---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Career\n\nPrincipal systems architect notes.\n')
  await run(['link','add','--project',project,'--self',self,'--lens','general','--no-activate','--yes'])

  const softCli=JSON.parse(spawnSync(process.execPath,[cli,'context','--project',project,'--task','format this JSON','--json'],{encoding:'utf8',shell:false}).stdout)
  assert.equal(softCli.status,'not-needed')
  assert.equal(softCli.selection.need_reason,'matched:mechanical:format')
  assert.equal(softCli.context_receipt.need,'not-needed')
  assert.equal(softCli.context_receipt.need_reason,'matched:mechanical:format')
  assert.equal(softCli.self.documents.some(d=>d.path==='profile/identity.md'),true)
  assert.equal(softCli.self.documents.some(d=>d.path==='context/career.md'),false)

  const strictCli=JSON.parse(spawnSync(process.execPath,[cli,'context','--project',project,'--task','format this JSON','--need','not-needed','--json'],{encoding:'utf8',shell:false}).stdout)
  assert.equal(strictCli.status,'not-needed')
  assert.equal(strictCli.selection.need_reason,'explicit')
  assert.equal(strictCli.self.documents.length,0)

  const forcedCli=JSON.parse(spawnSync(process.execPath,[cli,'context','--project',project,'--task','format this JSON','--need','required','--json'],{encoding:'utf8',shell:false}).stdout)
  assert.equal(forcedCli.status,'complete')
  assert.equal(forcedCli.selection.context_need,'required')
  assert.equal(forcedCli.selection.need_reason,'explicit')
  assert.equal(forcedCli.self.documents.some(d=>d.path==='context/career.md'),true)

  const packetText=spawnSync(process.execPath,[cli,'context','--project',project,'--task','format this JSON'],{encoding:'utf8',shell:false}).stdout
  assert.match(packetText,/Context gate: not-needed \(matched:mechanical:format\);/)

  const hookWithNeed=spawnSync(process.execPath,[cli,'context','--project',project,'--hook','holoself-session-start','--need','required'],{encoding:'utf8',shell:false})
  assert.equal(hookWithNeed.status,0)
  assert.equal(hookWithNeed.stdout,'')
  assert.equal(hookWithNeed.stderr,'')
})
