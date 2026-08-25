import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectorLaunchPlan, loadConnectors, saveConnectorExtension, validateConnector } from '../src/connectors.mjs'

const temp=()=>mkdtempSync(join(tmpdir(),'holoself-connectors-'))
test('root connector extensions merge with built-ins',()=>{const root=temp(),exe=join(root,'custom.exe');writeFileSync(exe,'');saveConnectorExtension(root,{schema_version:1,kind:'cli',id:'custom-cli',name:'Custom CLI',executable:exe,arguments:['ask','{prompt}'],interactive_arguments:[],capabilities:['conversation']});const connectors=loadConnectors(root,{PATH:'',PATHEXT:'.EXE'});const custom=connectors.find(item=>item.id==='custom-cli');assert.equal(custom.available,true);assert.equal(custom.source,'root-extension');assert.deepEqual(custom.arguments,['ask','{prompt}'])})
test('connector schema rejects unsafe executable and invalid kind',()=>{assert.throws(()=>validateConnector({schema_version:1,kind:'server',id:'bad-one',name:'Bad'}),/invalid connector kind/);assert.throws(()=>validateConnector({schema_version:1,kind:'cli',id:'bad-one',name:'Bad',executable:'relative.exe'}),/existing absolute/)})
test('launch plans keep cwd and arguments structured with no shell string',()=>{const cwd=temp(),terminal={kind:'terminal',id:'windows-terminal',name:'Windows Terminal',available:true,executable:'C:/Windows/wt.exe'},cli={kind:'cli',id:'pi',name:'PI',available:true,executable:'C:/node.exe',interactive_arguments:['C:/pi.js']},gui={kind:'gui',id:'codex-app',name:'Codex',available:true,via_cli:'pi'};const plan=connectorLaunchPlan([terminal,cli,gui],{space:cwd,connectorId:'pi',terminalId:'windows-terminal',mode:'cli'});assert.equal(plan.cwd,cwd);assert.deepEqual(plan.arguments,['-d',cwd,'C:/node.exe','C:/pi.js']);assert.equal(plan.detached,true);const app=connectorLaunchPlan([terminal,cli,gui],{space:cwd,connectorId:'codex-app',mode:'gui'});assert.deepEqual(app.arguments,['C:/pi.js','app'])})
