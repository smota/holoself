import { parseArguments } from '../src/cli.mjs'
import { buildExpectedReferenceFiles, replaceGeneratedBlock } from '../scripts/generate-reference.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root=resolve(new URL('..',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))

async function markdownFiles(dir){
  const out=[]
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name)
    if(entry.isDirectory())out.push(...await markdownFiles(path))
    else if(entry.isFile()&&entry.name.endsWith('.md'))out.push(path)
  }
  return out
}

async function documentationFiles(){
  return [
    join(root,'README.md'),
    join(root,'CONTRIBUTING.md'),
    join(root,'PRIVACY.md'),
    join(root,'CHANGELOG.md'),
    ...await markdownFiles(join(root,'docs'))
  ]
}

test('documentation relative links resolve',async()=>{
  const files=await documentationFiles()
  const missing=[]
  for(const file of files){
    const text=await readFile(file,'utf8')
    for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
      const href=match[1].split('#')[0]
      if(!href||/^(?:https?:|mailto:)/.test(href))continue
      try{await access(resolve(dirname(file),decodeURIComponent(href)))}catch{missing.push(`${file.slice(root.length+1)} -> ${href}`)}
    }
  }
  assert.deepEqual(missing,[])
})

test('every documentation page is reachable from a public entry point',async()=>{
  const files=await documentationFiles(),known=new Set(files),edges=new Map(files.map(file=>[file,[]]))
  for(const file of files){
    const text=await readFile(file,'utf8')
    for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
      const href=match[1].split('#')[0]
      if(!href||/^(?:https?:|mailto:)/.test(href))continue
      const target=resolve(dirname(file),decodeURIComponent(href))
      if(known.has(target))edges.get(file).push(target)
    }
  }
  const entries=['README.md','CONTRIBUTING.md','PRIVACY.md','CHANGELOG.md'].map(file=>join(root,file)),queue=[...entries],visited=new Set()
  while(queue.length){const file=queue.shift();if(visited.has(file))continue;visited.add(file);queue.push(...edges.get(file).filter(target=>!visited.has(target)))}
  assert.deepEqual(files.filter(file=>!visited.has(file)).map(file=>file.slice(root.length+1)),[])
})

test('public docs use supported npm install and current ecosystem terms',async()=>{
  const files=[join(root,'README.md'),...await markdownFiles(join(root,'docs'))]
  const text=(await Promise.all(files.map(file=>readFile(file,'utf8')))).join('\n')
  assert.match(text,/npm install --global holoself-ai/)
  assert.doesNotMatch(text,/npm (?:registry )?package (?:is |remains )?(?:not |un)published|not published yet|registry installation is not currently available/i)
  assert.doesNotMatch(text,/no secrets in index/i)
  assert.match(text,/link add --project/)
  assert.match(text,/proposal review/i)
  assert.match(text,/Markdown remains source of truth/)
  const readme=await readFile(join(root,'README.md'),'utf8')
  assert.match(readme,/init --data-dir C:\/private\/my-self\ndoctor --data-dir C:\/private\/my-self|init --data-dir C:\/private\/my-self[\s\S]*doctor --data-dir C:\/private\/my-self[\s\S]*validate --data-dir C:\/private\/my-self/)
})

test('documentation command notation and implementation versions stay current',async()=>{
  const files=await documentationFiles(),text=(await Promise.all(files.map(file=>readFile(file,'utf8')))).join('\n')
  const [map,cli,indexing,ecosystem]=await Promise.all([
    readFile(join(root,'docs','README.md'),'utf8'),
    readFile(join(root,'docs','reference','cli.md'),'utf8'),
    readFile(join(root,'docs','guides','indexing-and-search.md'),'utf8'),
    readFile(join(root,'docs','linked-ecosystem.md'),'utf8')
  ])
  assert.match(map,/## Command notation/)
  assert.match(cli,/Both command forms execute `bin\/holoself\.mjs`/)
  assert.match(cli,/knowledge cleanup/)
  assert.match(cli,/instructions render\|audit/)
  assert.doesNotMatch(text,/HOLOSELF_DATA/)
  assert.doesNotMatch(text,/mcp configure --apply/)
  assert.doesNotMatch(text,/^holoself mcp (?:configure|status)(?![^\n]*--project)/m)
  assert.match(indexing,/schema v5\/privacy-policy v4/)
  assert.match(ecosystem,/schema v5\/privacy-policy v4/)
})

test('documentation provides audience paths, common workflows, and a Workbench first run',async()=>{
  const [map,useCases,workbench,architecture]=await Promise.all([
    readFile(join(root,'docs','README.md'),'utf8'),
    readFile(join(root,'docs','guides','common-use-cases.md'),'utf8'),
    readFile(join(root,'docs','web-gui.md'),'utf8'),
    readFile(join(root,'docs','architecture.md'),'utf8')
  ])
  for(const audience of ['Regular user','Advanced user','Data architect'])assert.match(map,new RegExp(audience))
  for(const workflow of ['Give an AI project relevant context','Use Holoself visually','Reuse a project discovery','Find prior knowledge','Connect a supported AI client','Share a reviewed snapshot','Diagnose a degraded linked project'])assert.match(useCases,new RegExp(workflow))
  assert.match(workbench,/## First run/)
  for(const area of ['Overview','Spaces','Lenses','Knowledge','Review','Conversations','Setup'])assert.match(workbench,new RegExp(`\\| ${area} \\|`))
  assert.match(architecture,/## Architecture at a glance/)
  for(const boundary of ['Authoritative location','Read authorization','Generated retrieval','Durable discovery'])assert.match(architecture,new RegExp(boundary))
})

test('skill documents validated resolution for every supported project mode',async()=>{
  const skill=await readFile(join(root,'skills','holoself','SKILL.md'),'utf8')
  for(const phrase of ['Direct data root','Metadata project link','Exported project packet or snapshot','Legacy live mount','Environment root','Default root','Secret-pattern filtering is defense in depth, not guarantee'])assert.match(skill,new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
  assert.match(skill,/unique known `secondary_lenses`/)
  assert.match(skill,/reject paths escaping packet directory/i)
  const schema=JSON.parse(await readFile(join(root,'schemas','lens-bindings.schema.json'),'utf8'))
  assert.equal(schema.properties.bindings.additionalProperties.properties.secondary_lenses.uniqueItems,true)
})

test('agent instructions consolidate resolution in the public skill and bounded command',async()=>{
  const [skill,template]=await Promise.all([
    readFile(join(root,'skills','holoself','SKILL.md'),'utf8'),
    readFile(join(root,'templates','AGENTS.md'),'utf8')
  ])
  assert.match(skill,/Do not open linked canonical `profile\/` or `context\/` files directly/)
  assert.match(skill,/context --project \. --task/)
  assert.match(skill,/Do not bulk-load/)
  assert.match(template,/public Holoself skill is the normative resolver contract/)
  assert.match(template,/--budget standard/)
  assert.doesNotMatch(template,/Loading order:/)
})

test('documented invocations parse under strict flag validation',async()=>{
  const files=[...await documentationFiles(),...await markdownFiles(join(root,'skills'))],failures=[]
  let count=0
  for(const file of files){
    const text=(await readFile(file,'utf8')).replace(/\\\r?\n\s*/g,' ')
    const examples=[...text.matchAll(/`(holoself [^`\n]+)`/g),...text.matchAll(/^\s*(?:\$\w+\s*=\s*)?(holoself [^\n]+)$/gm)]
    for(const match of examples){
      if(/^holoself (?:<command>|\.\.\.$)/.test(match[1]))continue
      // Synopsis alternatives are expanded separately from concrete commands.
      const command=match[1].split(/\s+\|\s+/)[0].replace(/<[^>]+>/g,'example').replace(/\[([^\]]+)\]/g,'$1').replace(/\s+#.*$/,'').trim()
      const tokens=command.match(/"[^"]*"|'[^']*'|[^\s]+/g).map(x=>x.replace(/^["']|["']$/g,''))
      // Slash-separated switch synopses are prose, not executable invocations.
      if(tokens.some(x=>x==='/'||x==='|'||x==='\u2026'))continue
      let variants=[[]]
      for(const token of tokens)variants=variants.flatMap(prefix=>token.split('|').map(value=>[...prefix,value==='...'?'example':value]))
      for(const variant of variants){try{parseArguments(variant.slice(1));count++}catch(error){failures.push(`${file.slice(root.length+1)}: ${match[1]}: ${error.message}`)}}
    }
  }
  assert.ok(count>50,'documentation sweep must exercise real invocations')
  assert.deepEqual(failures,[])
})

test('strict command changes are documented',async()=>{
  const text=await readFile(join(root,'CHANGELOG.md'),'utf8')
  for(const word of ['OPTION_NOT_SUPPORTED','coaching','knowledge','instructions','proposals','index','search','mcp','lens','skill','link'])assert.ok(text.includes(word),word)
})

test('tracked documentation contains no user-home or machine-specific paths',async()=>{
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','docs/','README.md','AGENTS.md','CONTRIBUTING.md'],{cwd:root,encoding:'utf8'})
    .split(/\r?\n/)
    .filter(rel=>rel&&!/\.png$/i.test(rel)&&existsSync(join(root,rel)))
  const allowedPlaceholder=/^(?:<user>|<name>|<you>|user|name|you|example|runner)$/i
  const patterns=[
    /[A-Za-z]:[/\\]Users[/\\]([^/\\\s`'")\]]+)/g,
    /\/(?:home|Users)\/([^/\s`'")\]]+)\//g,
    /([A-Za-z]:[/\\]Cowork[/\\][^\s`'")>\]]*)/gi
  ]
  const hits=[]
  for(const rel of files){
    const text=await readFile(join(root,rel),'utf8')
    for(const pattern of patterns){
      for(const match of text.matchAll(pattern)){
        if(!allowedPlaceholder.test(match[1]))hits.push(`${rel}: ${match[0]}`)
      }
    }
  }
  assert.deepEqual(hits,[])
})

test('generated CLI and MCP reference sections match live output without drift',()=>{
  const {capabilities,tools,cliCurrent,mcpCurrent,cliExpected,mcpExpected}=buildExpectedReferenceFiles()
  assert.equal(tools.length,7,'expected 7 MCP tools from live tools/list')
  assert.deepEqual(tools.map(t=>t.name),capabilities.mcp.tools)
  assert.equal(
    cliCurrent,
    cliExpected,
    'docs/reference/cli.md generated section drifted from live capabilities/flag contract; run `npm run docs:reference`'
  )
  assert.equal(
    mcpCurrent,
    mcpExpected,
    'docs/reference/mcp-tools.md generated section drifted from live MCP tools/list; run `npm run docs:reference`'
  )
  const drifted=replaceGeneratedBlock(mcpCurrent,'<!-- generated:start -->\nstale\n<!-- generated:end -->','docs/reference/mcp-tools.md')
  assert.notEqual(drifted,mcpExpected,'drift check must detect stale generated content')
})

test('current version strings, superseded evidence ADRs, lens vocabulary, and branch prefixes match source of truth',async()=>{
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
  const workflowConfig=JSON.parse(await readFile(join(root,'agent-workflow.config.json'),'utf8'))
  const files=await documentationFiles()
  let versionChecks=0
  for(const file of files){
    const text=await readFile(file,'utf8')
    for(const match of text.matchAll(/Current version:\s*([0-9]+\.[0-9]+\.[0-9]+)/gi)){
      assert.equal(match[1],pkg.version,`${file.slice(root.length+1)} claims current version ${match[1]} instead of package.json ${pkg.version}`)
      versionChecks++
    }
  }
  assert.ok(versionChecks>=1,'expected at least one Current version assertion')

  const [statusRoadmap,runtimeAdapters,platformVerification,mcpDecision,ownership,docsMap,agentsMd,contributingMd,workbenchLenses,lensesPrivacy]=await Promise.all([
    readFile(join(root,'docs','contributing','status-and-roadmap.md'),'utf8'),
    readFile(join(root,'docs','guides','runtime-adapters.md'),'utf8'),
    readFile(join(root,'docs','reference','platform-verification.md'),'utf8'),
    readFile(join(root,'docs','decisions','local-mcp-architecture.md'),'utf8'),
    readFile(join(root,'docs','concepts','ownership.md'),'utf8'),
    readFile(join(root,'docs','README.md'),'utf8'),
    readFile(join(root,'AGENTS.md'),'utf8'),
    readFile(join(root,'CONTRIBUTING.md'),'utf8'),
    readFile(join(root,'docs','workbench','lenses.md'),'utf8'),
    readFile(join(root,'docs','concepts','lenses-and-privacy.md'),'utf8')
  ])

  assert.match(statusRoadmap,/seven bounded tools/)
  assert.match(runtimeAdapters,/seven typed tools/)
  assert.match(platformVerification,/seven-tool discovery/)
  assert.match(mcpDecision,/holoself_proposal_preview/)

  for(const adr of ['evidence-01-ownership.md','evidence-02-identity-fidelity.md','evidence-03-authorization.md','evidence-04-extraction.md','evidence-05-proposals.md','evidence-06-coaching.md']){
    const text=await readFile(join(root,'docs','decisions',adr),'utf8')
    assert.match(text,/Superseded by docs\/specifications\/external-sources-and-coaching-plan\.md \(2026-09-30\)/,adr)
  }

  assert.doesNotMatch(ownership,/\b(?:career|publishing)\b/i)
  assert.match(docsMap,/Synthetic professional and public-voice example/)
  // Both pages must describe public-voice the same way: sensitivity_access gating, no extra publication filter.
  for(const page of [workbenchLenses,lensesPrivacy]){
    assert.match(page,/sensitivity_access/)
    assert.match(page,/`public-voice`[^.]*no extra publication filter/)
  }

  for(const prefix of workflowConfig.branching.workBranchPrefixes){
    assert.ok(agentsMd.includes(prefix),`AGENTS.md missing branch prefix ${prefix}`)
    assert.ok(contributingMd.includes(prefix),`CONTRIBUTING.md missing branch prefix ${prefix}`)
  }
  assert.doesNotMatch(agentsMd,/`feat\/<|`docs\/</)
  assert.doesNotMatch(contributingMd,/`feat\/|`docs\//)
})
