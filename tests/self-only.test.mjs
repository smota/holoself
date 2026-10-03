import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { buildCatalogSource, validateCatalogSchema, holoselfMcpSearch, holoselfMcpContext } from '../src/ecosystem.mjs'
import { loadLensRegistry } from '../src/lenses.mjs'
async function capture(fn){const old=console.log;let out='';console.log=(...args)=>{out+=args.join(' ')+'\n'};try{await fn();return out}finally{console.log=old}}
test('context and index exclude domain files for missing, empty and legacy include policies and stale catalogs',async()=>{
 const base=await mkdtemp(join(tmpdir(),'holoself-self-only-')),self=join(base,'self'),project=join(base,'domain');await mkdir(project)
 try{
  await capture(()=>run(['init','--root',self]));await writeFile(join(project,'domain.md'),'# Domain\n\nDOMAIN_SENTINEL_987\n')
  await capture(()=>run(['link','add','--project',project,'--self',self,'--lens','general','--yes','--no-activate']))
  const linkPath=join(project,'.holoself','link.yaml'),original=await readFile(linkPath,'utf8');assert.match(original,/include: \[\]/)
  for(const policy of [original.replace(/project_context:[\s\S]*$/,''),original,original.replace('include: []','include: ["**/*.md"]')]){
   await writeFile(linkPath,policy)
   const rebuilt=JSON.parse(await capture(()=>run(['index','rebuild','--project',project])));assert.equal(rebuilt.build_assertions.included_project_files,0)
   const catPath=join(project,'.holoself','catalog','catalog.json'),cat=JSON.parse(await readFile(catPath,'utf8'));assert.deepEqual(cat.sources,[])
   cat.sources=[buildCatalogSource(join(project,'domain.md'),'project',project,loadLensRegistry(self),true).record];assert.equal(validateCatalogSchema(cat).valid,true);await writeFile(catPath,JSON.stringify(cat))
   const context=JSON.parse(await capture(()=>run(['context','--project',project,'--json'])));assert.deepEqual(context.project.documents,[]);assert.ok(context.sources.every(source=>source.kind!=='project'));assert.ok(!JSON.stringify(context).includes('DOMAIN_SENTINEL_987'))
   assert.deepEqual(JSON.parse(await readFile(catPath,'utf8')).sources,[])
   assert.deepEqual(JSON.parse(await capture(()=>run(['search','DOMAIN_SENTINEL_987','--project',project]))).results,[])
   assert.deepEqual(holoselfMcpSearch(project,{query:'DOMAIN_SENTINEL_987'}).results,[])
   assert.doesNotMatch(JSON.stringify(holoselfMcpContext(project,{})),/DOMAIN_SENTINEL_987/)
  }
 }finally{await rm(base,{recursive:true,force:true})}
})
