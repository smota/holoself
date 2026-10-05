import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ALLOWED_SKILL_ENTRIES = new Set(['SKILL.md', 'agents', 'scripts', 'references', 'assets'])

export function loadSkillCatalog(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'manifests', 'skill-catalog.json'), 'utf8'))
}

export function validateSkillCatalog({ packageRoot }) {
  const findings = []
  let catalog
  try {
    catalog = loadSkillCatalog(packageRoot)
  } catch (error) {
    return { ok: false, findings: [finding('blocker', 'catalog.read', error.message)] }
  }

  if (catalog.version !== 1)
    findings.push(finding('blocker', 'catalog.version', 'version must be 1'))
  if (catalog.namespace !== 'agentflow')
    findings.push(finding('blocker', 'catalog.namespace', 'namespace must be agentflow'))
  if (catalog.identityFormat !== '<namespace>-<role>')
    findings.push(
      finding('blocker', 'catalog.identity-format', 'identityFormat must be <namespace>-<role>'),
    )
  if (!Array.isArray(catalog.skills) || catalog.skills.length === 0)
    findings.push(finding('blocker', 'catalog.skills', 'at least one skill is required'))

  const roles = new Set()
  const qualifiedNames = new Set()
  const ownership = new Map()
  for (const skill of catalog.skills || []) {
    if (!ROLE_PATTERN.test(skill.role || ''))
      findings.push(finding('blocker', 'skill.role', `invalid role ${skill.role ?? ''}`))
    if (roles.has(skill.role))
      findings.push(finding('blocker', 'skill.role', `duplicate role ${skill.role}`))
    roles.add(skill.role)

    const expectedName = `${catalog.namespace}-${skill.role}`
    if (skill.qualifiedName !== expectedName)
      findings.push(
        finding('blocker', 'skill.qualified-name', `${skill.role} must use ${expectedName}`),
      )
    if (qualifiedNames.has(skill.qualifiedName))
      findings.push(finding('blocker', 'skill.qualified-name', `duplicate ${skill.qualifiedName}`))
    qualifiedNames.add(skill.qualifiedName)

    if (skill.source !== `skills/${skill.qualifiedName}`)
      findings.push(
        finding(
          'high',
          'skill.source',
          `${skill.role} source must be skills/${skill.qualifiedName}`,
        ),
      )
    validateSkillDirectory({ packageRoot, catalog, skill, findings })

    for (const area of skill.owns || []) {
      if (ownership.has(area))
        findings.push(
          finding(
            'blocker',
            'skill.ownership-overlap',
            `${area} is owned by both ${ownership.get(area)} and ${skill.role}`,
          ),
        )
      ownership.set(area, skill.role)
    }
  }

  const expectedPeers = [...roles]
  for (const skill of catalog.skills || []) {
    const expected = expectedPeers.filter((role) => role !== skill.role).sort()
    const actual = [...(skill.recognizes || [])].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      findings.push(
        finding('high', 'skill.peer-recognition', `${skill.role} must recognize every peer role`),
      )
    for (const peer of skill.collaboratesWith || []) {
      if (!roles.has(peer))
        findings.push(
          finding('blocker', 'skill.collaborator', `${skill.role} references unknown ${peer}`),
        )
    }
  }

  for (const handoff of catalog.handoffs || []) {
    if (!roles.has(handoff.from) || !roles.has(handoff.to))
      findings.push(
        finding(
          'blocker',
          'skill.handoff-role',
          `handoff ${handoff.from} -> ${handoff.to} references an unknown role`,
        ),
      )
    if (!handoff.artifact)
      findings.push(finding('high', 'skill.handoff-artifact', 'handoff artifact is required'))
  }

  const registeredDirs = new Set((catalog.skills || []).map((skill) => basename(skill.source)))
  const skillsRoot = join(packageRoot, 'skills')
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(skillsRoot, entry.name, 'SKILL.md'))) continue
      if (registeredDirs.has(entry.name)) continue
      findings.push(
        finding('high', 'skill.unregistered', `skills/${entry.name} is not in the catalog`),
      )
    }
  }

  return {
    ok: findings.every((item) => !['blocker', 'high'].includes(item.severity)),
    namespace: catalog.namespace,
    skills: catalog.skills || [],
    findings,
  }
}

function validateSkillDirectory({ packageRoot, catalog, skill, findings }) {
  const directory = join(packageRoot, skill.source)
  const skillFile = join(directory, 'SKILL.md')
  if (!existsSync(skillFile)) {
    findings.push(
      finding('blocker', 'skill.missing', `missing ${relative(packageRoot, skillFile)}`),
    )
    return
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!ALLOWED_SKILL_ENTRIES.has(entry.name))
      findings.push(
        finding(
          'high',
          'skill.structure',
          `${skill.source}/${entry.name} is outside the standard skill structure`,
        ),
      )
  }

  const text = readFileSync(skillFile, 'utf8')
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatter) {
    findings.push(
      finding('blocker', 'skill.frontmatter', `${skill.source}/SKILL.md lacks frontmatter`),
    )
    return
  }
  const header = frontmatter[1]
  if (!new RegExp(`^name:\\s*${escapeRegex(skill.qualifiedName)}\\s*$`, 'm').test(header))
    findings.push(
      finding(
        'blocker',
        'skill.name',
        `${skill.source}/SKILL.md name must be ${skill.qualifiedName}`,
      ),
    )
  if (!/^description:\s*\S.+$/m.test(header))
    findings.push(
      finding('high', 'skill.description', `${skill.role} needs a discriminating description`),
    )
  if (!new RegExp(`^\\s*namespace:\\s*${catalog.namespace}\\s*$`, 'm').test(header))
    findings.push(
      finding('high', 'skill.namespace', `${skill.role} must declare metadata namespace`),
    )
  if (
    !new RegExp(
      `^\\s*qualified-name:\\s*["']?${escapeRegex(skill.qualifiedName)}["']?\\s*$`,
      'm',
    ).test(header)
  )
    findings.push(
      finding('high', 'skill.qualified-name', `${skill.role} must declare ${skill.qualifiedName}`),
    )
  for (const heading of ['Role contract', 'Boundaries', 'Handoffs']) {
    if (!new RegExp(`^## ${escapeRegex(heading)}$`, 'm').test(text))
      findings.push(finding('high', 'skill.style', `${skill.role} is missing ## ${heading}`))
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function finding(severity, code, message) {
  return { severity, code, message }
}
