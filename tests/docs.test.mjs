import test from 'node:test'
import assert from 'node:assert/strict'
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

test('documentation relative links resolve',async()=>{
  const files=[join(root,'README.md'),join(root,'PRIVACY.md'),...await markdownFiles(join(root,'docs'))]
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

test('public docs use supported checkout install and current ecosystem terms',async()=>{
  const files=[join(root,'README.md'),...await markdownFiles(join(root,'docs'))]
  const text=(await Promise.all(files.map(file=>readFile(file,'utf8')))).join('\n')
  assert.doesNotMatch(text,/npm install -g holoself-ai/)
  assert.doesNotMatch(text,/no secrets in index/i)
  assert.match(text,/link add --project/)
  assert.match(text,/proposal review/i)
  assert.match(text,/Markdown remains source of truth/)
  const readme=await readFile(join(root,'README.md'),'utf8')
  assert.match(readme,/init --data-dir C:\/private\/my-self\ndoctor --data-dir C:\/private\/my-self|init --data-dir C:\/private\/my-self[\s\S]*doctor --data-dir C:\/private\/my-self[\s\S]*validate --data-dir C:\/private\/my-self/)
})

test('skill documents validated resolution for every supported project mode',async()=>{
  const skill=await readFile(join(root,'skills','holoself','SKILL.md'),'utf8')
  for(const phrase of ['Direct data root','Metadata project link','Exported project packet or snapshot','Legacy live mount','Environment root','Default root','Secret-pattern filtering is defense in depth, not guarantee'])assert.match(skill,new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
  assert.match(skill,/unique known `secondary_lenses`/)
  assert.match(skill,/reject paths escaping packet directory/i)
  const schema=JSON.parse(await readFile(join(root,'schemas','link.schema.json'),'utf8'))
  assert.equal(schema.properties.self_context.properties.secondary_lenses.uniqueItems,true)
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
