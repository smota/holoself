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
export function selectContextRecords(records,options={}){
  const budgetName=options.budget||'standard',budgetChars=CONTEXT_BUDGETS[budgetName]
  if(!budgetChars)throw new Error(`invalid context budget: ${budgetName}`)
  const envelopeCap=ENVELOPE_BYTE_CAPS[budgetName]||ENVELOPE_BYTE_CAPS.standard
  const requested=new Set(options.sources||[]),temporalExcluded=[],candidates=[]
  for(const record of records){
    const temporal=temporalDisposition(record.metadata,options.task,{includeHistory:options.includeHistory,temporal:options.temporal,now:options.now})
    if(!temporal.include){temporalExcluded.push({source:record.path,reason:temporal.reason});continue}
    const score=relevanceScore(record,options.task),id=sourceId(record)
    if(requested.size&&!requested.has(id)&&!requested.has(record.path))continue
    candidates.push({...record,task_relevance:score,source_id:id,knowledge_status:temporal.status,temporal_scope:temporal.scope})
  }
  candidates.sort((a,b)=>{
    if(requested.size)return (a.source_id<b.source_id?-1:a.source_id>b.source_id?1:0)||(a.path<b.path?-1:a.path>b.path?1:0)
    return b.task_relevance-a.task_relevance||(a.source_id<b.source_id?-1:a.source_id>b.source_id?1:0)||(a.path<b.path?-1:a.path>b.path?1:0)
  })

  const taskHash=hash(String(options.task||''))
  const temporalVal=options.temporal||'current'
  const identityId=options.identityId||'anonymous'
  const stateHash=hash(JSON.stringify([options.registryHash||'',options.allowedLenses||[],candidates.map(c=>[c.source_id,c.source_hash])]))

  let startOffset=0
  if(options.cursor){
    let parsed
    try{parsed=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'))}catch{const err=new Error('malformed cursor');err.code='CURSOR_INVALID';throw err}
    if(!parsed?.p||!parsed?.sig||typeof parsed.sig!=='string'){const err=new Error('invalid cursor format');err.code='CURSOR_INVALID';throw err}
    const p=parsed.p
    if(p.v!==1||p.identity_id!==identityId||p.lens!==options.lens||p.task_hash!==taskHash||p.temporal!==temporalVal){const err=new Error('cursor parameter mismatch');err.code='CURSOR_INVALID';throw err}
    if(options.cursorSecret){
      const expectedPayload=`v1|${p.identity_id}|${p.lens}|${p.budget}|${p.manifest}|${p.self_id}|${p.task_hash}|${p.temporal}|${p.offset}|${p.state_hash}`
      const expectedSig=createHmac('sha256',options.cursorSecret).update(expectedPayload).digest('hex')
      const sigBuf=Buffer.from(parsed.sig),expBuf=Buffer.from(expectedSig)
      if(sigBuf.length!==expBuf.length||!timingSafeEqual(sigBuf,expBuf)){const err=new Error('invalid cursor signature');err.code='CURSOR_INVALID';throw err}
    }
    if(p.state_hash!==stateHash){const err=new Error('cursor state expired due to changes; restart from offset 0');err.code='CURSOR_INVALID';throw err}
    startOffset=Number.isInteger(p.offset)&&p.offset>=0?p.offset:0
  }

  const selected=[],omitted=[];let chars=0,nextCursor=null,isTruncated=false
  if(options.manifest){
    const PAGE_SIZE=10
    let curr=startOffset
    while(curr<candidates.length&&selected.length<PAGE_SIZE){
      const record=candidates[curr]
      const approxBytes=Buffer.byteLength(JSON.stringify({source_id:record.source_id,path:record.path,kind:record.kind,metadata:record.metadata}))
      if(approxBytes>envelopeCap){
        omitted.push({source:record.path,reason:'source exceeds envelope budget'})
        curr++;isTruncated=true;break
      }
      selected.push({...record,content:'',manifest_only:true,truncated:false})
      curr++
    }

    if(curr<candidates.length){
      nextCursor=buildCursor(identityId,options.lens,budgetName,true,options.selfId,taskHash,temporalVal,curr,stateHash,options.cursorSecret)
    }else{
      nextCursor=null
    }
  }else{
    const isNotNeeded=contextNeed(options.task)==='not-needed'
    for(const record of candidates){
      if(!requested.size&&isNotNeeded&&record.kind==='self'){omitted.push({source:record.path,reason:'personal context not needed for this task'});continue}
      if(options.task&&!requested.size&&record.kind==='project'&&record.task_relevance<=0&&record.document_role!=='policy'){omitted.push({source:record.path,reason:'no meaningful task relevance'});continue}
      if(record.kind==='contrib'&&selected.filter(item=>item.kind==='contrib').length>=2){omitted.push({source:record.path,reason:'contrib selection limit reached'});continue}
      const remaining=budgetChars-chars
      if(remaining<160){omitted.push({source:record.path,reason:`context budget ${budgetName} exhausted`});isTruncated=true;continue}

      let contentToExcerpt = record.content
      if(!contentToExcerpt && options.deliver){
        const delivered = options.deliver(record)
        if(!delivered){
          if(record.delivery_reason) omitted.push({source:record.path, reason: record.delivery_reason})
          continue
        }
        contentToExcerpt = delivered.content
        if(delivered.source_hash) record.source_hash = delivered.source_hash
        if(delivered.freshness) record.freshness = delivered.freshness
        if(delivered.estimated_tokens !== undefined) record.estimated_tokens = delivered.estimated_tokens
        if(delivered.sections) record.sections = delivered.sections
        if(delivered.claims) record.claims = delivered.claims
        if(delivered.tags) record.tags = delivered.tags
        if(delivered.links) record.links = delivered.links
        if(delivered.search_text) record.search_text = delivered.search_text
        if(delivered.metadata) record.metadata = delivered.metadata
      }

      const result=excerpt(contentToExcerpt || '',options.task,remaining)
      if(!result.content.trim()){omitted.push({source:record.path,reason:'empty after filtering'});continue}
      selected.push({...record,content:result.content,truncated:result.truncated})
      chars+=result.content.length
      if(result.truncated)isTruncated=true
    }
  }

  const receiptInput={budget:budgetName,task_hash:taskHash,lens:options.lens||null,sources:selected.map(record=>[record.source_id,record.source_hash,record.truncated])}
  const serializedContentBytes=Buffer.byteLength(JSON.stringify(selected))
  const estimatedTokensTotal=Math.ceil(serializedContentBytes/4)

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
      schema_version:1,context_need:contextNeed(options.task),budget:budgetName,budget_chars:budgetChars===Number.MAX_SAFE_INTEGER?null:budgetChars,manifest_only:Boolean(options.manifest),temporal:temporalVal,candidate_count:records.length,eligible_count:candidates.length,selected_count:selected.length,omitted_count:omitted.length+temporalExcluded.length,content_chars:chars,estimated_tokens:estimateTokens(chars),estimated_tokens_total_heuristic:estimatedTokensTotal,truncated:isTruncated||selected.some(r=>r.truncated),truncated_sources:selected.filter(record=>record.truncated).map(record=>record.source_id),selected_sources:selected.map(record=>record.source_id),temporal_excluded:temporalExcluded.length,contrib_sources:selected.filter(record=>record.kind==='contrib').map(record=>record.source_id),contradiction_digest:contradictionDigest(selected),next_cursor:nextCursor
    },
    receipt:{schema_version:1,context_hash:hash(canonicalJson(receiptInput)),task_hash:receiptInput.task_hash,lens:receiptInput.lens,budget:budgetName,temporal:temporalVal,source_ids:selected.map(record=>record.source_id),source_hashes:selected.map(record=>record.source_hash)}
  }
}

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
    cursor:options.cursor||null
  }))
}
export function cachedSelection(records,options={}){
  const key=cacheKey(records,options)
  const now=options.now?Date.parse(options.now):Date.now()
  if(CACHE.has(key)){
    const cached=CACHE.get(key)
    if(cached.valid_until_epoch_ms===undefined||cached.valid_until_epoch_ms===null||now<cached.valid_until_epoch_ms){
      if(options.deliver){
        const candById=new Map(records.map(c=>[sourceId(c),c]))
        const selectedCandidates=cached.records.map(r=>candById.get(sourceId(r))).filter(Boolean)
        const budgetName=options.budget||'standard'
        const budgetChars=CONTEXT_BUDGETS[budgetName]||CONTEXT_BUDGETS.standard
        const deliveredRecords=[]
        let chars=0,isTruncated=false
        const omitted = [...(cached.omitted || [])]
        if(options.manifest){
          for(const cand of selectedCandidates){
            deliveredRecords.push({
              ...cand,
              content:'',
              manifest_only:true,
              truncated:false,
              knowledge_status:cand.knowledge_status||'current',
              temporal_scope:cand.temporal_scope||'timeless'
            })
          }
        }else{
          const isNotNeeded=contextNeed(options.task)==='not-needed'
          for(const cand of selectedCandidates){
            if(!options.sources?.length&&isNotNeeded&&cand.kind==='self'){omitted.push({source:cand.path,reason:'personal context not needed for this task'});continue}
            const remaining=budgetChars-chars
            if(remaining<160){
              omitted.push({source:cand.path,reason:`context budget ${budgetName} exhausted`})
              isTruncated=true
              continue
            }
            const delivered=options.deliver(cand)
            if(!delivered){
              if(cand.delivery_reason) omitted.push({source:cand.path,reason:cand.delivery_reason})
              continue
            }
            const res=excerpt(delivered.content,options.task,remaining)
            if(!res.content.trim()){
              omitted.push({source:cand.path,reason:'empty after filtering'})
              continue
            }
            deliveredRecords.push({
              ...cand,
              content:res.content,
              metadata:delivered.metadata||cand.metadata,
              source_hash:delivered.source_hash||cand.source_hash,
              freshness:delivered.freshness||cand.freshness,
              estimated_tokens:delivered.estimated_tokens??cand.estimated_tokens,
              sections:delivered.sections||cand.sections,
              claims:delivered.claims||cand.claims,
              tags:delivered.tags||cand.tags,
              links:delivered.links||cand.links,
              search_text:delivered.search_text||cand.search_text,
              knowledge_status:cand.knowledge_status||'current',
              temporal_scope:cand.temporal_scope||'timeless',
              truncated:res.truncated
            })
            chars+=res.content.length
            if(res.truncated)isTruncated=true
          }
        }
        const taskHash=hash(String(options.task||''))
        const receiptInput={budget:budgetName,task_hash:taskHash,lens:options.lens||null,sources:deliveredRecords.map(record=>[record.source_id,record.source_hash,record.truncated])}
        const serializedContentBytes=Buffer.byteLength(JSON.stringify(deliveredRecords))
        const estimatedTokensTotal=Math.ceil(serializedContentBytes/4)
        const cloned=structuredClone(cached)
        cloned.records=deliveredRecords
        cloned.omitted=omitted
        cloned.receipt={
          schema_version:1,
          context_hash:hash(canonicalJson(receiptInput)),
          task_hash:taskHash,
          lens:options.lens||null,
          budget:budgetName,
          temporal:options.temporal||'current',
          source_ids:deliveredRecords.map(record=>record.source_id),
          source_hashes:deliveredRecords.map(record=>record.source_hash)
        }
        cloned.selection={
          ...cloned.selection,
          selected_count:deliveredRecords.length,
          omitted_count:omitted.length+(cloned.temporalExcluded?.length||0),
          content_chars:chars,
          estimated_tokens:estimateTokens(chars),
          estimated_tokens_total_heuristic:estimatedTokensTotal,
          truncated:isTruncated||deliveredRecords.some(r=>r.truncated),
          truncated_sources:deliveredRecords.filter(r=>r.truncated).map(r=>r.source_id),
          selected_sources:deliveredRecords.map(r=>r.source_id),
          contrib_sources:deliveredRecords.filter(r=>r.kind==='contrib').map(r=>r.source_id),
          contradiction_digest:contradictionDigest(deliveredRecords)
        }
        return {...cloned,cache:{key,hit:true,persistent:false}}
      }
      return {...structuredClone(cached),cache:{key,hit:true,persistent:false}}
    }
  }
  const result=selectContextRecords(records,options)
  const nowMs=options?.now?(typeof options.now==='number'?options.now:Date.parse(options.now)||Date.now()):Date.now()
  const validUntilValues=records.map(r=>dateValue(r.metadata?.valid_until,true)).filter(v=>v!==null&&v>nowMs)
  const valid_until_epoch_ms=validUntilValues.length?Math.min(...validUntilValues):null
  const toCache={...result,valid_until_epoch_ms}
  CACHE.set(key,toCache);if(CACHE.size>64)CACHE.delete(CACHE.keys().next().value)
  return {...structuredClone(result),cache:{key,hit:false,persistent:false}}
}
