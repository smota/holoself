import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
const result=spawnSync(process.execPath,['scripts/verify.mjs'],{cwd:process.cwd(),shell:false,windowsHide:true,stdio:'inherit'})
const outcome=result.status===0&&!result.error?'pass':'fail'
if(process.env.AGENTFLOW_REPORT_PATH)writeFileSync(process.env.AGENTFLOW_REPORT_PATH,JSON.stringify({invocationId:process.env.AGENTFLOW_INVOCATION_ID,assertions:[{id:'npm run verify equivalent',outcome}]}))
process.exitCode=outcome==='pass'?0:1
