import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalJson } from './catalog.mjs'

export const CONTEXT_BUDGETS=Object.freeze({small:8_000,standard:24_000,deep:64_000,unbounded:Number.MAX_SAFE_INTEGER})
export const ENVELOPE_BYTE_CAPS=Object.freeze({small:16_384,standard:49_152,deep:131_072,unbounded:Number.MAX_SAFE_INTEGER})
export const KNOWLEDGE_STATUSES=Object.freeze(['current','historical','superseded'])
export const TEMPORAL_SCOPES=Object.freeze(['current','time-bounded','historical','timeless'])

const STOPWORDS=new Set(`a an and are as at be been before between both but by can current do does for from had has have how i if in into is it its me more my no not of on or our should so than that the their them then there these they this those through to under use used using was we were what when where which who why will with you your
de een en het in is met om op te van voor wat wie zijn
e o a os as um uma de do da dos das em no na nos nas para por que se seu sua
der die das ein eine und ist mit von zu`.split(/\s+/))

function hash(value){return createHash('sha256').update(value).digest('hex')}
export function estimateTokens(chars){return Math.ceil(Number(chars||0)/4)}
export function tokenize(text){return [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(token=>!STOPWORDS.has(token)))]}
const PERSONAL_PATTERN = /(?:^|[^\p{L}\p{N}])(?:identi(?:ty|ties|dade|dades)|career|careers|carreir[ao]s?|leadership|lideran[cç]as?|voice|voices|voz(?:es)?|prefer[eê]n(?:ce|ces|cia|cias|ça|ças)|personal|personally|pessoais|pessoal|interview|interviews|entrevistas?|application|applications|apresenta[cç][aã]o|apresenta[cç][oõ]es|priorit(?:y|ies)|prioridades?|hist[oó]rias?|holoself)(?:$|[^\p{L}\p{N}])/iu
const MECHANICAL_PATTERN = /(?:^|[^\p{L}\p{N}])(?:format(?:s|ed|ing|e|ar|ando|ado|[aã]o|[oõ]es)?|rename|renam(?:ed|ing)|renome(?:ar|ie|ando|ado)|compile|compil(?:ed|ing|ar|e|ando|ado|[aã]o)|lint(?:s|ed|ing|ar)?|syntax|sintaxe|tests?|test(?:ed|ing|ar|e|ando|ado)|install|install(?:ed|ing)|instal(?:ar|e|ando|ado|[aã]o)|sort|sort(?:s|ed|ing)|orden(?:ar|e|ando|ado|[aã]o)|convert|convert(?:s|ed|ing|er|a|endo|ido)|convers[aã]o|indent|indent(?:s|ed|ing|ar|e|ando|ado|[aã]o)|fix(?:es|ed|ing)?|corri(?:gir|ja|gindo|gido)|corre[cç][aã]o)(?:$|[^\p{L}\p{N}])/iu

export function contextNeed(task=''){
  const str = String(task).trim()
  if(!str) return 'helpful'
  if(PERSONAL_PATTERN.test(str)) return 'required'
  if(MECHANICAL_PATTERN.test(str)) return 'not-needed'
  return 'helpful'
}

export function dateValue(value,isEnd=false){if(typeof value!=='string'||!value.trim())return null;const str=value.trim(),iso=/^\d{4}-\d{2}-\d{2}$/.test(str)?(str+(isEnd?'T23:59:59.999Z':'T00:00:00.000Z')):str,parsed=Date.parse(iso);return Number.isNaN(parsed)?0:parsed}
export function temporalDisposition(metadata={},task='',options={}){
  const declaredStatus=KNOWLEDGE_STATUSES.includes(metadata.knowledge_status)?metadata.knowledge_status:'current'
  const now=options.now?Date.parse(options.now):Date.now(),until=dateValue(metadata.valid_until,true),status=declaredStatus==='current'&&until!==null&&until<now?'historical':declaredStatus
  const scope=TEMPORAL_SCOPES.includes(metadata.temporal_scope)?metadata.temporal_scope:(status==='current'?'current':'historical')
  const taskTokens=new Set(tokenize(task)),temporal=options.temporal||'current',historyRequested=Boolean(options.includeHistory)||temporal!=='current'||['history','historical','previous','past','superseded','archive','timeline'].some(token=>taskTokens.has(token))
  if(!['current','historical','superseded','all'].includes(temporal))throw new Error(`invalid temporal selector: ${temporal}`)
  if(temporal!=='all'&&temporal!==status)return {include:false,reason:`knowledge status ${status} excluded by temporal selector ${temporal}`,status,scope}
  if(status==='superseded'&&!historyRequested)return {include:false,reason:'knowledge status superseded',status,scope}
  if((status==='historical'||scope==='historical')&&!historyRequested)return {include:false,reason:'historical knowledge not requested',status,scope}
  if(until!==null&&until<now&&temporal==='current')return {include:false,reason:`knowledge expired ${metadata.valid_until}`,status,scope}
  return {include:true,reason:null,status,scope}
}

export function relevanceScore(record,task){
  if(!task)return record.document_role==='policy'?4:1
  const text=record.content||record.search_text||''
  const wanted=tokenize(task),pathTokens=new Set(tokenize(record.path)),contentTokens=new Set(tokenize(text))
  const headingSource=record.sections?record.sections.map(s=>s.heading).join(' '):text
  const headingTokens=new Set(tokenize((headingSource.match(/^#{1,3}\s+.+$/gm)||headingSource.split(/\s+/)).join(' ')))
  let score=0
  for(const token of wanted){if(pathTokens.has(token))score+=6;if(headingTokens.has(token))score+=3;if(contentTokens.has(token))score+=2}
  if(record.document_role==='policy')score+=2
  if(/^profile\/(?:identity|work-context|preferences|voice|thinking|change)\.md$/i.test(record.path))score+=2
  if(record.kind==='contrib')score=Math.max(0,score-2)
  return score
}

export function sections(content){
  const lines=String(content).split(/\r?\n/),out=[];let current=[]
  for(const line of lines){if(/^#{1,4}\s+/.test(line)&&current.length){out.push(current.join('\n'));current=[]}current.push(line)}
  if(current.length)out.push(current.join('\n'));return out
}
export function excerpt(content,task,limit){
  if(content.length<=limit)return {content,truncated:false}
  const wanted=new Set(tokenize(task)),ranked=sections(content).map((text,index)=>({text,index,score:tokenize(text).filter(token=>wanted.has(token)).length})).sort((a,b)=>b.score-a.score||a.index-b.index)
  let selected='',used=[]
  for(const section of ranked){if(used.includes(section.index))continue;const next=(selected?`${selected}\n\n`:'')+section.text;if(next.length>limit)continue;selected=next;used.push(section.index);if(selected.length>=limit*.8)break}
  if(!selected)selected=content.slice(0,Math.max(0,limit-40))
  return {content:`${selected.trimEnd()}\n\n[Context excerpt truncated]`,truncated:true}
}

export function sourceId(record){return record.source_ref?.source_id || record.source_id || `hs-${hash(`${record.kind}\0${record.path}`).slice(0,20)}`}
export function contradictionDigest(records){
  const items=records.map(record=>({id:sourceId(record),headings:(record.content.match(/^#{1,3}\s+(.+)$/gm)||[]).map(x=>x.replace(/^#+\s+/,'').toLowerCase()),numbers:[...new Set(record.content.match(/\b\d+(?:\.\d+)?%?\b/g)||[])],supersedes:record.metadata?.supersedes||[],superseded_by:record.metadata?.superseded_by||null})),pairs=[]
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(items[i].headings.some(value=>items[j].headings.includes(value))&&items[i].numbers.length&&items[j].numbers.length&&items[i].numbers.some(value=>!items[j].numbers.includes(value)))pairs.push([items[i].id,items[j].id])
  const provenance=items.map(({id,supersedes,superseded_by})=>({id,supersedes,superseded_by}));return {schema_version:1,digest:hash(JSON.stringify(provenance)),supersession_edges:provenance.reduce((sum,item)=>sum+item.supersedes.length+Number(Boolean(item.superseded_by)),0),potential_conflicts:pairs.length,source_pairs:pairs.slice(0,20)}
}
export function buildCursor(identityId,lens,budgetName,manifest,selfId,taskHash,temporalVal,nextOffset,stateHash,cursorSecret){
  const payloadToSign=`v1|${identityId}|${lens}|${budgetName}|${manifest?'true':'false'}|${selfId||''}|${taskHash}|${temporalVal}|${nextOffset}|${stateHash}`
  const sig=cursorSecret?createHmac('sha256',cursorSecret).update(payloadToSign).digest('hex'):hash(payloadToSign)
  return Buffer.from(JSON.stringify({p:{v:1,identity_id:identityId,lens,budget:budgetName,manifest:Boolean(manifest),self_id:selfId||'',task_hash:taskHash,temporal:temporalVal,offset:nextOffset,state_hash:stateHash},sig})).toString('base64url')
}
const cursorError=message=>{const err=new Error(message);err.code='CURSOR_INVALID';return err}
// The only cursor decoder: every selection path verifies signature, parameters and state before using an offset.
export function verifyCursor(cursor,expected){
  if(!cursor)return 0
  let parsed
  try{parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'))}catch{throw cursorError('malformed cursor')}
  if(!parsed?.p||!parsed?.sig||typeof parsed.sig!=='string')throw cursorError('invalid cursor format')
  const p=parsed.p
  if(p.v!==1||p.identity_id!==expected.identityId||p.lens!==expected.lens||p.task_hash!==expected.taskHash||p.temporal!==expected.temporalVal)throw cursorError('cursor parameter mismatch')
  const signed=`v1|${p.identity_id}|${p.lens}|${p.budget}|${p.manifest}|${p.self_id}|${p.task_hash}|${p.temporal}|${p.offset}|${p.state_hash}`
  const expectedSig=expected.cursorSecret?createHmac('sha256',expected.cursorSecret).update(signed).digest('hex'):hash(signed)
  const sigBuf=Buffer.from(parsed.sig),expBuf=Buffer.from(expectedSig)
  if(sigBuf.length!==expBuf.length||!timingSafeEqual(sigBuf,expBuf))throw cursorError('invalid cursor signature')
  if(p.state_hash!==expected.stateHash)throw cursorError('cursor state expired due to changes; restart from offset 0')
  return Number.isInteger(p.offset)&&p.offset>=0?p.offset:0
}

// Session start: no task, no explicit sources and no cursor. The lens names the self sources to load; "*" keeps all.
export const DEFAULT_SESSION_START_SOURCES=Object.freeze(['profile/identity.md','profile/preferences.md','profile/work-context.md'])
const globSegment=pattern=>new RegExp(`^${pattern.split('*').map(part=>part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')}$`)
export function sessionStartIndex(path,patterns){
  const parts=String(path).split('/')
  return patterns.findIndex(pattern=>{if(pattern==='*')return true;const want=pattern.split('/');return want.length===parts.length&&want.every((segment,i)=>globSegment(segment).test(parts[i]))})
}
// Session start is explicit (--session-start / session_start) so snapshots and other task-less calls keep full selection.
export function isSessionStart(options){return Boolean(options.sessionStart)&&!options.task&&!(options.sources?.length)&&!options.cursor}

// Temporal filter, relevance score and deterministic ranking shared by every path.
export function rankCandidates(records,options={}){
  const requested=new Set(options.sources||[]),temporalExcluded=[],candidates=[]
  for(const record of records){
    const temporal=temporalDisposition(record.metadata,options.task,{includeHistory:options.includeHistory,temporal:options.temporal,now:options.now})
    if(!temporal.include){temporalExcluded.push({source:record.path,reason:temporal.reason});continue}
    const score=relevanceScore(record,options.task),id=sourceId(record)
    if(requested.size&&!requested.has(id)&&!requested.has(record.path))continue
    candidates.push({...record,task_relevance:score,source_id:id,knowledge_status:temporal.status,temporal_scope:temporal.scope})
  }
  const byId=(a,b)=>(a.source_id<b.source_id?-1:a.source_id>b.source_id?1:0)||(a.path<b.path?-1:a.path>b.path?1:0)
  candidates.sort((a,b)=>requested.size?byId(a,b):b.task_relevance-a.task_relevance||byId(a,b))
  return {candidates,temporalExcluded,requested}
}

export function applyManifestPage(candidates,startOffset,options={}){
  const envelopeCap=ENVELOPE_BYTE_CAPS[options.budget||'standard']||ENVELOPE_BYTE_CAPS.standard,PAGE_SIZE=10,records=[],omitted=[]
  let curr=startOffset,truncated=false
  while(curr<candidates.length&&records.length<PAGE_SIZE){
    const record=candidates[curr]
    if(Buffer.byteLength(JSON.stringify({source_id:record.source_id,path:record.path,kind:record.kind,metadata:record.metadata}))>envelopeCap){omitted.push({source:record.path,reason:'source exceeds envelope budget'});curr++;truncated=true;break}
    records.push({...record,content:'',manifest_only:true,truncated:false});curr++
  }
  return {records,omitted,truncated,nextOffset:curr<candidates.length?curr:null}
}

// The only content-selection loop, in order: not-needed self skip, project relevance, contrib limit,
// session-start sources, budget floor, delivery, excerpt.
export function applySelectionPolicy(candidates,options={}){
  const budgetName=options.budget||'standard',budgetChars=CONTEXT_BUDGETS[budgetName]||CONTEXT_BUDGETS.standard,requested=new Set(options.sources||[])
  const isNotNeeded=contextNeed(options.task)==='not-needed',patterns=options.sessionStartSources||DEFAULT_SESSION_START_SOURCES
  const sessionFilter=isSessionStart(options)&&!patterns.includes('*')
  let ordered=candidates
  // Session start: self sources first, in pattern order (unmatched self last), then the rest in rank order.
  let unmatchedPatterns=[]
  if(sessionFilter){
    const self=candidates.map((record,i)=>({record,i})).filter(x=>x.record.kind==='self').map(x=>({...x,r:sessionStartIndex(x.record.path,patterns)})),rank=x=>x.r<0?patterns.length:x.r
    ordered=[...self.sort((a,b)=>rank(a)-rank(b)||a.i-b.i).map(x=>x.record),...candidates.filter(record=>record.kind!=='self')]
    unmatchedPatterns=patterns.filter((_,index)=>!self.some(x=>x.r===index))
  }
  const records=[],omitted=[];let chars=0,truncated=false
  for(const record of ordered){
    if(!requested.size&&isNotNeeded&&record.kind==='self'){omitted.push({source:record.path,reason:'personal context not needed for this task'});continue}
    if(options.task&&!requested.size&&record.kind==='project'&&record.task_relevance<=0&&record.document_role!=='policy'){omitted.push({source:record.path,reason:'no meaningful task relevance'});continue}
    if(record.kind==='contrib'&&records.filter(item=>item.kind==='contrib').length>=2){omitted.push({source:record.path,reason:'contrib selection limit reached'});continue}
    if(sessionFilter&&record.kind==='self'&&record.document_role!=='policy'&&sessionStartIndex(record.path,patterns)<0){omitted.push({source:record.path,reason:'not in lens session_start_sources'});continue}
    const remaining=budgetChars-chars
    if(remaining<160){omitted.push({source:record.path,reason:`context budget ${budgetName} exhausted`});truncated=true;continue}
    let content=record.content,next=record
    if(!content&&options.deliver){
      const delivered=options.deliver(record)
      if(!delivered){if(record.delivery_reason)omitted.push({source:record.path,reason:record.delivery_reason});continue}
      content=delivered.content
      next={...record}
      for(const key of ['source_hash','freshness','sections','claims','tags','links','search_text','metadata'])if(delivered[key])next[key]=delivered[key]
      if(delivered.estimated_tokens!==undefined)next.estimated_tokens=delivered.estimated_tokens
    }
    const result=excerpt(content||'',options.task,remaining)
    if(!result.content.trim()){omitted.push({source:record.path,reason:'empty after filtering'});continue}
    records.push({...next,content:result.content,truncated:result.truncated})
    chars+=result.content.length
    if(result.truncated)truncated=true
  }
  return {records,omitted,chars,truncated,unmatchedPatterns}
}

export function selectionReceipt(records,{budget,taskHash,lens,temporal}){
  const receiptInput={budget,task_hash:taskHash,lens:lens||null,sources:records.map(record=>[record.source_id,record.source_hash,record.truncated])}
  return {schema_version:1,context_hash:hash(canonicalJson(receiptInput)),task_hash:taskHash,lens:lens||null,budget,temporal,source_ids:records.map(record=>record.source_id),source_hashes:records.map(record=>record.source_hash)}
}

export function selectContextRecords(records,options={}){
  const budgetName=options.budget||'standard',budgetChars=CONTEXT_BUDGETS[budgetName]
  if(!budgetChars)throw new Error(`invalid context budget: ${budgetName}`)
  const {candidates,temporalExcluded}=rankCandidates(records,options)
  const taskHash=hash(String(options.task||'')),temporalVal=options.temporal||'current',identityId=options.identityId||'anonymous'
  const stateHash=hash(JSON.stringify([options.registryHash||'',options.allowedLenses||[],candidates.map(c=>[c.source_id,c.source_hash])]))
  const startOffset=verifyCursor(options.cursor,{identityId,lens:options.lens,taskHash,temporalVal,stateHash,cursorSecret:options.cursorSecret})
  let picked,nextCursor=null
  if(options.manifest){
    const page=applyManifestPage(candidates,startOffset,{budget:budgetName})
    picked={records:page.records,omitted:page.omitted,chars:0,truncated:page.truncated}
    if(page.nextOffset!==null)nextCursor=buildCursor(identityId,options.lens,budgetName,true,options.selfId,taskHash,temporalVal,page.nextOffset,stateHash,options.cursorSecret)
  }else picked=applySelectionPolicy(candidates,{...options,budget:budgetName})
  const selected=picked.records,omitted=picked.omitted,chars=picked.chars
  return {
    records:selected,
    omitted,
    temporalExcluded,
    candidates,
    startOffset,
    taskHash,
    temporalVal,
    stateHash,
    selection:{
      schema_version:1,context_need:contextNeed(options.task),budget:budgetName,budget_chars:budgetChars===Number.MAX_SAFE_INTEGER?null:budgetChars,manifest_only:Boolean(options.manifest),temporal:temporalVal,session_start:!options.manifest&&isSessionStart(options),candidate_count:records.length,eligible_count:candidates.length,selected_count:selected.length,omitted_count:omitted.length+temporalExcluded.length,content_chars:chars,estimated_tokens:estimateTokens(chars),truncated:picked.truncated||selected.some(r=>r.truncated),truncated_sources:selected.filter(record=>record.truncated).map(record=>record.source_id),selected_sources:selected.map(record=>record.source_id),temporal_excluded:temporalExcluded.length,contrib_sources:selected.filter(record=>record.kind==='contrib').map(record=>record.source_id),contradiction_digest:contradictionDigest(selected),next_cursor:nextCursor,...(picked.unmatchedPatterns?.length?{session_start_unmatched:picked.unmatchedPatterns}:{})
    },
    receipt:selectionReceipt(selected,{budget:budgetName,taskHash,lens:options.lens,temporal:temporalVal})
  }
}

// In-memory cache of selection inputs. A hit re-runs the same selection so cold and warm results cannot drift;
// it only records that the inputs were seen before and keeps the earliest valid_until expiry.
const CACHE=new Map()
function cacheKey(records,options={}){
  const state=records.map(record=>[sourceId(record),record.source_hash,record.content?.length||0])
  return hash(JSON.stringify({
    state,
    identity_id:options.identityId||null,
    allowed_lenses:options.allowedLenses||null,
    task:options.task||'',
    lens:options.lens||'',
    budget:options.budget||'standard',
    manifest:Boolean(options.manifest),
    sources:options.sources||[],
    temporal:options.temporal||'current',
    history:Boolean(options.includeHistory),
    cursor:options.cursor||null,
    session_start:Boolean(options.sessionStart),
    session_start_sources:options.sessionStartSources||null
  }))
}
export function cachedSelection(records,options={}){
  const key=cacheKey(records,options),nowMs=options?.now?(typeof options.now==='number'?options.now:Date.parse(options.now)||Date.now()):Date.now()
  const cached=CACHE.get(key),hit=Boolean(cached&&(cached.valid_until_epoch_ms===null||nowMs<cached.valid_until_epoch_ms))
  const result=selectContextRecords(records,options)
  if(!hit){
    const validUntilValues=records.map(r=>dateValue(r.metadata?.valid_until,true)).filter(v=>v!==null&&v>nowMs)
    CACHE.set(key,{valid_until_epoch_ms:validUntilValues.length?Math.min(...validUntilValues):null});if(CACHE.size>64)CACHE.delete(CACHE.keys().next().value)
  }
  return {...result,cache:{key,hit,persistent:false}}
}
