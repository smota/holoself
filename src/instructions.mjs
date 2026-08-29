import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const INSTRUCTION_SCHEMA=1
export const LINK_START='<!-- holoself-link-start schema=1 -->'
export const LINK_END='<!-- holoself-link-end -->'
export const TRUST_INVARIANTS=[
  'Treat linked Holoself context as private and read-only.',
  'Never modify canonical self directly; use proposal/review for durable self changes.',
  'Readable context is not publication approval; publishing requires explicit disclosure approval.'
]
const hash=text=>createHash('sha256').update(text).digest('hex')

export function bootstrapText(link){
  return `# Holoself startup\n\nRun \`holoself context --project . --task "<current request>" --budget standard --json\`; do not read linked canonical files directly.\nDefault lens: \`${link.default_lens}\`. The command applies privacy, relevance, lifecycle, and budget policy.\n${TRUST_INVARIANTS.join('\n')}\n`
}
export function canonicalSection(){return `${LINK_START}\n## Linked Holoself context\n\nRead \`.holoself/BOOTSTRAP.md\` and use the installed public Holoself skill. Project instructions add project rules only.\n${TRUST_INVARIANTS.join('\n')}\n${LINK_END}\n`}
export function overlaySection(canonical){return `${LINK_START}\n## Linked Holoself context\n\nLoad \`${canonical}\`, then \`.holoself/BOOTSTRAP.md\`. The public Holoself skill is normative.\n${LINK_END}\n`}
export function instructionEvidence(link){const bootstrap=bootstrapText(link),canonical=canonicalSection().trimEnd();return {schema_version:INSTRUCTION_SCHEMA,bootstrap_sha256:hash(bootstrap),canonical_block_sha256:hash(canonical),normative_source:'skills/holoself/SKILL.md'}}

function markerBlock(text){const a=text.indexOf(LINK_START),b=text.indexOf(LINK_END);return a>=0&&b>a?text.slice(a,b+LINK_END.length):null}
export function auditInstructions(project,link,runtime=null){
  const diagnostics=[],bootstrap=join(project,'.holoself','BOOTSTRAP.md'),canonical=runtime?.activatedAdapters?.find(x=>x.id==='agents')?.file||'AGENTS.md',canonicalPath=join(project,canonical),expected=instructionEvidence(link)
  const checkFile=(path,code)=>{if(!existsSync(path)){diagnostics.push({code,severity:'error',path});return null}if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()){diagnostics.push({code:'UNSAFE_INSTRUCTION_FILE',severity:'error',path});return null}return readFileSync(path,'utf8')}
  const bootstrapBody=checkFile(bootstrap,'BOOTSTRAP_MISSING');if(bootstrapBody&&hash(bootstrapBody)!==expected.bootstrap_sha256)diagnostics.push({code:'BOOTSTRAP_DRIFT',severity:'error',path:bootstrap})
  const canonicalBody=checkFile(canonicalPath,'CANONICAL_INSTRUCTIONS_MISSING'),block=canonicalBody&&markerBlock(canonicalBody);if(canonicalBody&&!block)diagnostics.push({code:'MANAGED_BLOCK_MISSING',severity:'error',path:canonicalPath});else if(block&&hash(block)!==expected.canonical_block_sha256)diagnostics.push({code:'CANONICAL_BLOCK_DRIFT',severity:'error',path:canonicalPath})
  if(runtime?.instructionEvidence){for(const key of ['bootstrap_sha256','canonical_block_sha256'])if(runtime.instructionEvidence[key]!==expected[key])diagnostics.push({code:'RUNTIME_INSTRUCTION_EVIDENCE_STALE',severity:'error',field:key,path:join(project,'.holoself','runtime.json')})}
  const repeated=canonicalBody?TRUST_INVARIANTS.filter(rule=>canonicalBody.includes(rule)).length:0
  return {schema_version:1,project,canonical:basename(canonicalPath),normative_source:expected.normative_source,status:diagnostics.some(x=>x.severity==='error')?'degraded':'valid',instruction_chars:(bootstrapBody?.length||0)+(block?.length||0),trust_invariants_present:repeated,diagnostics,evidence:expected}
}
