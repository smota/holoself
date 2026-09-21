import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { run } from '../../src/cli.mjs'

export const FIXTURE_VERSION = 1
export const FIXED_MTIME = new Date('2020-01-02T03:04:05.000Z')
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value
const within = (parent, child) => {
  const rel = relative(parent, child)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
const metadata = lenses => `---\naccess_lenses: [${lenses.join(', ')}]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n`
const tasks = {
  en: {
    personal: ['Describe my identity using my recorded priorities', 'Plan my next career step using recorded experience', 'Prepare my leadership example from recorded evidence', 'Write an introduction in my personal voice', 'Explain my recorded preference for collaboration', 'Prepare my interview answer from the recorded story'],
    mechanical: ['Format this JSON object: {"x":1}', 'Rename the variable x to item in this snippet', 'Fix the syntax in this code: let x = ;', 'Sort these three integers: 3, 1, 2', 'Convert this literal timestamp to ISO notation', 'Indent this supplied CSS rule'],
    ambiguous: ['Compare these options for my next step', 'Help me choose an approach to the meeting', 'Improve this draft for the conversation', 'Suggest how to proceed this week', 'What should I emphasize in this answer?', 'Review this decision with the available context']
  },
  pt: {
    personal: ['Descreva minha identidade usando minhas prioridades registradas', 'Planeje meu próximo passo de carreira com minha experiência registrada', 'Prepare meu exemplo de liderança com as evidências registradas', 'Escreva uma apresentação com minha voz pessoal', 'Explique minha preferência registrada de colaboração', 'Prepare minha resposta de entrevista com a história registrada'],
    mechanical: ['Formate este objeto JSON: {"x":1}', 'Renomeie a variável x para item neste trecho', 'Corrija a sintaxe deste código: let x = ;', 'Ordene estes três números inteiros: 3, 1, 2', 'Converta este horário literal para notação ISO', 'Indente esta regra CSS fornecida'],
    ambiguous: ['Compare estas opções para meu próximo passo', 'Ajude a escolher uma abordagem para a reunião', 'Melhore este rascunho para a conversa', 'Sugira como prosseguir nesta semana', 'O que devo enfatizar nesta resposta?', 'Revise esta decisão com o contexto disponível']
  }
}

export function qualityDefinitions() {
  return Object.entries(tasks).flatMap(([language, classes]) => Object.entries(classes).flatMap(([kind, prompts]) => prompts.map((task, index) => {
    const id = `q-${language}-${kind}-${index + 1}`
    return { id, language, class: kind, task, lens: kind === 'personal' && index % 3 === 2 ? 'career' : 'general', budget: 'deep', requiredMarkers: kind === 'mechanical' ? [] : [`C00_REQUIRED_${id}`], forbiddenMarkers: ['C00_FORBIDDEN_RESTRICTED'], optionalMarkers: [`C00_OPTIONAL_${id}`], expectedNeed: kind === 'mechanical' ? ['not-needed'] : kind === 'personal' ? ['required'] : ['helpful', 'required'] }
  })))
}

async function quietRun(args) {
  const original = console.log
  console.log = () => {}
  try { await run(args) } finally { console.log = original }
}

export async function createFixture({ count = 100, baseDir } = {}) {
  if (!Number.isInteger(count) || count < 0 || count > 10000) throw new TypeError('count must be an integer from 0 to 10000')
  const temporaryParent = realpathSync(tmpdir())
  const parent = realpathSync(resolve(baseDir || temporaryParent))
  if (canonical(parent) !== canonical(temporaryParent) && !within(temporaryParent, parent)) throw new Error('fixture parent must be inside the system temporary directory')
  const root = await mkdtemp(join(parent, 'holoself-c00-'))
  const originalRoot = realpathSync(root), identity = lstatSync(root)
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    const current = lstatSync(root)
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('fixture root was replaced; refusing cleanup')
    const actualRoot = realpathSync(root), actualParent = realpathSync(dirname(root))
    if (canonical(actualRoot) !== canonical(originalRoot) || canonical(actualParent) !== canonical(parent) || !within(actualParent, actualRoot) || !basename(actualRoot).startsWith('holoself-c00-')) throw new Error('unsafe fixture cleanup boundary')
    await rm(root, { recursive: true, force: false })
    cleaned = true
  }
  try {
    const self = join(root, 'self'), project = join(root, 'project'), peer = join(root, 'peer'), qualityRoot = join(root, 'quality')
    await Promise.all([self, project, peer, qualityRoot].map(path => mkdir(path)))
    await quietRun(['init', '--root', self])
    for (const linked of [project, peer]) await quietRun(['link', 'add', '--project', linked, '--self', self, '--lens', 'general', '--no-activate', '--yes'])
    await writeFile(join(peer, 'C00-PEER-EXCLUSIVE.md'), '# Peer synthetic evidence\nC00_PEER_EXCLUSIVE\n')
    await mkdir(join(self, 'lenses'), { recursive: true })
    await writeFile(join(self, 'lenses', 'spiritual.json'), JSON.stringify({ schema_version: 1, id: 'spiritual', title: 'Synthetic spiritual perspective', base_lens: 'general' }))
    const syntheticPaths = []
    for (let index = 0; index < count; index++) {
      const path = join(self, 'context', `synthetic-${String(index).padStart(5, '0')}.md`)
      await writeFile(path, metadata(['general', 'private']) + `# Synthetic ${index}\n\nC00_SCALE_${String(index).padStart(5, '0')} career planning.\n`)
      syntheticPaths.push(path)
    }
    const qualityCases = []
    for (const item of qualityDefinitions()) {
      const path = join(qualityRoot, `${item.id}.md`)
      const lead = item.language === 'pt' ? 'Evidência sintética relevante' : 'Relevant synthetic evidence'
      const text = metadata(['general', 'career']) + `# ${lead}\n\n${item.task}\n${item.requiredMarkers.join(' ')} ${item.optionalMarkers.join(' ')}\n`
      await writeFile(path, text)
      qualityCases.push({ ...item, sourcePath: path, sourceBytes: Buffer.byteLength(text) })
    }
    const restrictedQualityPath = join(qualityRoot, 'restricted-quality.md')
    await writeFile(restrictedQualityPath, metadata(['private']) + '# Restricted synthetic evidence\nC00_FORBIDDEN_RESTRICTED\n')
    const sources = []
    const collect = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory() && entry.name !== '.holoself') collect(path)
        else if (entry.isFile() && entry.name.endsWith('.md')) sources.push(path)
      }
    }
    for (const directory of [self, project, peer, qualityRoot]) collect(directory)
    for (const path of sources) await utimes(path, FIXED_MTIME, FIXED_MTIME)
    const sourceDigest = hash(JSON.stringify(sources.map(path => [relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')]).sort((a, b) => a[0].localeCompare(b[0]))))
    const qualityDigest = hash(JSON.stringify(qualityDefinitions()))
    return { root, self, project, peer, syntheticPaths, sourceDigest, qualityCases, qualityRoot, restrictedQualityPath, qualityDigest, cleanup }
  } catch (error) {
    if (existsSync(root)) await cleanup()
    throw error
  }
}
