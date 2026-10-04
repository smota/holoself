import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildCleanupPlan, applyCleanupPlan } from '../src/cleanup.mjs'
const temp=()=>mkdtempSync(join(tmpdir(),'holoself-cleanup-safety-'))
const old='---\nknowledge_status: historical\n---\n# Historical evidence\nPreserve me.\n'
function fixture(){const root=temp();for(const top of ['context','reference']){mkdirSync(join(root,top));writeFileSync(join(root,top,'old.md'),old)}return root}

test('cleanup includes reference, rolls back moves and new directories, and safely replays its immutable receipt',()=>{
 const root=fixture(),plan=buildCleanupPlan(root);assert.equal(plan.operations.length,2);assert.throws(()=>applyCleanupPlan(root,plan,{expectedDigest:plan.digest,afterMove:()=>{throw new Error('injected')}}),/injected/);assert.equal(readFileSync(join(root,'context','old.md'),'utf8'),old);assert.equal(existsSync(join(root,'history')),false)
 const receipt=applyCleanupPlan(root,plan,{expectedDigest:plan.digest}),raw=readFileSync(receipt.receipt_path,'utf8');assert.equal(applyCleanupPlan(root,plan,{expectedDigest:plan.digest}).replayed,true);writeFileSync(join(root,'history','context','old.md'),'Drift');assert.throws(()=>applyCleanupPlan(root,plan,{expectedDigest:plan.digest}),/replay/);assert.equal(readFileSync(receipt.receipt_path,'utf8'),raw)
})

test('cleanup rejects source and destination junction ancestors and a swap between moves',()=>{
 const root=fixture(),plan=buildCleanupPlan(root),outside=temp();writeFileSync(join(outside,'old.md'),old);renameSync(join(root,'reference'),join(root,'saved-reference'));symlinkSync(outside,join(root,'reference'),'junction');assert.throws(()=>applyCleanupPlan(root,plan,{expectedDigest:plan.digest}),/unsafe/);assert.throws(()=>buildCleanupPlan(root),/unsafe/);assert.equal(readFileSync(join(outside,'old.md'),'utf8'),old)
 const root2=fixture(),plan2=buildCleanupPlan(root2);symlinkSync(outside,join(root2,'history'),'junction');assert.throws(()=>applyCleanupPlan(root2,plan2,{expectedDigest:plan2.digest}),/unsafe/)
 const root3=fixture(),plan3=buildCleanupPlan(root3);assert.throws(()=>applyCleanupPlan(root3,plan3,{expectedDigest:plan3.digest,afterMove:item=>{if(item.path==='context/old.md'){renameSync(join(root3,'reference'),join(root3,'saved-reference'));symlinkSync(outside,join(root3,'reference'),'junction')}}}),/unsafe/);assert.equal(readFileSync(join(outside,'old.md'),'utf8'),old);assert.equal(readFileSync(join(root3,'context','old.md'),'utf8'),old)
})

test('cleanup rejects digest-approved arbitrary and protected targets',()=>{
 const root=fixture(),original=buildCleanupPlan(root)
 for(const path of ['proposals/approved/x.md','proposals/receipts/x.json','config.json','AGENTS.md']){const plan={...original,operations:[{...original.operations[0],path,destination:'history/'+path}]};delete plan.digest;plan.digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');assert.throws(()=>applyCleanupPlan(root,plan,{expectedDigest:plan.digest}),/protected|unsupported/)}
})

test('cleanup rejects broken destination junctions before creating an outside target',()=>{
 const root=fixture(),plan=buildCleanupPlan(root),outside=join(temp(),'absent');symlinkSync(outside,join(root,'history'),'junction');assert.throws(()=>applyCleanupPlan(root,plan,{expectedDigest:plan.digest}),/unsafe/);assert.equal(existsSync(outside),false);assert.equal(readFileSync(join(root,'context','old.md'),'utf8'),old)
})
