// D01 source-checkout experiment, deliberately separate from product runtime.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inventory, expected } from '../tests/fixtures/evidence/golden.mjs'
import { docxBytes, pdfBytes } from '../tests/fixtures/evidence/build.mjs'
import { syntheticZip } from '../tests/fixtures/evidence/build-realistic.mjs'

const base = fileURLToPath(new URL('../tests/fixtures/evidence/', import.meta.url))
const dependencyRoot = join(base, 'spike')
const require = createRequire(join(dependencyRoot, 'package.json'))
const execFileAsync = promisify(execFile)
const MiB = 1024 * 1024
export const ceilings = Object.freeze({ input: 50 * MiB, expanded: 200 * MiB, entries: 10000, pages: 200, ms: 60000, heapMiB: 512 })
const names = ['sample.md', 'complex.docx', 'complex-deflate.docx', 'complex-deflate-props.docx', 'complex.pdf']

export function archiveNameError(name) {
  if (!name || name.startsWith('/') || name.startsWith('\\') || name.includes('\\') || name.includes(':') || name.split('/').some(part => part === '..' || part === '.' || part === '')) return 'unsafe-name'
  return null
}
export function compare(expectedUnits, observations) {
  const observed = new Set(observations)
  const found = expectedUnits.map(([id]) => id).filter(id => observed.has(id))
  return { found: found.length, total: expectedUnits.length, missing: expectedUnits.map(([id]) => id).filter(id => !observed.has(id)) }
}
function checkedBytes(name) {
  const path = join(base, name)
  const bytes = readFileSync(path)
  if (bytes.length > ceilings.input) throw Error('input-limit')
  if (name === 'complex.docx' || name === 'complex.pdf') {
    const expectedBytes = name === 'complex.docx' ? docxBytes() : pdfBytes()
    if (!bytes.equals(expectedBytes)) throw Error(`fixture-drift:${name}`)
  } else if (hashes[name] && createHash('sha256').update(bytes).digest('hex') !== hashes[name]) throw Error(`fixture-drift:${name}`)
  return bytes
}
// Committed binary identity is runtime-independent. Rebuilding deflate bytes can differ by zlib version.
const hashes = {
  'sample.md': 'cc883c82936249f05a3147fe4dd24397ba46c46b5fa0f67ddbc07559c2ec747e',
  'complex-deflate.docx': 'ac207002c646be66722c01307580c8ba9d4812392a70b52f78ce9579d525cfe5',
  'complex-deflate-props.docx': '495a2c6eb4d3bbf81e2027f5f7d2c9fae57bcf79cfa36c378bb6b9d1f994f153'
}
function nodeChildren(value, tag) {
  if (!value || typeof value !== 'object') return []
  const result = []
  for (const [key, child] of Object.entries(value)) {
    if (key === tag) result.push(...(Array.isArray(child) ? child : [child]))
    if (typeof child === 'object') for (const nested of Array.isArray(child) ? child : [child]) result.push(...nodeChildren(nested, tag))
  }
  return result
}
function xmlText(node) {
  if (!node || typeof node !== 'object') return ''
  return nodeChildren(node, 't').map(t => typeof t === 'string' ? t : t?.['#text'] ?? '').join('')
}
function attr(node, key) { return node?.[`@_${key}`] }
function xmlPart(parts, path, Parser) { return new Parser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: false }).parse(parts.get(path)?.toString() ?? '') }

export async function scanDocx(bytes, limits = ceilings) {
  const yauzl = require('yauzl')
  if (bytes.length > limits.input) throw Error('input-limit')
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)))
  return new Promise((resolve, reject) => {
    const parts = new Map(), methods = new Set(); let entries = 0, expanded = 0, settled = false
    const fail = error => { if (settled) return; settled = true; zip.close(); reject(error) }
    zip.on('error', fail)
    zip.on('end', () => {
      if (settled) return
      if (parts.get('[Content_Types].xml')?.includes(Buffer.from('macroEnabled'))) return fail(Error('macro-content-type'))
      settled = true; resolve({ parts, entries, expanded, methods: [...methods].sort() })
    })
    zip.on('entry', entry => {
      if (++entries > limits.entries) return fail(Error('entry-limit'))
      methods.add(entry.compressionMethod)
      const unsafe = archiveNameError(entry.fileName)
      if (unsafe) return fail(Error(`${unsafe}:${entry.fileName}`))
      // Symlinks and special files must never be materialized or interpreted as parts.
      const mode = entry.externalFileAttributes >>> 16
      if (mode && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000) return fail(Error('special-entry'))
      if (entry.fileName.endsWith('/')) return zip.readEntry()
      if (parts.has(entry.fileName)) return fail(Error('duplicate-entry'))
      if (/(^|\/)vbaProject\.bin$/i.test(entry.fileName)) return fail(Error('macro-entry'))
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error)
        const chunks = []; let memberBytes = 0
        stream.on('error', fail)
        stream.on('data', chunk => {
          expanded += chunk.length; memberBytes += chunk.length
          if (expanded > limits.expanded) return fail(Error('expanded-limit'))
          chunks.push(chunk)
        })
        stream.on('end', () => { if (settled) return; parts.set(entry.fileName, Buffer.concat(chunks, memberBytes)); zip.readEntry() })
      })
    })
    zip.readEntry()
  })
}
function observeDocx(parts, Parser) {
  const doc = xmlPart(parts, 'word/document.xml', Parser), comments = xmlPart(parts, 'word/comments.xml', Parser)
  const notes = xmlPart(parts, 'word/footnotes.xml', Parser), headers = xmlPart(parts, 'word/header1.xml', Parser)
  const rels = xmlPart(parts, 'word/_rels/document.xml.rels', Parser)
  const paragraphs = nodeChildren(doc, 'p').map(xmlText), rows = nodeChildren(doc, 'tr').map(row => nodeChildren(row, 'tc').map(xmlText))
  const comment = nodeChildren(comments, 'comment').find(x => attr(x, 'id') === '0')
  const footnote = nodeChildren(notes, 'footnote').find(x => attr(x, 'id') === '1')
  const links = nodeChildren(rels, 'Relationship').filter(x => attr(x, 'TargetMode') === 'External').map(x => attr(x, 'Target'))
  const props = parts.has('docProps/core.xml') ? xmlPart(parts, 'docProps/core.xml', Parser) : null
  const coreAuthor = props ? nodeChildren(props, 'creator')[0] : null
  const model = {
    paragraphs, rows, commentText: xmlText(comment), commentAuthor: attr(comment, 'author'), footnoteText: xmlText(footnote),
    anchorStart: nodeChildren(doc, 'commentRangeStart').length, anchorEnd: nodeChildren(doc, 'commentRangeEnd').length,
    anchorReference: nodeChildren(doc, 'commentReference').length, footnoteReference: nodeChildren(doc, 'footnoteReference').length,
    drawing: nodeChildren(doc, 'drawing').length, image: parts.has('word/media/pixel.png'),
    links, header: xmlText(headers), coreAuthor: typeof coreAuthor === 'string' ? coreAuthor : coreAuthor?.['#text'] ?? null,
    tableColumns: nodeChildren(doc, 'gridCol').length
  }
  return { model, score: scoreDocx(model) }
}
function scoreDocx(m) {
  const body = m.paragraphs, cell = (row, col, text) => m.rows[row]?.[col] === text
  const ids = []
  if (body.includes('Synthetic workshop')) ids.push('title')
  if (body.includes('Question: What improved the handoff?')) ids.push('question')
  if (body.includes('Participant A: We tried a checklist. Its effect is unmeasured.')) ids.push('answer')
  for (const [id, row, col, value] of [['table-h1',0,0,'Measure'],['table-h2',0,1,'Before'],['table-h3',0,2,'After'],['table-r1-c1',1,0,'Reported delays'],['table-r1-c2',1,1,'4'],['table-r1-c3',1,2,'3']]) if (cell(row,col,value)) ids.push(id)
  if (body.includes('Counts are self-reported.') && m.anchorStart && m.anchorEnd && m.anchorReference) ids.push('comment-anchor')
  if (m.commentText.includes('Do not infer causality.')) ids.push('comment')
  if (m.footnoteText.includes('Fictional sample of two observations.') && m.footnoteReference) ids.push('footnote')
  if (m.drawing && m.image) ids.push('figure')
  if (body.some(x => x.startsWith('Figure 1: synthetic pixel'))) ids.push('caption')
  if (m.links.includes('https://example.invalid/no-fetch')) ids.push('link')
  if (m.header.includes('SYNTHETIC - NOT PERSONAL DATA')) ids.push('header')
  const relations = { answer_question: ids.includes('answer') && ids.includes('question'), table_headers: [0,1,2].every(i => cell(0,i,['Measure','Before','After'][i]) && cell(1,i,['Reported delays','4','3'][i])), comment_anchor: ids.includes('comment-anchor') && ids.includes('comment'), footnote_anchor: ids.includes('comment-anchor') && ids.includes('footnote'), caption_figure: ids.includes('caption') && ids.includes('figure') }
  return { units: compare(inventory.docx, ids), relationSignals: relations, relationBasis: { answer_question:'adjacent text heuristic', table_headers:'OOXML row/cell structure by column', comment_anchor:'OOXML range markers present; exact span alignment unproven', footnote_anchor:'OOXML reference and note present; ID equality not checked here', caption_figure:'paragraph and drawing co-present; caption link heuristic' }, attributionSignals: { speaker: ids.includes('answer'), comment_author: m.commentAuthor === 'Synthetic reviewer' }, attributionBasis: { speaker:'explicit text prefix', comment_author:'OOXML comment author attribute' } }
}
function mammothObservation(html) {
  // HTML is a presentation candidate. No claim that it preserves OOXML anchors.
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const has = x => text.includes(x)
  const ids = []
  for (const [id, fragment] of inventory.docx) {
    if (id === 'figure' && /<img\b/.test(html)) ids.push(id)
    else if (id === 'link' && html.includes(fragment)) ids.push(id)
    else if (id === 'comment-anchor' && has(fragment)) ids.push(id)
    else if (id === 'table-r1-c2' && /<td><p>4<\/p><\/td>/.test(html)) ids.push(id)
    else if (id === 'table-r1-c3' && /<td><p>3<\/p><\/td>/.test(html)) ids.push(id)
    else if (!['comment','header','table-r1-c2','table-r1-c3'].includes(id) && has(fragment)) ids.push(id)
  }
  const comment = has('Do not infer causality.'), header = has('SYNTHETIC - NOT PERSONAL DATA')
  if (comment) ids.push('comment'); if (header) ids.push('header')
  return { units: compare(inventory.docx, ids), relationSignals: { answer_question: ids.includes('answer') && ids.includes('question'), table_headers: /<table>/.test(html) && /<tr>/.test(html), comment_anchor: false, footnote_anchor: /href="#footnote-1"/.test(html), caption_figure: /<img\b[\s\S]*?<\/p><p>Figure 1:/.test(html) }, relationBasis: 'rendered HTML adjacency/table markup; no original OOXML review anchor retained', attributionSignals: { speaker: ids.includes('answer'), comment_author: false }, htmlBytes: Buffer.byteLength(html) }
}
async function docxRun(name, bytes) {
  const { XMLParser } = require('fast-xml-parser'), mammoth = require('mammoth')
  const scanStart = performance.now(), archive = await scanDocx(bytes), scanMs = performance.now() - scanStart
  const structured = observeDocx(archive.parts, XMLParser)
  const mammothStart = performance.now(), converted = await mammoth.convertToHtml({ buffer: bytes }, { convertImage: mammoth.images.inline(() => {}) })
  const mammothMs = performance.now() - mammothStart
  return { format: 'docx', name, zip: { entries: archive.entries, expandedBytes: archive.expanded, compressionMethods: archive.methods }, structured: { ...structured.score, model: { tableRows: structured.model.rows, tableColumns: structured.model.tableColumns, image: structured.model.image, commentAuthor: structured.model.commentAuthor, coreAuthor: structured.model.coreAuthor } }, mammoth: { ...mammothObservation(converted.value), messages: converted.messages.map(x => x.message) }, milliseconds: { scan: +scanMs.toFixed(1), mammoth: +mammothMs.toFixed(1) } }
}
async function markdownRun(name, bytes) {
  const MarkdownIt = require('markdown-it')
  const start = performance.now(), tokens = new MarkdownIt({ html: false, linkify: false }).parse(bytes.toString('utf8'), {})
  const inline = tokens.filter(x => x.type === 'inline')
  const text = inline.map(x => x.content)
  const ids = []
  for (const [id, fragment] of inventory.markdown) {
    if (id === 'link') { if (inline.some(x => x.children?.some(y => y.type === 'link_open' && y.attrGet('href') === fragment))) ids.push(id) }
    else if (id === 'table-header') { if (tokens.some(x => x.type === 'table_open') && text.includes('Measure') && text.includes('Before') && text.includes('After')) ids.push(id) }
    else if (id === 'table-row') { if (text.includes('Reported delays') && text.includes('4') && text.includes('3')) ids.push(id) }
    else if (id === 'question-heading') { if (text.includes('Question')) ids.push(id) }
    else if (id === 'answer-heading') { if (text.includes('Answer — Participant A')) ids.push(id) }
    else if (id === 'note') { if (text.some(x => x.includes(fragment)) && tokens.some(x => x.type === 'blockquote_open')) ids.push(id) }
    else if (text.some(x => x.includes(fragment))) ids.push(id)
  }
  return { format: 'markdown', name, candidate: 'markdown-it', units: compare(inventory.markdown, ids), relationSignals: { answer_question: ids.includes('answer') && ids.includes('question'), table_headers: ids.includes('table-header') && ids.includes('table-row') }, relationBasis: 'Markdown token presence; heading association is adapter heuristic', attributionSignal: { speaker: ids.includes('answer-heading') && ids.includes('answer') }, tokenCount: tokens.length, milliseconds: +(performance.now()-start).toFixed(1) }
}
async function pdfRun(name, bytes, only) {
  const packageName = only === 'pdfjs4' ? 'pdfjs-dist' : 'pdfjs5'
  const pdf = await import(pathToFileURL(join(dependencyRoot, 'node_modules', packageName, 'legacy', 'build', 'pdf.mjs')).href)
  const candidates = []
  for (const [label, lib] of [[only, pdf]]) {
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(join(dependencyRoot, 'node_modules', packageName, 'legacy', 'build', 'pdf.worker.mjs')).href
    const start = performance.now(), task = lib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true })
    const document = await task.promise
    if (document.numPages > ceilings.pages) { await document.destroy(); throw Error('page-limit') }
    const pages = []
    for (let p = 1; p <= document.numPages; p++) {
      const page = await document.getPage(p), text = await page.getTextContent(), ops = await page.getOperatorList()
      pages.push({ number: p, items: text.items.map(x => ({ text: x.str, x: +x.transform[4].toFixed(1), y: +x.transform[5].toFixed(1) })), imageOps: ops.fnArray.filter(x => [lib.OPS.paintImageXObject,lib.OPS.paintInlineImageXObject,lib.OPS.paintImageMaskXObject].includes(x)).length, pathOps: ops.fnArray.filter(x => x === lib.OPS.constructPath).length })
      page.cleanup()
    }
    await document.destroy()
    candidates.push({ candidate: label, version: lib.version, ...scorePdf(pages), pages: pages.map(x => ({ number: x.number, textItems: x.items.length, imageOps: x.imageOps, pathOps: x.pathOps, minX: x.items.length ? Math.min(...x.items.map(i => i.x)) : null, maxX: x.items.length ? Math.max(...x.items.map(i => i.x)) : null })), milliseconds: +(performance.now() - start).toFixed(1) })
  }
  return { format: 'pdf', name, candidates }
}
function scorePdf(pages) {
  const p1 = pages[0]?.items ?? [], p2 = pages[1]?.items ?? [], p3 = pages[2]?.items ?? []
  const has = (items, value) => items.some(i => i.text === value)
  const ids = []
  for (const [id, value] of [['p1-title','Synthetic workshop'],['p1-question','Question: What improved the handoff?'],['p1-answer','Participant A: We tried a checklist.'],['p1-answer-limit','Its effect is unmeasured.'],['p1-h1','Measure'],['p1-h2','Before'],['p1-h3','After'],['p1-r1-c1','Reported delays'],['p1-r1-c2','4'],['p1-r1-c3','3']]) if (has(p1,value)) ids.push(id)
  for (const [id,value] of [['p2-caption','Figure 1: illustrative chart'],['p2-note','Note: graphic semantics require human inspection.'],['p2-counterpoint','Fictional counts do not establish causality.']]) if (has(p2,value)) ids.push(id)
  if (pages[1]?.pathOps > 0) ids.push('p2-chart')
  if (pages[2]?.imageOps > 0 && !p3.length) ids.push('p3-image')
  const columnOrder = p1.findIndex(x => x.text.startsWith('Participant A')) > p1.findIndex(x => x.text.startsWith('Question:'))
  const headerCells = ['Measure','Before','After'].map(t => p1.find(x => x.text === t)), dataCells = ['Reported delays','4','3'].map(t => p1.find(x => x.text === t))
  return { units: compare(inventory.pdf, ids), pageCount: pages.length, imageOnlyPage3: pages[2]?.imageOps > 0 && !p3.length, columnOrderRequiresReview: columnOrder, relationSignals: { answer_question: has(p1,'Participant A: We tried a checklist.') && has(p1,'Question: What improved the handoff?'), table_headers: headerCells.every((h,i) => h && dataCells[i] && Math.abs(h.x-dataCells[i].x) <= 1), caption_chart: false }, relationBasis: { answer_question:'same page text only', table_headers:'adapter x-coordinate alignment heuristic', caption_chart:'not supplied by parser' }, attributionSignal: { speaker: has(p1,'Participant A: We tried a checklist.') }, attributionBasis: 'explicit text prefix, not a PDF speaker annotation' }
}
async function worker(name, candidate) {
  const bytes = checkedBytes(name), rssStart = process.memoryUsage().rss, cpuStart = process.cpuUsage(), start = performance.now()
  let peakRss = rssStart
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 5)
  try {
    const result = name.endsWith('.pdf') ? await pdfRun(name, bytes, candidate) : name.endsWith('.md') ? await markdownRun(name, bytes) : await docxRun(name, bytes)
    const cpu = process.cpuUsage(cpuStart)
    return { ...result, resources: { inputBytes: bytes.length, elapsedMs: +(performance.now()-start).toFixed(1), cpuMs: +((cpu.user+cpu.system)/1000).toFixed(1), rssStartBytes: rssStart, rssPeakSampledBytes: Math.max(peakRss, process.memoryUsage().rss), maxRssReported: process.resourceUsage().maxRSS } }
  } finally { clearInterval(sampler) }
}
function runChild(name, candidate) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${ceilings.heapMiB}`, fileURLToPath(import.meta.url), '--worker', name, candidate ?? ''], { stdio: ['ignore','pipe','pipe'], windowsHide: true })
    let output = '', error = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, ceilings.ms)
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 2 * MiB) child.kill() })
    child.stderr.on('data', bytes => { error += bytes; if (error.length > 2 * MiB) child.kill() })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); if (timedOut) reject(Error(`timeout:${name}`)); else if (code) reject(Error(`worker:${name}:exit=${code}:${error.slice(0,500)}`)); else { try { const lines = output.trim().split(/\r?\n/); resolve({ ...JSON.parse(lines.at(-1)), warnings: [...lines.slice(0,-1), ...error.trim().split(/\r?\n/).filter(Boolean)] }) } catch { reject(Error(`worker-output:${name}:${output.slice(0,500)}:${error.slice(0,500)}`)) } } })
  })
}
async function faultChecks() {
  const sample = checkedBytes('complex-deflate-props.docx')
  const flaggedEncrypted = syntheticZip([['word/document.xml', Buffer.from('synthetic')]])
  flaggedEncrypted.writeUInt16LE(1, 6)
  flaggedEncrypted.writeUInt16LE(1, flaggedEncrypted.indexOf(Buffer.from('504b0102','hex')) + 8)
  const cases = [
    ['input-cap', sample, { ...ceilings, input: 32 }, 'input-limit'],
    ['expanded-cap', sample, { ...ceilings, expanded: 128 }, 'expanded-limit'],
    ['entry-cap', sample, { ...ceilings, entries: 2 }, 'entry-limit'],
    ['path-traversal', syntheticZip([['../evil.xml', Buffer.from('x')]]), ceilings, 'invalid'],
    ['duplicate-name', syntheticZip([['same.xml', Buffer.from('a')], ['same.xml', Buffer.from('b')]]), ceilings, 'duplicate-entry'],
    ['macro-entry', syntheticZip([['word/vbaProject.bin', Buffer.from('x')]]), ceilings, 'macro-entry'],
    ['macro-content-type', syntheticZip([['[Content_Types].xml', Buffer.from('<Types>macroEnabled</Types>')]]), ceilings, 'macro-content-type'],
    ['encryption-flag', flaggedEncrypted, ceilings, 'encrypted'],
    ['corrupt-zip', Buffer.from('not a zip'), ceilings, 'end of central directory']
  ]
  const results = []
  for (const [name, bytes, limits, expectedError] of cases) {
    try { await scanDocx(bytes, limits); results.push({ name, rejected: false }) }
    catch (error) { results.push({ name, rejected: true, reason: error.message.slice(0, 120), expected: error.message.toLowerCase().includes(expectedError.toLowerCase()) }) }
  }
  return results
}
async function externalRss(pid) {
  if (process.platform === 'linux') {
    const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m)
    return match ? Number(match[1]) * 1024 : null
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('ps', ['-o','rss=','-p',String(pid)], { timeout: 3000 })
    return Number(stdout.trim()) * 1024
  }
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { timeout: 5000, windowsHide: true })
    return Number(stdout.trim())
  }
  return null
}
async function resourceProbe() {
  const budget = 80 * MiB, intervalMs = 50, start = performance.now()
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--resource-probe-worker'], { stdio: 'ignore', windowsHide: true })
  let highest = 0, samples = 0, reason = 'worker-exit', lastError = null
  const closed = new Promise(resolve => child.on('close', resolve))
  while (child.exitCode === null && performance.now() - start < 5000) {
    try {
      const rss = await externalRss(child.pid)
      if (rss !== null) { highest = Math.max(highest,rss); samples++ }
      if (rss > budget) { reason = 'rss-observed-over-budget'; child.kill(); break }
    } catch (error) { lastError = error.message.slice(0,100); break }
    await new Promise(resolve => setTimeout(resolve,intervalMs))
  }
  if (child.exitCode === null) child.kill()
  await closed
  return { platform: process.platform, budgetBytes: budget, sampleIntervalMs: intervalMs, samples, highestObservedBytes: highest, observedOvershootBytes: Math.max(0,highest-budget), reason, lastError, elapsedMs: +(performance.now()-start).toFixed(1), mechanism: 'external OS working-set/RSS poll; advisory, not an atomic hard cap' }
}
async function resourceProbeWorker() {
  const held = []
  for (let i = 0; i < 12; i++) {
    const bytes = Buffer.alloc(8 * MiB, 1); held.push(bytes)
    await new Promise(resolve => setTimeout(resolve,50))
  }
  await new Promise(resolve => setTimeout(resolve,2000))
  return held.length
}
async function timeoutProbe() {
  const start = performance.now()
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--idle-worker'], { stdio:'ignore', windowsHide:true })
  const closed = new Promise(resolve => child.on('close', resolve))
  await new Promise(resolve => setTimeout(resolve,250))
  child.kill(); await closed
  return { timeoutMs:250, terminated:true, elapsedMs:+(performance.now()-start).toFixed(1), scope:'probe only; fixture workers use 60000 ms' }
}
export async function main() {
  if (process.argv[2] === '--worker') { console.log(JSON.stringify(await worker(process.argv[3], process.argv[4]))); return }
  if (process.argv[2] === '--resource-probe-worker') { await resourceProbeWorker(); return }
  if (process.argv[2] === '--resource-probe') { console.log(JSON.stringify(await resourceProbe(),null,2)); return }
  if (process.argv[2] === '--idle-worker') { await new Promise(resolve => setTimeout(resolve,10000)); return }
  if (process.argv[2] === '--timeout-probe') { console.log(JSON.stringify(await timeoutProbe(),null,2)); return }
  if (process.argv[2] !== '--fixtures') throw Error('usage: node scripts/evidence-spike.mjs --fixtures')
  for (const path of ['node_modules/mammoth/package.json','node_modules/pdfjs-dist/package.json','node_modules/pdfjs5/package.json','node_modules/yauzl/package.json','node_modules/fast-xml-parser/package.json','node_modules/markdown-it/package.json']) {
    try { statSync(join(dependencyRoot,path)) } catch { throw Error('Spike-only dependencies missing: npm ci --prefix tests/fixtures/evidence/spike --ignore-scripts') }
  }
  const rows = []
  for (const name of names) {
    if (name.endsWith('.pdf')) for (const candidate of ['pdfjs4','pdfjs5']) {
      try { rows.push(await runChild(name,candidate)) } catch (error) { rows.push({ name, candidate, failure: error.message.slice(0,500) }) }
    } else {
      try { rows.push(await runChild(name)) } catch (error) { rows.push({ name, failure: error.message.slice(0,500) }) }
    }
  }
  const faults = await faultChecks()
  if (faults.some(x => !x.rejected || !x.expected)) throw Error(`fault-check-failed:${JSON.stringify(faults)}`)
  console.log(JSON.stringify({ contract: { node: process.version, platform: process.platform, arch: process.arch, ceilings, goldenVisualAcceptance: expected.visual_acceptance }, rows, faults }, null, 2))
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
