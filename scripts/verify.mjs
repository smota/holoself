import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root=resolve(new URL('..',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')),node=process.execPath
const checks=[
  ['tests',['--test',...readdirSync(join(root,'tests')).filter(name=>name.endsWith('.test.mjs')).map(name=>join('tests',name))]],
  ['package audit',['scripts/package-audit.mjs']],
  ['help',['bin/holoself.mjs','--help']],
  ['capabilities',['bin/holoself.mjs','capabilities','--json']]
]
for(const [name,args] of checks){const result=spawnSync(node,args,{cwd:root,encoding:'utf8',shell:false,windowsHide:true,stdio:'pipe'});if(result.status!==0){process.stderr.write(result.stderr||result.stdout||`${name} failed\n`);process.exit(result.status||1)}process.stdout.write(`[ok] ${name}\n`)}
