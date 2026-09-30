import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validate, hash, extractionErrors, referenceValid, coachingErrors, coachingCycleErrors, attachmentValid } from './helpers/evidence-contract.mjs'
import { inventory, requirements, expected } from './fixtures/evidence/golden.mjs'
import { docxBytes, pdfBytes } from './fixtures/evidence/build.mjs'

const E='evidence-v1.schema.json', C='coaching-v1.schema.json'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const time='2026-01-01T00:00:00Z', actor={kind:'human',id:'synthetic-owner'}
const location={root_id:id(8),relative_path:'sample.md'}
const policy={revision:1,project_grants:[],access_lenses:['general'],disclosure:'internal-only',sensitivity:'personal'}
const source={schema_version:1,kind:'source',id:id(1),manifest_revision:1,label:'Synthetic workshop',media_type:'markdown',author:{kind:'unknown',id:'unknown'},location,policy,status:'registered'}
const revision={schema_version:1,kind:'revision',id:id(2),source_id:id(1),operation_id:id(3),sha256:hash('synthetic bytes'),byte_length:15,captured_at:time,captured_location:location,storage:{mode:'reference'}}
function extraction() {
  return {schema_version:1,kind:'extraction',id:id(4),source_id:id(1),revision_id:id(2),policy_revision:1,extractor:{name:'synthetic-contract-oracle',version:'1',configuration_sha256:hash('{}')},state:'complete',inventory:'complete',blocks:inventory.markdown.map(([unit,text],i)=>({id:unit,type:unit==='question'?'question':unit==='answer'?'answer':'paragraph',content:text,content_sha256:hash(text),locator:{format:'markdown',line_start:i+1,line_end:i+1},relations:unit==='answer'?[{type:'answers',target:'question'}]:[]})),coverage:inventory.markdown.map(([unit])=>({unit_id:unit,disposition:'extracted',block_ids:[unit]})),limitations:[]}
}
function reference(e=extraction()) {const b=e.blocks[0];return {source_id:e.source_id,revision_id:e.revision_id,extraction_id:e.id,block_id:b.id,block_sha256:b.content_sha256,locator:b.locator}}
const clone=value=>structuredClone(value)
const mutate=(value,fn)=>{const result=clone(value);fn(result);return result}

test('R01/R02: stable identity, revision shape and explicit snapshot consent',()=>{
  assert.ok(validate(source,E));assert.ok(validate(revision,E))
  assert.ok(validate({...source,location:{...location,relative_path:'moved/sample.md'}},E))
  assert.ok(validate({...revision,id:id(9),previous_revision_id:revision.id},E))
  assert.ok(validate({...revision,storage:{mode:'snapshot',snapshot_path:'snapshots/original.md',consent_id:id(10)}},E))
  const otherSource={...source,id:id(11),author:{kind:'human',id:'another-synthetic-author'}},otherRevision={...revision,id:id(12),source_id:otherSource.id,operation_id:id(13)}
  assert.ok(validate(otherSource,E));assert.ok(validate(otherRevision,E))
  assert.equal(otherRevision.sha256,revision.sha256);assert.notEqual(otherRevision.source_id,revision.source_id)
  assert.notDeepEqual(otherSource.author,source.author)
  assert.equal(validate({...revision,storage:{mode:'reference',snapshot_path:'unsolicited-copy.md'}},E),false)
  assert.equal(validate({...revision,storage:{mode:'snapshot',snapshot_path:'snapshots/original.md',consent_id:id(10),extra:'unknown'}},E),false)
  for(const bad of [mutate(revision,r=>r.sha256='not-a-hash'),mutate(revision,r=>r.byte_length=-1),mutate(revision,r=>r.storage={mode:'snapshot',snapshot_path:'x'}),mutate(source,s=>s.schema_version=2),mutate(source,s=>s.approved=true)])assert.equal(validate(bad,E),false)
})
test('R03: portable locators reject escapes and ambiguous local paths',()=>{
  for(const path of ['../x','a/../../x','/etc/file','C:/file','C:file','a\\file','//server/file','a/./file','a//b','file:stream','CON','a/NUL.txt','a/cOn.txt','PRN/a','AUX.txt','a/COM1','a/lPt9.log','a/COM¹.txt','a/LPT²','a/CONIN$','a/conout$.txt','a/CLOCK$','a/trailing.','a/trailing ','a./file','a /file','a/line\nbreak','a/tab\tname','a/null\u0000name','a/delete\u007fname','a/<file>','a/file?','a/file*','a/pipe|name','a/quote"name']) assert.equal(validate({...source,location:{...location,relative_path:path}},E),false,JSON.stringify(path))
  for(const path of ['folder/file with spaces.md','MixedCase/Ordinary.DOCX','auxiliary.md','a/COM10.txt','a/.hidden.md'])assert.ok(validate({...source,location:{...location,relative_path:path}},E),path)
})
test('R04: policy is mandatory, explicit and does not imply knowledge approval',()=>{
  for(const bad of [mutate(source,s=>delete s.policy),mutate(source,s=>s.policy.project_grants=['*']),mutate(source,s=>s.policy.access_lenses=[]),mutate(source,s=>s.policy.disclosure='automatic'),mutate(source,s=>s.policy.revision=0)]) assert.equal(validate(bad,E),false)
  assert.deepEqual(source.policy.project_grants,[])
  for(const lens of ['a-','a--b','-a','Uppercase','a'.repeat(41)])assert.equal(validate({...source,policy:{...policy,access_lenses:[lens]}},E),false,lens)
  for(const lens of ['general','custom-lens','a'.repeat(40)])assert.ok(validate({...source,policy:{...policy,access_lenses:[lens]}},E),lens)
  const canonical=JSON.parse(readFileSync(new URL('../schemas/lens.schema.json',import.meta.url))).properties.id
  const proposed=JSON.parse(readFileSync(new URL('../schemas/evidence-v1.schema.json',import.meta.url))).$defs.policy.properties.access_lenses.items
  assert.equal(proposed.pattern,canonical.pattern);assert.equal(proposed.maxLength,canonical.maxLength)
})
test('R05/R06/R07: authored corpus bytes match independent inventory and structural counts',()=>{
  const md=readFileSync(new URL('./fixtures/evidence/sample.md',import.meta.url)),docx=readFileSync(new URL('./fixtures/evidence/complex.docx',import.meta.url)),pdf=readFileSync(new URL('./fixtures/evidence/complex.pdf',import.meta.url))
  assert.deepEqual(docx,docxBytes());assert.deepEqual(pdf,pdfBytes())
  for(const [format,bytes] of [['markdown',md],['docx',docx],['pdf',pdf]]) {
    for(const [unit,text] of inventory[format])assert.ok(bytes.includes(Buffer.from(text)),`${format}/${unit}`)
    for(const anchor of expected.anchors[format])assert.ok(bytes.includes(Buffer.from(anchor)),`${format}/${anchor}`)
  }
  assert.equal((docx.toString().match(/<w:tc>/g)||[]).length,expected.docx_table_cells)
  assert.equal((pdf.toString().match(/\/Type \/Page /g)||[]).length,expected.pdf_pages)
  const offset=Number(pdf.toString().match(/startxref\n(\d+)/)[1]);assert.equal(pdf.subarray(offset,offset+4).toString(),'xref')
  assert.ok(docx.includes(Buffer.from('TargetMode="External"')))
  assert.equal(expected.visual_acceptance,'pending-human-review')
})
test('R05/R08: golden inventory detects omissions, dangling relations and tampering',()=>{
  const e=extraction(), units=inventory.markdown.map(([unit])=>unit)
  assert.ok(validate(e,E));assert.deepEqual(extractionErrors(e,units),[])
  for(const [change,code] of [
    [x=>x.coverage.pop(),'golden-coverage'],[x=>x.coverage.push(x.coverage[0]),'duplicate-unit'],[x=>x.blocks.push(x.blocks[0]),'duplicate-block'],
    [x=>x.coverage[0].block_ids=['missing'],'dangling-coverage'],[x=>x.blocks[0].content='tampered','content-hash'],[x=>x.blocks[0].relations=[{type:'answers',target:'missing'}],'dangling-relation'],
    [x=>x.blocks[0].locator.line_end=0,'line-order'],[x=>x.coverage[0].disposition='unsupported','hidden-gap']
  ]) assert.ok(extractionErrors(mutate(e,change),units).includes(code),code)
  assert.equal(validate(mutate(e,x=>x.coverage[0].disposition='omitted'),E),false)
  assert.equal(validate(mutate(e,x=>x.inventory='incomplete'),E),false)
  assert.equal(validate({...e,blocks:[],coverage:[]},E),false)
  assert.equal(validate({...e,blocks:[]},E),false)
  assert.equal(validate({...e,coverage:[]},E),false)
  assert.ok(validate({...e,state:'pending',inventory:'incomplete',blocks:[],coverage:[]},E))
})
test('R07/R12: locators and extraction failures cannot claim unsupported success',()=>{
  const e=extraction(),units=inventory.markdown.map(([unit])=>unit)
  const pdf=mutate(e,x=>x.blocks[0].locator={format:'pdf',page:1,bounds:{x:600,y:0,width:30,height:20,page_width:612,page_height:792}})
  assert.ok(extractionErrors(pdf,units).includes('page-bounds'))
  assert.equal(validate(mutate(e,x=>x.blocks[0].locator={format:'docx',part:'word/document.xml',structural_path:'body/table[1]/row[2]/cell[1]',page:1}),E),false)
  assert.equal(validate({...e,state:'failed'},E),false)
  for(const error_code of ['NO_TEXT','ENCRYPTED','MALFORMED','ACTIVE_CONTENT','LIMIT_EXCEEDED','TIMEOUT','DEPENDENCY_MISSING','SOURCE_CHANGED','POLICY_CHANGED'])assert.ok(validate({...e,state:'failed',inventory:'incomplete',error_code},E))
})
test('R05/R06/R07: golden semantics reject missing and wrong existing relationship targets and authors',()=>{
  for(const format of ['markdown','docx','pdf']) {
    const e=extraction(), semantics={relations:expected.relations[format],attributions:expected.attributions[format],limitations:expected.limitations[format]}
    e.blocks=inventory[format].map(([unit,text],i)=>({id:unit,type:'paragraph',content:text,content_sha256:hash(text),locator:format==='docx'?{format,part:'word/document.xml',structural_path:`synthetic-unit[${i+1}]`}:format==='pdf'?{format,page:Number(unit[1])}:{format,line_start:i+1,line_end:i+1},relations:[],attributions:[]}))
    e.coverage=inventory[format].map(([unit])=>({unit_id:unit,disposition:'extracted',block_ids:[unit]}))
    e.limitations=[...semantics.limitations]
    // Positive specimen is a proposed adapter output, not an actual extraction.
    for(const [unit,type,target] of semantics.relations)e.blocks.find(b=>b.id===unit).relations.push({type,target})
    for(const [unit,role,label] of semantics.attributions)e.blocks.find(b=>b.id===unit).attributions.push({role,label})
    const units=inventory[format].map(([unit])=>unit)
    assert.ok(validate(e,E),format);assert.deepEqual(extractionErrors(e,units,semantics),[],format)
    for(const [unit,type,target] of semantics.relations) {
      const missing=mutate(e,x=>{const block=x.blocks.find(b=>b.id===unit);block.relations=block.relations.filter(r=>r.type!==type)})
      assert.ok(extractionErrors(missing,units,semantics).includes('golden-relation'),`${format}/${unit}/missing`)
      const wrong=mutate(e,x=>{x.blocks.find(b=>b.id===unit).relations.find(r=>r.type===type).target=x.blocks.find(b=>b.id!==target).id})
      assert.ok(extractionErrors(wrong,units,semantics).includes('golden-relation'),`${format}/${unit}/wrong-existing-target`)
    }
    for(const [unit,role] of semantics.attributions) {
      assert.ok(extractionErrors(mutate(e,x=>{x.blocks.find(b=>b.id===unit).attributions=[]}),units,semantics).includes('golden-attribution'))
      assert.ok(extractionErrors(mutate(e,x=>{x.blocks.find(b=>b.id===unit).attributions.find(a=>a.role===role).label='Other synthetic speaker'}),units,semantics).includes('golden-attribution'))
    }
    assert.ok(extractionErrors({...e,limitations:[]},units,semantics).includes('golden-limitation'))
  }
})
test('R07/R09: derived asset bytes and evidence references bind their digest',()=>{
  const e=extraction(),bytes=Buffer.from('synthetic visual bytes'),asset_path='derived/figure.bin',asset_sha256=hash(bytes)
  Object.assign(e.blocks[0],{asset_path,asset_sha256})
  const units=inventory.markdown.map(([unit])=>unit),assets=new Map([[asset_path,bytes]])
  assert.ok(validate(e,E));assert.deepEqual(extractionErrors(e,units,null,assets),[])
  assert.equal(validate(mutate(e,x=>delete x.blocks[0].asset_sha256),E),false)
  assert.equal(validate(mutate(e,x=>delete x.blocks[0].asset_path),E),false)
  assert.ok(extractionErrors(e,units).includes('asset-integrity'))
  assert.ok(extractionErrors(e,units,null,new Map([[asset_path,Buffer.from('replacement')]])).includes('asset-integrity'))
  const ref={...reference(e),asset_sha256};assert.ok(referenceValid(ref,e,1))
  assert.equal(referenceValid(reference(e),e,1),false)
  assert.equal(referenceValid({...ref,asset_sha256:hash('replacement')},e,1),false)
})
test('R08: complete accounting, checked fidelity and candidate knowledge are independent',()=>{
  const e=extraction(),f={schema_version:1,kind:'fidelity',id:id(5),reference:reference(),policy_revision:1,state:'unchecked'}
  assert.ok(validate(f,E));assert.ok(validate({...f,state:'checked',reviewer:actor,reviewed_at:time},E))
  assert.ok(validate({...e,state:'partial',inventory:'incomplete'},E))
  assert.equal(validate({...f,state:'checked'},E),false)
  assert.equal(validate({...f,state:'checked',reviewer:{kind:'agent',id:'synthetic'},reviewed_at:time},E),false)
  const candidate={schema_version:1,kind:'interpretation',id:id(6),author:{kind:'agent',id:'synthetic'},state:'candidate',claims:[{id:'claim',text:'Checklist may help; unverified.',references:[reference()]}],limitations:['No causal evidence'],counterpoints:['Small fictional sample']}
  assert.ok(validate(candidate,E));assert.equal(validate({...candidate,state:'approved'},E),false);assert.equal(validate({...candidate,state:'proposed'},E),false)
})
test('R09: exact references fail on any stale revision, block, locator or policy binding',()=>{
  const e=extraction(),ref=reference(e);assert.equal(referenceValid(ref,e,1),true)
  for(const field of ['source_id','revision_id','extraction_id','block_id','block_sha256'])assert.equal(referenceValid({...ref,[field]:'stale'},e,1),false,field)
  assert.equal(referenceValid({...ref,locator:{format:'markdown',line_start:99,line_end:99}},e,1),false)
  assert.equal(referenceValid(ref,e,2),false);assert.equal(referenceValid(ref,{...e,state:'stale'},1),false)
})
test('R10: ordinary v1/v2 proposals remain valid; attachments never approve them',()=>{
  const p={proposal_id:id(10),source_project:'synthetic',source_files:['sample.md'],status:'pending',created_at:time,provenance:['synthetic:sample.md'],target:'context/claims.md',proposal_type:'new_fact',claim:'A candidate',evidence:'Fictional workshop',confidence:'unverified',visibility:'private'}
  assert.ok(validate(p,'proposal.schema.json'))
  const {target,proposal_type,claim,evidence,confidence,visibility,...common}=p
  assert.ok(validate({...common,schema_version:2,title:'Synthetic',changes:[{change_id:'claim',operation:'append_claim',target,proposal_type,claim,evidence,confidence,visibility}]},'proposal.schema.json'))
  const attachment={schema_version:1,kind:'proposal_evidence',proposal_id:p.proposal_id,proposal_sha256:hash(JSON.stringify(p)),interpretation_id:id(6),changes:[{change_id:'claim',claim_id:'claim',references:[reference()],limitations:['Unverified causal effect']}]}
  assert.ok(validate(attachment,E));assert.equal(validate({...attachment,status:'approved'},E),false)
  assert.equal(validate({...p,evidence_attachment:attachment},'proposal.schema.json'),false)
  assert.equal(validate(mutate(attachment,a=>a.changes[0].references=[]),E),false)
  const interpretation={id:id(6),state:'proposed',proposal_id:p.proposal_id,claims:[{id:'claim',text:p.claim,references:[reference()]}],limitations:['Unverified causal effect']}
  assert.ok(attachmentValid(attachment,p,interpretation))
  for(const change of [a=>a.proposal_id=id(99),a=>a.proposal_sha256=hash('stale'),a=>a.interpretation_id=id(99),a=>a.changes.push(a.changes[0]),a=>a.changes[0].claim_id='other',a=>a.changes[0].references[0].revision_id=id(99),a=>a.changes[0].limitations=[]])assert.equal(attachmentValid(mutate(attachment,change),p,interpretation),false)
  assert.equal(attachmentValid(attachment,{...p,claim:'Changed claim'},interpretation),false)
})
test('R11: coaching records separate reports, commitments and verified outcomes',()=>{
  const base={schema_version:1,id:id(20),record_revision:1,kind:'question',question_id:id(20),created_at:time,author:actor,body:'How can the handoff improve?',references:[],question_state:'open'}
  assert.ok(validate(base,C));assert.deepEqual(coachingErrors(base),[])
  const {question_state,...common}=base,session={...common,id:id(21),kind:'session',observations:[{kind:'hypothesis',text:'Try a checklist',author:{kind:'agent',id:'synthetic'},references:[]}]}
  assert.ok(validate(session,C));assert.equal(validate(mutate(session,s=>s.observations[0].kind='source_fact'),C),false)
  const action={...common,id:id(22),kind:'action',session_id:session.id,action_state:'confirmed'}
  assert.equal(validate(action,C),false)
  action.confirmation={actor,at:time,record_sha256:hash(JSON.stringify(action))}
  assert.ok(validate(action,C));assert.deepEqual(coachingErrors(action),[])
  assert.equal(validate(mutate(action,a=>a.confirmation.actor.kind='agent'),C),false)
  assert.ok(coachingErrors({...action,body:'Changed action'}).includes('stale-decision'))
  assert.ok(coachingErrors({...session,action_state:'confirmed'}).includes('wrong-kind-field'))
  const review={...common,id:id(23),kind:'review',action_id:action.id,execution_report:'reported_done',outcome_state:'reported'}
  assert.ok(validate(review,C));assert.equal(validate({...review,outcome_state:'verified'},C),false)
  assert.equal(validate({...review,knowledge_status:'approved'},C),false)
})
test('R13: corpus covers every requirement and is excluded from package allowlist',()=>{
  assert.deepEqual(requirements.map(r=>r.id),Array.from({length:13},(_,i)=>`R${String(i+1).padStart(2,'0')}`))
  for(const row of requirements)assert.ok(inventory[row.fixture]?.length)
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)))
  assert.ok(!pkg.files.some(path=>path==='tests'||path==='tests/fixtures'||path==='*'))
})
test('R11: linked coaching cycle rejects absent/wrong parent kinds and cross-question ancestry',()=>{
  const q={schema_version:1,id:id(30),record_revision:1,kind:'question',question_id:id(30),created_at:time,author:actor,body:'Synthetic question',references:[],question_state:'open'}
  const {question_state,...common}=q
  const s={...common,id:id(31),kind:'session',observations:[]},a={...common,id:id(32),kind:'action',session_id:s.id,action_state:'proposed'},r={...common,id:id(33),kind:'review',action_id:a.id,execution_report:'unknown',outcome_state:'unknown'}
  const cycle=[q,s,a,r]
  for(const record of cycle)assert.ok(validate(record,C))
  assert.deepEqual(coachingCycleErrors(cycle),[])
  for(const change of [x=>x[1].question_id=id(99),x=>x[1].question_id=s.id,x=>x[2].session_id=id(99),x=>x[2].session_id=q.id,x=>x[3].action_id=id(99),x=>x[3].action_id=s.id])assert.ok(coachingCycleErrors(mutate(cycle,change)).some(code=>['question-parent','cycle-parent'].includes(code)))
  const other={...q,id:id(40),question_id:id(40)}
  for(const index of [1,2,3])assert.ok(coachingCycleErrors(mutate([...cycle,other],x=>x[index].question_id=other.id)).includes('question-ancestry'))
  assert.ok(coachingCycleErrors([...cycle,q]).includes('duplicate-record'))
})
