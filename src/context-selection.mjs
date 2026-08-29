import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONTEXT_BUDGETS=Object.freeze({small:8_000,standard:24_000,deep:64_000,unbounded:Number.MAX_SAFE_INTEGER})
export const KNOWLEDGE_STATUSES=Object.freeze(['current','historical','superseded'])
export const TEMPORAL_SCOPES=Object.freeze(['current','time-bounded','historical','timeless'])

const STOPWORDS=new Set(`a an and are as at be been before between both but by can current do does for from had has have how i if in into is it its me more my no not of on or our should so than that the their them then there these they this those through to under use used using was we were what when where which who why will with you your
de een en het in is met om op te van voor wat wie zijn
e o a os as um uma de do da dos das em no na nos nas para por que se seu sua
der die das ein eine und ist mit von zu`.split(/\s+/))

function hash(value){return createHash('sha256').update(value).digest('hex')}
export function estimateTokens(chars){return Math.ceil(Number(chars||0)/4)}
export function tokenize(text){return [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(token=>!STOPWORDS.has(token)))]}
export function contextNeed(task=''){const tokens=new Set(tokenize(task));if(['identity','career','leadership','voice','preference','personal','interview','application','holoself'].some(x=>tokens.has(x)))return 'required';if(['format','rename','compile','lint','test','syntax','install'].some(x=>tokens.has(x)))return 'not-needed';return task?'helpful':'not-needed'}

function dateValue(value){if(typeof value!=='string'||!value.trim())return null;const parsed=Date.parse(value);return Number.isNaN(parsed)?null:parsed}
export function temporalDisposition(metadata={},task='',options={}){
  const declaredStatus=KNOWLEDGE_STATUSES.includes(metadata.knowledge_status)?metadata.knowledge_status:'current'
  const now=options.now?Date.parse(options.now):Date.now(),until=dateValue(metadata.valid_until),status=declaredStatus==='current'&&until!==null&&until<now?'historical':declaredStatus
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
  const wanted=tokenize(task),pathTokens=new Set(tokenize(record.path)),contentTokens=new Set(tokenize(record.content)),headingTokens=new Set(tokenize((record.content.match(/^#{1,3}\s+.+$/gm)||[]).join(' ')))
  let score=0
  for(const token of wanted){if(pathTokens.has(token))score+=6;if(headingTokens.has(token))score+=3;if(contentTokens.has(token))score+=1}
  if(record.document_role==='policy')score+=2
  if(/^profile\/(?:identity|work-context|preferences|voice|thinking|change)\.md$/i.test(record.path))score+=2
  if(record.kind==='contrib')score=Math.max(0,score-2)
  return score
}

function sections(content){
  const lines=String(content).split(/\r?\n/),out=[];let current=[]
  for(const line of lines){if(/^#{1,4}\s+/.test(line)&&current.length){out.push(current.join('\n'));current=[]}current.push(line)}
  if(current.length)out.push(current.join('\n'));return out
}
function excerpt(content,task,limit){
  if(content.length<=limit)return {content,truncated:false}
  const wanted=new Set(tokenize(task)),ranked=sections(content).map((text,index)=>({text,index,score:tokenize(text).filter(token=>wanted.has(token)).length})).sort((a,b)=>b.score-a.score||a.index-b.index)
  let selected='',used=[]
  for(const section of ranked){if(used.includes(section.index))continue;const next=(selected?`${selected}\n\n`:'')+section.text;if(next.length>limit)continue;selected=next;used.push(section.index);if(selected.length>=limit*.8)break}
  if(!selected)selected=content.slice(0,Math.max(0,limit-40))
  return {content:`${selected.trimEnd()}\n\n[Context excerpt truncated]`,truncated:true}
}

export function sourceId(record){return `hs-${hash(`${record.kind}\0${record.path}`).slice(0,20)}`}
function contradictionDigest(records){
  const items=records.map(record=>({id:sourceId(record),headings:(record.content.match(/^#{1,3}\s+(.+)$/gm)||[]).map(x=>x.replace(/^#+\s+/,'').toLowerCase()),numbers:[...new Set(record.content.match(/\b\d+(?:\.\d+)?%?\b/g)||[])],supersedes:record.metadata?.supersedes||[],superseded_by:record.metadata?.superseded_by||null})),pairs=[]
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(items[i].headings.some(value=>items[j].headings.includes(value))&&items[i].numbers.length&&items[j].numbers.length&&items[i].numbers.some(value=>!items[j].numbers.includes(value)))pairs.push([items[i].id,items[j].id])
  const provenance=items.map(({id,supersedes,superseded_by})=>({id,supersedes,superseded_by}));return {schema_version:1,digest:hash(JSON.stringify(provenance)),supersession_edges:provenance.reduce((sum,item)=>sum+item.supersedes.length+Number(Boolean(item.superseded_by)),0),potential_conflicts:pairs.length,source_pairs:pairs.slice(0,20)}
}
export function selectContextRecords(records,options={}){
  const budgetName=options.budget||'standard',budgetChars=CONTEXT_BUDGETS[budgetName]
  if(!budgetChars)throw new Error(`invalid context budget: ${budgetName}`)
  const requested=new Set(options.sources||[]),temporalExcluded=[],candidates=[]
  for(const record of records){
    const temporal=temporalDisposition(record.metadata,options.task,{includeHistory:options.includeHistory,temporal:options.temporal,now:options.now})
    if(!temporal.include){temporalExcluded.push({source:record.path,reason:temporal.reason});continue}
    const score=relevanceScore(record,options.task),id=sourceId(record)
    if(requested.size&&!requested.has(id)&&!requested.has(record.path))continue
    candidates.push({...record,task_relevance:score,source_id:id,knowledge_status:temporal.status,temporal_scope:temporal.scope})
  }
  candidates.sort((a,b)=>{
    if(requested.size)return a.path.localeCompare(b.path)
    return b.task_relevance-a.task_relevance||a.path.localeCompare(b.path)
  })
  const selected=[],omitted=[];let chars=0
  for(const record of candidates){
    if(options.task&&!requested.size&&record.kind==='project'&&record.task_relevance<=0&&record.document_role!=='policy'){omitted.push({source:record.path,reason:'no meaningful task relevance'});continue}
    if(record.kind==='contrib'&&selected.filter(item=>item.kind==='contrib').length>=2){omitted.push({source:record.path,reason:'contrib selection limit reached'});continue}
    if(options.manifest){selected.push({...record,content:'',manifest_only:true,truncated:false});continue}
    const remaining=budgetChars-chars
    if(remaining<160){omitted.push({source:record.path,reason:`context budget ${budgetName} exhausted`});continue}
    const result=excerpt(record.content,options.task,remaining)
    if(!result.content.trim()){omitted.push({source:record.path,reason:'empty after filtering'});continue}
    selected.push({...record,content:result.content,truncated:result.truncated});chars+=result.content.length
  }
  const receiptInput={budget:budgetName,task_hash:hash(String(options.task||'')),lens:options.lens||null,sources:selected.map(record=>[record.source_id,record.source_hash,record.truncated])}
  return {
    records:selected,
    omitted,
    temporalExcluded,
    selection:{
      schema_version:1,context_need:contextNeed(options.task),budget:budgetName,budget_chars:budgetChars===Number.MAX_SAFE_INTEGER?null:budgetChars,manifest_only:Boolean(options.manifest),temporal:options.temporal||'current',candidate_count:records.length,eligible_count:candidates.length,selected_count:selected.length,omitted_count:omitted.length+temporalExcluded.length,content_chars:chars,estimated_tokens:estimateTokens(chars),truncated_sources:selected.filter(record=>record.truncated).map(record=>record.source_id),selected_sources:selected.map(record=>record.source_id),temporal_excluded:temporalExcluded.length,contrib_sources:selected.filter(record=>record.kind==='contrib').map(record=>record.source_id),contradiction_digest:contradictionDigest(selected)
    },
    receipt:{schema_version:1,context_hash:hash(JSON.stringify(receiptInput)),task_hash:receiptInput.task_hash,lens:receiptInput.lens,budget:budgetName,temporal:options.temporal||'current',source_ids:selected.map(record=>record.source_id),source_hashes:selected.map(record=>record.source_hash)}
  }
}

const CACHE=new Map()
function cacheKey(records,options={}){const state=records.map(record=>[sourceId(record),record.source_hash,record.content.length]);return hash(JSON.stringify({state,task:options.task||'',lens:options.lens||'',budget:options.budget||'standard',manifest:Boolean(options.manifest),sources:options.sources||[],temporal:options.temporal||'current',history:Boolean(options.includeHistory)}))}
export function cachedSelection(records,options={}){
  const key=cacheKey(records,options)
  if(CACHE.has(key))return {...structuredClone(CACHE.get(key)),cache:{key,hit:true}}
  const result=selectContextRecords(records,options);CACHE.set(key,result);if(CACHE.size>64)CACHE.delete(CACHE.keys().next().value)
  return {...structuredClone(result),cache:{key,hit:false}}
}
export function persistentSelection(records,options={},cacheDir){
  if(!cacheDir)return cachedSelection(records,options);const key=cacheKey(records,options),path=join(cacheDir,`${key}.json`)
  if(existsSync(path)){try{const value=JSON.parse(readFileSync(path,'utf8'));if(value?.receipt?.context_hash)return {...value,cache:{key,hit:true,persistent:true}}}catch{}}
  const value=selectContextRecords(records,options),stored={...value};mkdirSync(cacheDir,{recursive:true});const temporary=`${path}.tmp-${process.pid}`;writeFileSync(temporary,JSON.stringify(stored),'utf8');renameSync(temporary,path);return {...structuredClone(value),cache:{key,hit:false,persistent:true}}
}
