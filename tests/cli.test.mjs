import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'

async function temp(){return mkdtemp(join(tmpdir(),'holoself-'))}
async function capture(fn){const old=console.log;let out='';console.log=(...x)=>{out+=x.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}

test('init and validate create private root', async()=>{
  const root=await temp(); await run(['init','--root',root,'--exclude-contrib','communication']);
  const config=JSON.parse(await readFile(join(root,'config.json'),'utf8')); assert.deepEqual(config.selectedContribs,[])
  assert.match(await capture(()=>run(['validate','--root',root])),/is valid/)
})

test('export packet and explicit root setup marker', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--root',root]);
  await run(['export','--root',root,'--target',project]);
  assert.match(await readFile(join(project,'.holoself','context-packet.md'),'utf8'),/Holoself context packet/)
  await run(['export','--root',root,'--target',project,'--root-setup','--yes']);
  const first=await readFile(join(project,'AGENTS.md'),'utf8'); assert.match(first,/holoself-export-start/)
  await run(['export','--root',root,'--target',project,'--root-setup','--yes']);
  assert.equal((await readFile(join(project,'AGENTS.md'),'utf8')).match(/holoself-export-start/g).length,1)
})

test('migrate copies personal source without deleting it', async()=>{
  const source=await temp(), root=await temp(); await mkdir(join(source,'personal','profile'),{recursive:true}); await writeFile(join(source,'personal','profile','identity.md'),'private note')
  await run(['init','--root',root]); await run(['migrate','--root',root,'--from',source,'--yes']);
  assert.equal(await readFile(join(root,'profile','identity.md'),'utf8'),'private note'); assert.equal(await readFile(join(source,'personal','profile','identity.md'),'utf8'),'private note')
})

test('link and unlink only manage symlink', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--root',root]); await run(['link','--root',root,'--target',project]); assert.equal((await lstat(join(project,'.holoself'))).isSymbolicLink(),true); await run(['unlink','--target',project]); assert.rejects(lstat(join(project,'.holoself')))
})
