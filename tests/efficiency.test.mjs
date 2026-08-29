import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { applyCleanupPlan, buildCleanupPlan } from '../src/cleanup.mjs'
import { contextNeed, selectContextRecords, sourceId } from '../src/context-selection.mjs'
import { runHarness } from '../src/harnesses.mjs'
import { run } from '../src/cli.mjs'

const temp=()=>mkdtempSync(join(tmpdir(),'holoself-efficiency-'))
const record=(path,content,metadata={},kind='self')=>({kind,path,content,metadata,source_hash:`hash-${path}`,document_role:'content'})

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
