import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { run } from '../src/cli.mjs'
import { listDocuments } from '../src/documents.mjs'

async function capture(args) {
  const old=console.log
  let output=''
  console.log=(...values)=>{output+=values.join(' ')+'\n'}
  try { await run(args) } finally { console.log=old }
  return JSON.parse(output)
}
test('coaching completes a cycle and resumes without changing canonical knowledge', async t=>{
  const root=await mkdtemp(join(tmpdir(),'holoself-coaching-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await run(['init','--root',root])
  const profile=await readFile(join(root,'profile','identity.md'),'utf8')
  const before=listDocuments(root)
  const start=await capture(['coaching','start','--root',root,'--question','Should I delegate the reading?'])
  assert.equal(start.revision,1)
  assert.equal(start.events[0].provenance,'user_input')
  const note=await capture(['coaching','note',start.id,'--root',root,'--expected-revision','1','--kind','hypothesis','--text','A summary may be enough.'])
  assert.equal(note.events[1].kind,'hypothesis')
  const action=await capture(['coaching','action',start.id,'--root',root,'--expected-revision','2','--text','Ask for a summary.'])
  assert.equal(action.events[2].status,'proposed')
  await assert.rejects(run(['coaching','review',start.id,'--root',root,'--expected-revision','3','--outcome','done','--text','Asked.']),/choose an action/)
  const chosen=await capture(['coaching','choose',start.id,'--root',root,'--expected-revision','3','--action-sequence','3'])
  assert.equal(chosen.events[3].provenance,'user_attestation')
  const review=await capture(['coaching','review',start.id,'--root',root,'--expected-revision','4','--outcome','done','--text','I received a summary.'])
  assert.equal(review.events[4].verification,'unverified')
  assert.equal(review.events[4].provenance,'user_report')
  const resumed=await capture(['coaching','resume',start.id,'--root',root])
  assert.equal(resumed.revision,5)
  assert.deepEqual(listDocuments(root),before)
  assert.equal(await readFile(join(root,'profile','identity.md'),'utf8'),profile)
  const list=await capture(['coaching','resume','--root',root])
  assert.equal(list[0].id,start.id)
  assert.deepEqual(await readdir(join(root,'coaching','sessions')),[`${start.id}.json`])
})

test('failed or partial external material keeps coaching available and provenance honest', async t=>{
  const root=await mkdtemp(join(tmpdir(),'holoself-coaching-material-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await run(['init','--root',root])
  const start=await capture(['coaching','start','--root',root,'--question','What changed?'])
  await assert.rejects(run(['coaching','material',start.id,'--root',root,'--material-file','notes.pdf']),/Document import is unsupported/)
  const failed=await capture(['coaching','material',start.id,'--root',root,'--expected-revision','1','--material-status','failed','--source-label','notes.pdf','--producer','external reader','--limitations','could not extract'])
  assert.equal(failed.events[1].usable,false)
  assert.equal(failed.events[1].text,null)
  const raw='  - Indented Markdown\n\nNext line\n'
  const partial=await capture(['coaching','material',start.id,'--root',root,'--expected-revision','2','--material-status','partial','--source-label','notes.pdf','--producer','external reader','--limitations','page 2 missing','--material-text',raw])
  assert.equal(partial.events[2].text,raw)
  assert.equal(partial.events[2].usable,true)
  const note=await capture(['coaching','note',start.id,'--root',root,'--expected-revision','3','--kind','user_report','--text','I can continue without page 2.'])
  assert.equal(note.revision,4)
  await assert.rejects(run(['coaching','note',start.id,'--root',root,'--expected-revision','3','--kind','intention','--text','stale']),/session changed/)
})

test('package CLI runs the documented choose and review commands', async t=>{
  const root=await mkdtemp(join(tmpdir(),'holoself-coaching-bin-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const bin=fileURLToPath(new URL('../bin/holoself.mjs',import.meta.url))
  const cli=(...args)=>{
    const processResult=spawnSync(process.execPath,[bin,...args],{encoding:'utf8',windowsHide:true})
    assert.equal(processResult.status,0,processResult.stderr)
    return JSON.parse(processResult.stdout)
  }
  await run(['init','--root',root])
  const start=cli('coaching','start','--root',root,'--question','Which action matters?')
  const action=cli('coaching','action',start.id,'--root',root,'--expected-revision','1','--text','Call the colleague.')
  const chosen=cli('coaching','choose',start.id,'--root',root,'--expected-revision','2','--action-sequence',String(action.events[1].sequence))
  const reviewed=cli('coaching','review',start.id,'--root',root,'--expected-revision','3','--outcome','partial','--text','I sent a message.')
  assert.equal(chosen.events[2].type,'action_chosen')
  assert.equal(reviewed.events[3].outcome,'partial')
  assert.equal(cli('coaching','resume',start.id,'--root',root).revision,4)
})
