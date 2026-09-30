// Deterministic, synthetic OOXML variants of the D00 corpus. Source only.
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { docxBytes } from './build.mjs'

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)) }
  return (value ^ 0xffffffff) >>> 0
}
function members(stored) {
  const result = []
  for (let offset = 0; stored.readUInt32LE(offset) === 0x04034b50;) {
    const size = stored.readUInt32LE(offset + 18), length = stored.readUInt16LE(offset + 26), extra = stored.readUInt16LE(offset + 28)
    const start = offset + 30 + length + extra
    result.push([stored.subarray(offset + 30, offset + 30 + length).toString(), stored.subarray(start, start + size)])
    offset = start + size
  }
  return result
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4)
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, checksum])
}
function visiblePixel() {
  const width = 32, height = 32, ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [220, 35, 35]).flat())])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}
export function syntheticZip(entries) {
  const local = [], central = []; let offset = 0
  for (const [name, original] of entries) {
    const filename = Buffer.from(name), compressed = deflateRawSync(original, { level: 6 }), crc = crc32(original)
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8)
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x5021, 12) // 2020-01-01 00:00, fixed and nonzero.
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(compressed.length, 18); head.writeUInt32LE(original.length, 22); head.writeUInt16LE(filename.length, 26)
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6)
    index.writeUInt16LE(8, 10); index.writeUInt16LE(0x5021, 14); index.writeUInt32LE(crc, 16)
    index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(original.length, 24); index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42)
    local.push(head, filename, compressed); central.push(index, filename); offset += head.length + filename.length + compressed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
export function realisticDocx({ properties = false, visual = true } = {}) {
  const entries = members(docxBytes())
  if (visual) {
    const document = entries.find(([name]) => name === 'word/document.xml')
    let column = 0
    document[1] = Buffer.from(document[1].toString()
      .replace('<w:tbl>', '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="5000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>')
      .replace(/<w:tc>/g, () => `<w:tc><w:tcPr><w:tcW w:w="${[5000, 2000, 2000][column++ % 3]}" w:type="dxa"/></w:tcPr>`))
    entries.find(([name]) => name === 'word/media/pixel.png')[1] = visiblePixel()
  }
  if (properties) {
    const replace = (name, fn) => { const member = entries.find(([path]) => path === name); member[1] = Buffer.from(fn(member[1].toString())) }
    replace('[Content_Types].xml', text => text.replace('</Types>', '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'))
    replace('_rels/.rels', text => text.replace('</Relationships>', '<Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'))
    entries.push(['docProps/core.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Synthetic author</dc:creator><dc:title>Synthetic workshop</dc:title></cp:coreProperties>')])
    entries.push(['docProps/app.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Fixture builder</Application></Properties>')])
  }
  return syntheticZip(entries)
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, props] of [['complex-deflate.docx', false], ['complex-deflate-props.docx', true]]) {
    const path = new URL(name, import.meta.url)
    const bytes = realisticDocx({ properties: props })
    if (process.argv.includes('--check')) {
      if (!readFileSync(path).equals(bytes)) throw Error(`${name} differs from deterministic builder`)
    } else writeFileSync(path, bytes)
  }
}
