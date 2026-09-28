// Synthetic authoring only: no extraction libraries, remote assets or personal data.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const locals = [], central = []; let offset = 0
  for (const [name, value] of entries) {
    const data = Buffer.from(value), filename = Buffer.from(name), crc = crc32(data)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6)
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42)
    locals.push(local, filename, data); central.push(header, filename); offset += local.length + filename.length + data.length
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, index, end])
}
const xml = text => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${text}`
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const p = (text, extra = '') => `<w:p>${extra}<w:r><w:t>${text}</w:t></w:r></w:p>`
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64')
export function docxBytes() {
  const table = `<w:tbl>${[['Measure','Before','After'],['Reported delays','4','3']].map(row => `<w:tr>${row.map(cell => `<w:tc>${p(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
  const drawing = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Synthetic figure"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  const body = p('Synthetic workshop', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') + p('Question: What improved the handoff?') + p('Participant A: We tried a checklist. Its effect is unmeasured.') + table + `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Counts are self-reported.</w:t><w:footnoteReference w:id="1"/></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>` + drawing + p('Figure 1: synthetic pixel; no semantic inference.') + `<w:p><w:hyperlink r:id="rExternal"><w:r><w:t>Inert external reference</w:t></w:r></w:hyperlink></w:p>` + `<w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`
  const relationships = [['rComments','comments','comments.xml'],['rNotes','footnotes','footnotes.xml'],['rHeader','header','header1.xml'],['rStyles','styles','styles.xml'],['rImage','image','media/pixel.png'],['rExternal','hyperlink','https://example.invalid/no-fetch']]
  return zip([
    ['[Content_Types].xml', xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/>${[['document','document.main'],['comments','comments'],['footnotes','footnotes'],['header1','header'],['styles','styles']].map(([part,type]) => `<Override PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`).join('')}</Types>`)],
    ['_rels/.rels', xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDocument" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`)],
    ['word/document.xml', xml(`<w:document xmlns:w="${w}" xmlns:r="${r}"><w:body>${body}</w:body></w:document>`)],
    ['word/_rels/document.xml.rels', xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.map(([id,type,target]) => `<Relationship Id="${id}" Type="${r}/${type}" Target="${target}"${type === 'hyperlink' ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`)],
    ['word/styles.xml', xml(`<w:styles xmlns:w="${w}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`)],
    ['word/comments.xml', xml(`<w:comments xmlns:w="${w}"><w:comment w:id="0" w:author="Synthetic reviewer">${p('Do not infer causality.')}</w:comment></w:comments>`)],
    ['word/footnotes.xml', xml(`<w:footnotes xmlns:w="${w}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1">${p('Fictional sample of two observations.')}</w:footnote></w:footnotes>`)],
    ['word/header1.xml', xml(`<w:hdr xmlns:w="${w}">${p('SYNTHETIC - NOT PERSONAL DATA')}</w:hdr>`)],
    ['word/media/pixel.png', pixel]
  ])
}
export function pdfBytes() {
  const text = (x,y,value) => `BT /F1 12 Tf ${x} ${y} Td (${value}) Tj ET\n`
  const pages = [
    text(40,750,'Synthetic workshop') + text(40,700,'Question: What improved the handoff?') + text(320,700,'Participant A: We tried a checklist.') + text(320,680,'Its effect is unmeasured.') + text(40,620,'Measure') + text(250,620,'Before') + text(350,620,'After') + text(40,590,'Reported delays') + text(250,590,'4') + text(350,590,'3') + '40 580 360 60 re S\n',
    text(40,750,'Figure 1: illustrative chart') + '0.2 0.4 0.8 rg 60 500 40 80 re f 140 500 40 60 re f\n' + text(40,450,'Note: graphic semantics require human inspection.') + text(40,420,'Fictional counts do not establish causality.'),
    // Image-only page: no text operators, OCR intentionally absent.
    'q 300 0 0 300 50 300 cm /Im1 Do Q\n'
  ]
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let i=0;i<pages.length;i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 10 0 R >> >> /Contents ${5+i*2} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(pages[i])} >>\nstream\n${pages[i]}endstream`)
  }
  objects.push('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 25 >>\nstream\nFF000000FF000000FFFFFFFF>\nendstream')
  let result='%PDF-1.4\n',offsets=[0]
  objects.forEach((obj,index)=>{offsets.push(Buffer.byteLength(result));result+=`${index+1} 0 obj\n${obj}\nendobj\n`})
  const start=Buffer.byteLength(result)
  result+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(result)
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('complex.docx',import.meta.url),docxBytes())
  writeFileSync(new URL('complex.pdf',import.meta.url),pdfBytes())
}
