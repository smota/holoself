import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,lstatSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {recordDigest} from '../../../lib/core/record-digest.mjs'

const read=p=>JSON.parse(readFileSync(p,'utf8'))
const config=read('agent-workflow.config.json')
const scope=read('.agentflow/delivery/holoself-38-40/scope.json')
test('issue snapshots retain all acceptance criteria',()=>{
  assert.deepEqual(scope.order,[38,39,40])
  assert.deepEqual(scope.issues.map(i=>i.number),scope.order)
  for(const issue of scope.issues){
    assert.equal(issue.repo,'smota/holoself')
    assert.ok(Number.isFinite(Date.parse(issue.updatedAt)))
    assert.equal(scope.issueRevisions.find(r=>r.number===issue.number).digest,recordDigest(issue))
    const required=[...issue.body.matchAll(/^- \[ \] (.+)$/gm)].map(m=>m[1])
    assert.ok(required.length>=4)
    assert.deepEqual(scope.requirements.filter(r=>r.issue===issue.number).map(r=>r.text),required)
    for(const requirement of scope.requirements.filter(r=>r.issue===issue.number))assert.ok(config.delivery.checks[requirement.verification])
  }
})
test('candidate covers repository code and check definitions',()=>{
  const inputs=new Set(config.delivery.candidate.inputs)
  for(const file of execFileSync('git',['ls-files'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/))assert.ok(inputs.has(file),`Unbound tracked file: ${file}`)
  for(const file of inputs){assert.ok(!file.startsWith('.agent-runs/'));assert.ok(lstatSync(file).isFile(),file)}
  for(const file of ['scope.json','scope.test.mjs','verify.mjs','README.md'])assert.ok(inputs.has(`.agentflow/delivery/holoself-38-40/${file}`))
  for(const check of Object.values(config.delivery.checks)){
    assert.ok(check.assertions.length>0)
    assert.ok(check.timeoutMs>0)
    for(const file of check.args.filter(a=>a.endsWith('.mjs')))assert.ok(inputs.has(file),`Unbound check: ${file}`)
  }
})
test('delivery stays local and preserves project policy',()=>{
  assert.deepEqual(config.delivery.source,{kind:'local-preview'})
  assert.equal(config.posture,'assisted')
  assert.equal(config.branching.trunk,'main')
  assert.equal(config.branching.defaultPrTarget,'main')
  assert.equal(config.collaboration.councilOnPublicContract,true)
  assert.equal(config.collaboration.councilOnMigration,true)
  assert.equal(read('sdlc.config.json').paths['high-assurance'].requiresHumanApproval,true)
  assert.equal(scope.boundary,'mutate-worktree')
  assert.equal(scope.productAcceptance,'not implemented')
})
