import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, symlink, lstat, access, readdir, stat, rm } from 'node:fs/promises'
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

test('link root setup injects bounded instructions, preserves text, and is idempotent', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--root',root]); await writeFile(join(project,'CLAUDE.md'),'# Project instructions\n\nKeep this text.\n')
  await assert.rejects(run(['link','--root',root,'--target',project,'--root-setup']),/Re-run with --yes/)
  await run(['link','--root',root,'--target',project,'--root-setup','--yes']);
  const first=await readFile(join(project,'CLAUDE.md'),'utf8'); assert.match(first,/Keep this text/); assert.match(first,/holoself-export-start/); assert.equal((first.match(/holoself-export-start/g)||[]).length,1)
  await run(['link','--root',root,'--target',project,'--root-setup','--yes','--force']);
  const second=await readFile(join(project,'CLAUDE.md'),'utf8'); assert.equal((second.match(/holoself-export-start/g)||[]).length,1); assert.match(second,/Keep this text/)
})

test('link root setup dry-run and safety checks do not edit instructions', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--root',root]);
  await writeFile(join(project,'AGENTS.md'),'before\n'); await run(['link','--root',root,'--target',project,'--root-setup','--yes','--dry-run']);
  assert.equal(await readFile(join(project,'AGENTS.md'),'utf8'),'before\n'); await assert.rejects(lstat(join(project,'.holoself')))
  await writeFile(join(project,'CLAUDE.md'),'<!-- holoself-export-start -->\n'); await assert.rejects(run(['link','--root',root,'--target',project,'--root-setup','--yes','--force']),/malformed Holoself markers/)
  const file=join(project,'CODEX.md'); await writeFile(file,'external\n'); const instructionLink=join(project,'AGENTS.md'); await rm(instructionLink); await symlink(file,instructionLink); await assert.rejects(run(['link','--root',root,'--target',project,'--root-setup','--yes','--force']),/symlink; refusing to modify/)
  await rm(instructionLink); await mkdir(instructionLink); await assert.rejects(run(['link','--root',root,'--target',project,'--root-setup','--yes','--force']),/not a file; refusing to modify/)
})

test('init creates private architecture directories and catalog defaults', async()=>{
  const root=await temp(); await run(['init','--root',root]);
  const agents=await readFile(join(root,'AGENTS.md'),'utf8'); assert.match(agents,/holoself-root-start/); assert.match(agents,/Loading order/);
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

test('packet formatting uses real newlines and data-dir overrides HOLOSELF_HOME', async()=>{
  const root=await temp(), project=await temp(), envRoot=await temp(); const previous=process.env.HOLOSELF_HOME
  process.env.HOLOSELF_HOME=envRoot
  try {
    await run(['init','--data-dir',root]); await run(['export','--data-dir',root,'--target',project,'--packet-only'])
    const packet=await readFile(join(project,'.holoself','context-packet.md'),'utf8')
    assert.doesNotMatch(packet,/\\\\n/); assert.match(packet,/^---$/m); assert.ok(packet.includes('## profile/identity.md'))
  } finally { if(previous===undefined) delete process.env.HOLOSELF_HOME; else process.env.HOLOSELF_HOME=previous }
})

test('migration dry-run reports mappings without destination mutation or private contents', async()=>{
  const source=await temp(), root=join(await temp(),'new-root'); await mkdir(join(source,'profile'),{recursive:true}); await mkdir(join(source,'reference'),{recursive:true}); await writeFile(join(source,'profile','identity.md'),'private identity'); await writeFile(join(source,'reference','secret.md'),'private secret')
  const output=await capture(()=>run(['migrate','--data-dir',root,'--from',source,'--yes','--dry-run']))
  assert.match(output,/source root:/); assert.match(output,/target root:/); assert.match(output,/detected files: 2/); assert.match(output,/mapping: profile[\\/]identity\.md -> profile[\\/]identity\.md/); assert.match(output,/sensitive: 1/); assert.doesNotMatch(output,/private identity|private secret/)
  await assert.rejects(stat(root)); assert.equal(await readFile(join(source,'profile','identity.md'),'utf8'),'private identity')
})

test('migration preserves conflicts, supports force, and writes manifest', async()=>{
  const source=await temp(), root=await temp(); await mkdir(join(source,'profile'),{recursive:true}); await writeFile(join(source,'profile','identity.md'),'from source'); await run(['init','--data-dir',root]); await writeFile(join(root,'profile','identity.md'),'user authored')
  const output=await capture(()=>run(['migrate','--data-dir',root,'--from',source,'--yes'])); assert.match(output,/preserved: 1/); assert.match(output,/conflicts: 1/); assert.equal(await readFile(join(root,'profile','identity.md'),'utf8'),'user authored')
  const manifest=JSON.parse(await readFile(join(root,'migration-manifest.json'),'utf8')); assert.equal(manifest.schemaVersion,1); assert.equal(manifest.tool,'holoself'); assert.equal(manifest.sourceRoot,source); assert.equal(manifest.targetRoot,root); assert.ok(manifest.timestamp); assert.deepEqual(manifest.files.conflicts,['profile/identity.md'])
  await run(['migrate','--data-dir',root,'--from',source,'--yes','--force']); assert.equal(await readFile(join(root,'profile','identity.md'),'utf8'),'from source')
  assert.equal(await readFile(join(source,'profile','identity.md'),'utf8'),'from source')
})

test('root setup refuses malformed markers and remains idempotent', async()=>{
  const root=await temp(), project=await temp(); await run(['init','--data-dir',root]); await writeFile(join(project,'AGENTS.md'),'<!-- holoself-export-start -->\n')
  await assert.rejects(run(['export','--data-dir',root,'--target',project,'--root-setup','--yes']),/malformed Holoself markers/)
})

test('init preserves user AGENTS text and bounded root guidance', async()=>{
  const root=await temp(); await writeFile(join(root,'AGENTS.md'),'# User rules\n\nKeep this.\n'); await run(['init','--data-dir',root]);
  const first=await readFile(join(root,'AGENTS.md'),'utf8'); assert.match(first,/Keep this/); assert.match(first,/holoself-root-start/); assert.equal((first.match(/holoself-root-start/g)||[]).length,1)
  await run(['init','--data-dir',root]); const second=await readFile(join(root,'AGENTS.md'),'utf8'); assert.equal((second.match(/holoself-root-start/g)||[]).length,1); assert.match(second,/Keep this/)
})
