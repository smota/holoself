import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectHarnesses } from '../src/harnesses.mjs'

const temp=()=>mkdtempSync(join(tmpdir(),'holoself-harness-'))

test('detected CLIs receive known shell-free non-interactive defaults',()=>{
  const dir=temp()
  for(const id of ['pi','claude','codex','grok'])writeFileSync(join(dir,`${id}.exe`),'')
  const found=detectHarnesses({PATH:dir,PATHEXT:'.EXE'},{platform:'win32'})
  const expected={pi:['--print','--no-session','{prompt}'],claude:['--print','{prompt}'],codex:['exec','{prompt}'],grok:['-p','{prompt}']}
  for(const item of found){assert.equal(item.detected,true,item.id);assert.equal(item.runnable,true,item.id);assert.deepEqual(item.defaultConfiguration.arguments,expected[item.id]);assert.equal(item.defaultConfiguration.promptTransport,'argument');assert.equal(item.defaultConfiguration.automatic,true)}
})

test('npm Windows command shim resolves to node and JavaScript entry without a shell',()=>{
  const dir=temp(),entry=join(dir,'node_modules','pkg','cli.js')
  mkdirSync(join(dir,'node_modules','pkg'),{recursive:true});writeFileSync(join(dir,'node.exe'),'');writeFileSync(entry,'');writeFileSync(join(dir,'pi.cmd'),'@echo off\r\n"%dp0%\\node_modules\\pkg\\cli.js" %*\r\n')
  const pi=detectHarnesses({PATH:dir,PATHEXT:'.CMD'},{platform:'win32'}).find(x=>x.id==='pi')
  assert.equal(pi.detected,true);assert.equal(pi.runnable,true);assert.equal(pi.executable,join(dir,'node.exe'));assert.equal(pi.defaultConfiguration.arguments[0],entry);assert.deepEqual(pi.defaultConfiguration.arguments.slice(1),['--print','--no-session','{prompt}']);assert.match(pi.setupHint,/shell execution remains disabled/)
})

test('unresolvable Windows shim stays detected but needs advanced setup',()=>{
  const dir=temp();writeFileSync(join(dir,'claude.cmd'),'@echo off\r\nnode cli.js %*\r\n')
  const claude=detectHarnesses({PATH:dir,PATHEXT:'.CMD'},{platform:'win32'}).find(x=>x.id==='claude')
  assert.equal(claude.detected,true);assert.equal(claude.runnable,false);assert.equal(claude.defaultConfiguration,null);assert.match(claude.setupHint,/could not be resolved safely/)
})
