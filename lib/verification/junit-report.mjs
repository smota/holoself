// Deliberately bounded JUnit subset. Unsupported or ambiguous XML fails closed.
export function parseJUnitAssertions(xml) {
  if (
    typeof xml !== 'string' ||
    Buffer.byteLength(xml) > 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw new Error('Unsupported JUnit document')
  if (!/<testsuites?\b/.test(xml) || !/<\/testsuites?>\s*$/.test(xml))
    throw new Error('Incomplete JUnit report')
  for (const suite of xml.matchAll(/<testsuites?\b([^>]*)>/g)) {
    for (const count of suite[1].matchAll(/\b(?:failures|errors)=["']([^"']*)["']/g)) {
      if (!/^0$/.test(count[1])) throw new Error('JUnit suite reports failures or errors')
    }
  }
  const decode = (value) =>
    value.replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key],
    )
  const assertions = []
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = match[1].match(/\bname=(?:"([^"]*)"|'([^']*)')/)
    if (!name) throw new Error('JUnit case has no name')
    const id = decode(name[1] ?? name[2])
    if (!id || assertions.some((item) => item.id === id))
      throw new Error('Ambiguous JUnit case identity')
    const content = match[2] ?? ''
    assertions.push({
      id,
      outcome: /<(failure|error)\b/.test(content)
        ? 'fail'
        : /<skipped\b/.test(content)
          ? 'not-run'
          : 'pass',
    })
  }
  if (!assertions.length) throw new Error('JUnit report contains no test cases')
  return assertions
}
