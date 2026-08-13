import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, symlink, lstat, access, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'

async function temp(){return mkdtemp(join(tmpdir(),'holoself-'))}
async function capture(fn){const old=console.log;let out='';console.log=(...x)=>{out+=x.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}

test('init and validate create private root', async()=>{
  const root=await temp(); await run(['init','--root',root,'--contribs','communication','--exclude-contrib','communication']);
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
  const backups=(await readdir(project)).filter(name=>name.startsWith('.holoself-backup-')); assert.equal(backups.length,2)
})

test('migrate maps private reference and me without deleting source', async()=>{
  const source=await temp(), root=await temp(); await mkdir(join(source,'personal','profile'),{recursive:true}); await mkdir(join(source,'personal','reference'),{recursive:true}); await mkdir(join(source,'personal','me'),{recursive:true}); await writeFile(join(source,'personal','profile','identity.md'),'private note'); await writeFile(join(source,'personal','reference','private.md'),'private reference'); await writeFile(join(source,'personal','me','private.md'),'private me')
  await run(['init','--root',root]); await run(['migrate','--root',root,'--from',source,'--yes']);
  assert.equal(await readFile(join(root,'profile','identity.md'),'utf8'),'private note'); assert.equal(await readFile(join(root,'reference','private.md'),'utf8'),'private reference'); assert.equal(await readFile(join(root,'me','private.md'),'utf8'),'private me'); assert.equal(await readFile(join(source,'personal','profile','identity.md'),'utf8'),'private note')
})

test('link and unlink only manage symlink with explicit confirmation', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--root',root]);
  await assert.rejects(run(['link','--root',root,'--target',project]),/Re-run with --yes/)
  await run(['link','--root',root,'--target',project,'--yes']); assert.equal((await lstat(join(project,'.holoself'))).isSymbolicLink(),true)
  await assert.rejects(run(['unlink','--root',root,'--target',project]),/Re-run with --yes/)
  await run(['unlink','--root',root,'--target',project,'--yes']); await assert.rejects(lstat(join(project,'.holoself')))
})

test('init creates private architecture directories and catalog defaults', async()=>{
  const root=await temp(); await run(['init','--root',root]);
  for (const name of ['reference','me','exports','contribs/local']) await access(join(root,name));
  const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
  assert.equal(config.schemaVersion,1); assert.ok(config.selectedContribs.includes('minto-pyramid'));
  assert.match(await readFile(join(root,'me','contribs.md'),'utf8'),/Local self-model/);
})

test('selection rejects unknown contrib and upgrade removes deselected defaults', async()=>{
  const root=await temp(); await assert.rejects(run(['init','--root',root,'--contribs','missing']),/unknown public contrib/)
  await run(['init','--root',root]); await access(join(root,'contribs','default','communication.md'))
  await run(['init','--root',root,'--exclude-contrib','communication']); await assert.rejects(access(join(root,'contribs','default','communication.md')))
})

test('packet-only export has no fallback paths', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--root',root]); await run(['export','--root',root,'--target',project,'--packet-only']);
  const packet=await readFile(join(project,'.holoself','context-packet.md'),'utf8'); assert.match(packet,/self-contained/); assert.match(packet,/## profile\/identity\.md/); assert.doesNotMatch(packet,/\(profile\/identity\.md\)/)
})

test('export copies only markdown context and refuses non-link unlink', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--root',root]); await writeFile(join(root,'profile','private.txt'),'not exported')
  await run(['export','--root',root,'--target',project]); await assert.rejects(access(join(project,'.holoself','profile','private.txt')))
  const other=await temp(); await mkdir(join(other,'.holoself')); await assert.rejects(run(['unlink','--root',root,'--target',other]),/not a Holoself link/)
})
