import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { createMcpSession } from '../src/mcp-server.mjs'
import { ENVELOPE_BYTE_CAPS } from '../src/context-selection.mjs'

const temp=()=>mkdtemp(join(tmpdir(),'holoself-budget-'))
async function capture(fn){const old=console.log;let out='';console.log=(...x)=>{out+=x.join(' ')+'\n'};try{await fn()}finally{console.log=old}return out}
const front='---\naccess_lenses: [general, professional]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n'
// A self root with many large documents, so every budget has to trim.
async function fixture(count=40){
  const self=await temp(),project=await temp();await capture(()=>run(['init','--root',self]))
  for(let i=0;i<count;i++){const body=Array.from({length:30},(_,line)=>`Evidence line ${line} for item ${i}: career leadership "quoted" détails — ünïcode text.`).join('\n');await writeFile(join(self,'context',`item-${String(i).padStart(2,'0')}.md`),`${front}# Item ${i}\n\n## Career\n\n${body}\n\n## Leadership\n\n${body}\n`)}
  await capture(()=>run(['link','add','--project',project,'--self',self,'--lens','professional','--no-activate','--yes']))
  return {self,project}
}
function mcp(project){
  const output=[],accept=createMcpSession({project,write:line=>output.push(JSON.parse(line))})
  accept(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}}))
  return (id,name,args={})=>{accept(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}}));return output.at(-1).result}
}
const documents=data=>[...data.self.documents,...data.project.documents,...data.federated.flatMap(peer=>peer.documents),...data.methods.documents]

test('every budget bounds the emitted packet on CLI and MCP, with and without --manifest',async()=>{
  const {project}=await fixture(),call=mcp(project);let id=10
  for(const budget of ['small','standard','deep'])for(const manifest of [false,true]){
    const args=['context','--project',project,'--task','career leadership evidence','--budget',budget,'--json',...(manifest?['--manifest']:[]),'--no-cache']
    const stdout=await capture(()=>run(args)),data=JSON.parse(stdout),cap=ENVELOPE_BYTE_CAPS[budget]
    assert.ok(Buffer.byteLength(stdout)<=cap,`CLI ${budget} manifest=${manifest}: ${Buffer.byteLength(stdout)} > ${cap}`)
    assert.equal(data.selection.total_bytes,Buffer.byteLength(stdout));assert.equal(data.selection.envelope_cap_bytes,cap);assert.equal(data.selection.estimated_tokens_total,Math.ceil(data.selection.total_bytes/4))
    const result=call(id++,manifest?'holoself_context_manifest':'holoself_context',{task:'career leadership evidence',budget}),sent=Buffer.byteLength(JSON.stringify(result))
    assert.ok(!result.isError,JSON.stringify(result.structuredContent?.error));assert.ok(sent<=cap,`MCP ${budget} manifest=${manifest}: ${sent} > ${cap}`);assert.equal(result.structuredContent.data.selection.total_bytes,sent)
  }
  const small=JSON.parse(await capture(()=>run(['context','--project',project,'--task','career leadership evidence','--budget','small','--json','--no-cache'])))
  assert.ok(small.selection.envelope_dropped?.length||small.selection.selected_count>0);assert.ok(small.restrictions.every(item=>typeof item.reason==='string'))
})

test('delivered packets carry each body once; sources[] is a body-free index',async()=>{
  const {project}=await fixture(12),call=mcp(project)
  const data=JSON.parse(await capture(()=>run(['context','--project',project,'--task','career evidence','--budget','deep','--json','--no-cache'])))
  assert.ok(data.sources.length>0);assert.equal(data.packet_metadata.schema_version,3)
  for(const source of data.sources)for(const field of ['content','search_text','sections','claims','links','metadata'])assert.ok(!(field in source),`sources[] carries ${field}`)
  const ids=documents(data).map(doc=>doc.source_id);assert.equal(new Set(ids).size,ids.length);assert.deepEqual([...ids].sort(),data.sources.map(source=>source.source_id).sort())
  const result=call(2,'holoself_context',{task:'career evidence',budget:'deep'}),body=documents(result.structuredContent.data).find(doc=>doc.content.length>200).content
  assert.ok(!result.content[0].text.includes(body.slice(0,120)),'MCP text repeats a document body');assert.match(result.content[0].text,/structuredContent/)
})

test('session-start loads the lens session_start_sources; tasks and plain calls rank normally',async()=>{
  const {self,project}=await fixture(6),lensFile=join(self,'lenses','professional.json')
  const defaults=JSON.parse(await capture(()=>run(['context','--project',project,'--session-start','--json','--no-cache'])))
  assert.deepEqual(defaults.self.documents.map(doc=>doc.path).filter(path=>!path.startsWith('profile/')),[]);assert.ok(defaults.self.documents.some(doc=>doc.path==='profile/identity.md'))
  assert.ok(defaults.restrictions.some(item=>item.reason==='not in lens session_start_sources'));assert.equal(defaults.selection.session_start,true)
  await writeFile(lensFile,JSON.stringify({...JSON.parse(await readFile(lensFile,'utf8')),session_start_sources:['context/item-0*.md']},null,2))
  const narrowed=JSON.parse(await capture(()=>run(['context','--project',project,'--session-start','--json','--no-cache'])))
  assert.ok(narrowed.self.documents.length>0);assert.ok(narrowed.self.documents.every(doc=>/^context\/item-0\d\.md$/.test(doc.path)||doc.metadata.document_role==='policy'))
  const plain=JSON.parse(await capture(()=>run(['context','--project',project,'--json','--no-cache'])));assert.ok(plain.self.documents.some(doc=>doc.path.startsWith('profile/')));assert.equal(plain.selection.session_start,false)
  const tasked=JSON.parse(await capture(()=>run(['context','--project',project,'--session-start','--task','identity','--json','--no-cache'])));assert.ok(!tasked.restrictions.some(item=>item.reason==='not in lens session_start_sources'))
})

test('invalid session_start_sources values are rejected by the lens registry',async()=>{
  const self=await temp();await capture(()=>run(['init','--root',self]));const lensFile=join(self,'lenses','professional.json'),base=JSON.parse(await readFile(lensFile,'utf8'))
  for(const bad of [['../x.md'],['/abs.md'],['a\\b.md'],['dup.md','dup.md'],Array.from({length:21},(_,i)=>`p${i}.md`),['**/x.md'],['*','profile/identity.md'],[''],'profile/identity.md']){
    await writeFile(lensFile,JSON.stringify({...base,session_start_sources:bad}));await assert.rejects(run(['lens','validate','--root',self]),/session_start_sources/,JSON.stringify(bad))
  }
  await writeFile(lensFile,JSON.stringify({...base,session_start_sources:['profile/*.md','*.md']}));await capture(()=>run(['lens','validate','--root',self]))
})

test('cold, in-memory and persistent cache hits select identically and verify cursors',async()=>{
  const {project}=await fixture(15)
  const strip=data=>{const {cache,reconcile_reads,catalog_reads,total_bytes,estimated_tokens_total,estimated_tokens_total_heuristic,...selection}=data.selection;return {selection,hash:data.context_receipt.context_hash}}
  const query=['context','--project',project,'--task','career evidence','--budget','small','--json']
  const cold=JSON.parse(await capture(()=>run([...query,'--no-cache']))),memory=JSON.parse(await capture(()=>run([...query,'--no-cache'])))
  const persistentCold=JSON.parse(await capture(()=>run(query))),persistentHit=JSON.parse(await capture(()=>run(query)))
  assert.equal(memory.cache.hit,true);assert.equal(persistentHit.cache.hit,true);assert.equal(persistentHit.cache.persistent,true)
  for(const other of [memory,persistentCold,persistentHit])assert.deepEqual(strip(other),strip(cold))
  const manifest=['context','--project',project,'--manifest','--json'],first=JSON.parse(await capture(()=>run(manifest)));await capture(()=>run(manifest))
  const cursor=first.selection.next_cursor;assert.ok(cursor)
  const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));decoded.p.offset=1
  const forged=Buffer.from(JSON.stringify(decoded)).toString('base64url')
  for(const extra of [['--no-cache'],[],[]])await assert.rejects(run([...manifest,'--cursor',forged,...extra]),error=>error.code==='CURSOR_INVALID')
  const page=JSON.parse(await capture(()=>run([...manifest,'--cursor',cursor])));assert.ok(page.sources.length>0)
})
