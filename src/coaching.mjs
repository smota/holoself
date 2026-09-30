import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS = new Set(['user_report', 'hypothesis', 'intention'])
const OUTCOMES = new Set(['done', 'partial', 'not_done'])
const MATERIAL_STATES = new Set(['imported', 'partial', 'failed'])
const MAX_TEXT = 64 * 1024

function required(value, name, max=MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max) throw new Error(`${name} must be non-empty text of at most ${max} bytes`)
  return value.trim()
}
function directory(root, create=false) {
  const base=resolve(root)
  if (!existsSync(base) || lstatSync(base).isSymbolicLink() || !lstatSync(base).isDirectory()) throw new Error('coaching requires an existing regular self root; run init first')
  const coaching=join(base,'coaching'), sessions=join(coaching,'sessions')
  for (const dir of [coaching,sessions]) {
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error(`unsafe coaching directory: ${dir}`)
    if (create && !existsSync(dir)) mkdirSync(dir,{mode:0o700})
  }
  return sessions
}
function pathFor(root,id,create=false) {
  if (!ID.test(id||'')) throw new Error('session id must be a UUID')
  return join(directory(root,create),`${id}.json`)
}
function load(root,id) {
  const path=pathFor(root,id)
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`coaching session not found: ${id}`)
  const session=JSON.parse(readFileSync(path,'utf8'))
  if (session.schemaVersion!==1 || session.id!==id || !Number.isInteger(session.revision) || !Array.isArray(session.events)) throw new Error(`invalid coaching session: ${id}`)
  return session
}
function save(root,session,newSession=false) {
  const path=pathFor(root,session.id,true)
  if (newSession && existsSync(path)) throw new Error('coaching session id collision')
  const tmp=`${path}.tmp-${process.pid}-${randomUUID()}`
  try { writeFileSync(tmp,JSON.stringify(session,null,2)+'\n',{encoding:'utf8',mode:0o600});renameSync(tmp,path) }
  finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
function event(session,type,data) {
  const at=new Date().toISOString()
  session.events.push({sequence:session.events.length+1,at,type,...data})
  session.updatedAt=at
  session.revision++
}
function nextPrompt(session) {
  const last=[...session.events].reverse().find(e=>e.type!=='material')?.type
  if (last==='question') return 'What matters about this question now? Record your view with coaching note.'
  if (last==='note') return 'What small action would help you learn or move forward? Record it with coaching action.'
  if (last==='action') return 'Choose the proposed action when you commit to it, then record what happened.'
  if (last==='action_chosen') return 'When you have tried the action, record what happened with coaching review.'
  if (last==='review') return 'What did you learn? Add a note or choose another action.'
  return 'Use the material as context, then add a note or action.'
}
function result(session) { return {...session,nextPrompt:nextPrompt(session)} }
function revise(root,id,expectedRevision,change) {
  if (!Number.isInteger(expectedRevision) || expectedRevision<1) throw new Error('updates require --expected-revision from coaching resume')
  const lock=`${pathFor(root,id,true)}.lock`
  let handle
  try { handle=openSync(lock,'wx',0o600) }
  catch (error) { if (error.code==='EEXIST') throw new Error('coaching session is busy; retry after the other write finishes'); throw error }
  try {
    const session=load(root,id)
    if (session.revision!==expectedRevision) throw new Error(`coaching session changed: expected revision ${expectedRevision}, current revision ${session.revision}; run coaching resume`)
    change(session)
    save(root,session)
    return result(session)
  } finally { closeSync(handle);unlinkSync(lock) }
}
export function start(root,question) {
  required(question,'question')
  const now=new Date().toISOString(), session={schemaVersion:1,id:randomUUID(),revision:0,createdAt:now,updatedAt:now,question:question.trim(),events:[]}
  event(session,'question',{text:session.question,provenance:'user_input'})
  save(root,session,true)
  return result(session)
}
export function note(root,id,revision,kind,text) {
  if (!KINDS.has(kind)) throw new Error('note --kind must be user_report, hypothesis, or intention')
  required(text,'note')
  return revise(root,id,revision,s=>event(s,'note',{kind,text:text.trim(),provenance:'user_input'}))
}
export function action(root,id,revision,text) {
  required(text,'action')
  return revise(root,id,revision,s=>event(s,'action',{text:text.trim(),status:'proposed',provenance:'user_input'}))
}
export function choose(root,id,revision,actionSequence) {
  if (!Number.isInteger(actionSequence) || actionSequence<1) throw new Error('choose requires --action-sequence from coaching resume')
  return revise(root,id,revision,s=>{
    const action=s.events.find(e=>e.sequence===actionSequence && e.type==='action')
    if (!action) throw new Error('action sequence not found')
    if (s.events.some(e=>e.type==='action_chosen' && e.actionSequence===actionSequence)) throw new Error('action already chosen')
    event(s,'action_chosen',{actionSequence,provenance:'user_attestation'})
  })
}
export function review(root,id,revision,outcome,text) {
  if (!OUTCOMES.has(outcome)) throw new Error('review --outcome must be done, partial, or not_done')
  required(text,'review')
  return revise(root,id,revision,s=>{
    const chosen=[...s.events].reverse().find(e=>e.type==='action_chosen' && !s.events.some(r=>r.type==='review'&&r.actionSequence===e.actionSequence))
    if (!chosen) throw new Error('choose an action before reviewing it')
    event(s,'review',{actionSequence:chosen.actionSequence,outcome,text:text.trim(),provenance:'user_report',verification:'unverified'})
  })
}
export function material(root,id,revision,{text,status,sourceLabel,producer,limitations}) {
  if (!MATERIAL_STATES.has(status)) throw new Error('material --material-status must be imported, partial, or failed')
  required(sourceLabel,'source label',500)
  required(producer,'producer',500)
  if (status!=='failed') required(text,'already-extracted material')
  if (status!=='imported') required(limitations,'material limitations',2000)
  if (text && Buffer.byteLength(text,'utf8')>MAX_TEXT) throw new Error('material text exceeds 64 KiB')
  return revise(root,id,revision,s=>event(s,'material',{
    status,sourceLabel:sourceLabel.trim(),producer:producer.trim(),
    text:status==='failed'?null:text,limitations:limitations?.trim()||null,
    provenance:'external_extraction',usable:status!=='failed'
  }))
}
export function resume(root,id) {
  if (id) return result(load(root,id))
  const dir=directory(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir,{withFileTypes:true})
    .filter(entry=>entry.isFile() && ID.test(entry.name.slice(0,-5)) && entry.name.endsWith('.json'))
    .map(entry=>load(root,entry.name.slice(0,-5)))
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
    .map(s=>({id:s.id,question:s.question,revision:s.revision,updatedAt:s.updatedAt,lastEvent:s.events.at(-1)?.type,nextPrompt:nextPrompt(s)}))
}
