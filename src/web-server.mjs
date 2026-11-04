import { planSpaceAction, applySpaceAction, serializeSpaceMutation } from './space-actions.mjs'
import { readBindings, normalizeProjectPath } from './bindings.mjs'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { listDocuments, readDocument, saveAnnotatedDocument, saveDocument } from './documents.mjs'
import { HARNESS_IDS, detectHarnesses, loadHarnessSettings, runHarness, saveHarnessSettings, validateHarnessConfig } from './harnesses.mjs'
import { loadLensRegistry, removeCustomLens, saveCustomLens, saveLensInstructions } from './lenses.mjs'
import { connectorLaunchPlan, launchConnector, loadConnectors, saveConnectorExtension, validateConnector } from './connectors.mjs'
import { annotationSchema, validateAnnotationMetadata } from './annotations.mjs'
import { applyCleanupPlan } from './cleanup.mjs'
import { ensureHoloselfGitignore } from './link/config.mjs'
import { readLedgerEntries, recordServedPacket } from './ledger.mjs'
import { mcpClientOverview } from './mcp-config.mjs'
import { contextData } from './retrieval/context.mjs'
import { canonicalPath, samePath } from './path-guard.mjs'
import { resolveDocumentPolicy } from './policy/policy-defaults.mjs'
import {
  CONFLICT_CODES,
  HttpError,
  VERSION,
  WEB,
  body,
  cli,
  cliFailure,
  clientCheck,
  clientCheckAsync,
  conversationDir,
  conversationEvents,
  correctionsFor,
  filesystemRoots,
  folderListing,
  mime,
  readCatalog,
  reconcileCatalog,
  repairPlan,
  scrubMessage,
  send,
  status,
  tokenMatches,
  writeCatalog
} from './web/server-helpers.mjs'
export { HttpError, scrubMessage } from './web/server-helpers.mjs'
export async function startWebServer({ project = process.cwd(), root, port = 0, host = '127.0.0.1' } = {}) {
  if (host !== '127.0.0.1') throw new Error('web server is loopback-only')
  project = resolve(project)
  let linked = null
  if (existsSync(join(project, '.holoself', 'link.yaml'))) {
    const result = await cli(['link', 'status', '--project', project], { allowFailure: true })
    linked = JSON.parse(result.stdout)
    if (!linked.self_context?.path) throw new Error(`linked project status is unavailable: ${project}`)
    if (!root) root = linked.self_context.path
  } else if (!root) throw new Error(`Workbench requires --root <canonical-self-root> when cwd is not a linked project: ${project}`)
  root = resolve(root)
  if (!existsSync(join(root, 'config.json')) || !existsSync(join(root, 'profile')) || !existsSync(join(root, 'context')))
    throw new Error(`invalid canonical self root: ${root}`)
  if (linked && !samePath(canonicalPath(linked.self_context.path), canonicalPath(root)))
    throw new Error(`--root does not match linked project self root: ${root}`)
  const catalog = readCatalog(root)
  if (linked && !catalog.spaces.some(item => samePath(canonicalPath(item.path), canonicalPath(project)))) {
    catalog.spaces.push({ id: randomUUID(), path: project, addedAt: new Date().toISOString() })
    writeCatalog(root, catalog)
  }
  const token = randomBytes(24).toString('hex'),
    settingsPath = () => join(root, 'ui', 'settings.json')
  // DNS-rebinding defence: only the exact loopback host names on the listening port are served, and only their origins may mutate.
  const allowedHosts = () => {
    const port = server.address().port
    return [`127.0.0.1:${port}`, `localhost:${port}`]
  }
  const server = createServer(async (req, res) => {
    try {
      const hosts = allowedHosts()
      if (!hosts.includes(req.headers.host)) {
        res.writeHead(421)
        return res.end()
      }
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"
      )
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`),
        mutating = !['GET', 'HEAD'].includes(req.method)
      // Deny by default: any path that could reach an API route, in any letter case, needs the token.
      if (
        (url.pathname.toLowerCase().startsWith('/api') && !tokenMatches(req.headers['x-holoself-token'], token)) ||
        (mutating && !hosts.some(item => req.headers.origin === `http://${item}`))
      )
        return send(res, 403, { ok: false, error: { code: 'forbidden', message: 'Invalid local session token' } })
      if (url.pathname === '/api/session')
        return send(res, 200, {
          ok: true,
          data: {
            version: VERSION,
            mode: linked ? 'linked-project' : 'canonical-root',
            project: linked ? project : null,
            root,
            lens: linked?.self_context?.default_lens || null,
            rootExists: true
          }
        })
      if (url.pathname === '/api/root/init' && req.method === 'POST') {
        await cli(['init', '--root', root])
        return send(res, 200, { ok: true, data: { root } })
      }
      if (url.pathname === '/api/overview') {
        const catalog = reconcileCatalog(root),
          spaces = await Promise.all(catalog.spaces.map(status)),
          h = detectHarnesses()
        return send(res, 200, { ok: true, data: { root, spaces, harnesses: h, documents: existsSync(root) ? listDocuments(root).length : 0 } })
      }
      if (url.pathname === '/api/filesystem/roots' && req.method === 'GET')
        return send(res, 200, {
          ok: true,
          data: {
            roots: filesystemRoots(root),
            suggested: [
              { name: 'Canonical root', path: root },
              { name: 'Root parent', path: dirname(root) }
            ]
          }
        })
      if (url.pathname === '/api/filesystem/folders' && req.method === 'GET')
        return send(res, 200, { ok: true, data: folderListing(url.searchParams.get('path')) })
      if (url.pathname === '/api/spaces/discover' && req.method === 'POST') {
        const c = reconcileCatalog(root)
        return send(res, 200, { ok: true, data: { cataloged: c.spaces.length, discovered: c.discovered } })
      }
      if (url.pathname === '/api/spaces' && req.method === 'GET') {
        const c = reconcileCatalog(root)
        return send(res, 200, {
          ok: true,
          data: await Promise.all(
            c.spaces.map(async x => {
              const current = await status(x)
              return { ...x, status: current, corrections: correctionsFor(current) }
            })
          )
        })
      }
      if (url.pathname === '/api/spaces' && req.method === 'POST') {
        const b = await body(req)
        if (typeof b.path !== 'string' || !b.path.trim()) throw new HttpError(400, 'INVALID_INPUT', 'project path required')
        const path = resolve(b.path)
        await serializeSpaceMutation(() => cli(['link', 'add', '--project', path, '--self', root, '--lens', b.lens || 'general', '--yes']))
        const c = reconcileCatalog(root)
        return send(res, 201, { ok: true, data: c.spaces.find(x => normalizeProjectPath(x.path) === normalizeProjectPath(path)) })
      }
      const spaceRoute = url.pathname.match(/^\/api\/spaces\/([^/]+)$/)
      if (spaceRoute && req.method === 'DELETE') {
        const c = readCatalog(root),
          s = c.spaces.find(x => x.id === spaceRoute[1])
        if (!s) throw new HttpError(400, 'SPACE_NOT_FOUND', 'space not found')
        await serializeSpaceMutation(() => cli(['link', 'remove', '--project', s.path, '--yes']))
        c.spaces = c.spaces.filter(x => x.id !== s.id)
        writeCatalog(root, c)
        return send(res, 200, { ok: true, data: { removed: s.id } })
      }
      // Repair is two-step: a dry-run preview returns the plan and its hash; apply re-previews and writes only if the hash still matches.
      const rp = url.pathname.match(/^\/api\/spaces\/([^/]+)\/repair$/)
      if (rp && req.method === 'POST') {
        const b = await body(req)
        return await serializeSpaceMutation(async () => {
          const c = readCatalog(root),
            s = c.spaces.find(x => x.id === rp[1])
          if (!s) throw new HttpError(400, 'SPACE_NOT_FOUND', 'space not found')
          const preview = await cli(['link', 'repair', '--project', s.path, '--dry-run', '--yes']),
            planHash = createHash('sha256').update(preview.stdout).digest('hex')
          if (!b.apply)
            return send(res, 200, { ok: true, data: { preview: { output: preview.stdout, plan: repairPlan(preview.stdout), plan_hash: planHash } } })
          if (b.plan_hash !== planHash)
            throw new HttpError(409, 'PLAN_CHANGED', 'repair plan changed since preview; review it again', { current_hash: planHash })
          return send(res, 200, { ok: true, data: { output: (await cli(['link', 'repair', '--project', s.path, '--yes'])).stdout, plan_hash: planHash } })
        })
      }
      const spaceAction = url.pathname.match(/^\/api\/spaces\/([^/]+)\/(activate|deactivate|relink|setup)$/)
      if (spaceAction && req.method === 'POST') {
        const payload = await body(req),
          space = readCatalog(root).spaces.find(item => item.id === spaceAction[1])
        if (!space) throw new HttpError(400, 'SPACE_NOT_FOUND', 'space not found')
        const request = { root, project: space.path, action: spaceAction[2], lens: space.lens || 'general' }
        if (!payload.apply) {
          const plan = clientCheck(() => planSpaceAction(request), 'INVALID_SPACE_ACTION')
          return send(res, 200, { ok: true, data: { preview: { plan, plan_hash: plan.plan_hash } } })
        }
        return send(res, 200, { ok: true, data: await applySpaceAction(request, payload.plan_hash) })
      }
      const sm = url.pathname.match(/^\/api\/spaces\/([^/]+)\/(doctor|analyze|index|context)$/)
      if (sm && req.method === 'POST') {
        const c = readCatalog(root),
          s = c.spaces.find(x => x.id === sm[1])
        if (!s) throw new HttpError(400, 'SPACE_NOT_FOUND', 'space not found')
        const a = sm[2],
          args =
            a === 'analyze'
              ? ['analyze', 'all', '--project', s.path]
              : a === 'index'
                ? ['index', 'rebuild', '--project', s.path]
                : a === 'context'
                  ? ['context', '--project', s.path, '--budget', 'small', '--manifest', '--json']
                  : ['link', a, '--project', s.path]
        return send(res, 200, {
          ok: true,
          data: { output: (await serializeSpaceMutation(() => cli(args, a === 'context' ? { env: { HOLOSELF_LEDGER: 'off' } } : {}))).stdout }
        })
      }
      if (url.pathname === '/api/bindings' && req.method === 'GET') return send(res, 200, { ok: true, data: readBindings(root) })
      if (url.pathname === '/api/bindings' && ['PUT', 'DELETE'].includes(req.method)) {
        const b = await body(req),
          projectPath = clientCheck(() => normalizeProjectPath(b.project)),
          store = readBindings(root)
        if (b.expectedHash !== store.hash) throw new HttpError(409, 'STALE_BINDINGS', 'lens bindings changed on disk')
        const args = ['lens', req.method === 'DELETE' ? 'unbind' : 'bind', '--root', root, '--project', projectPath, '--yes', '--binding-hash', store.hash]
        if (req.method === 'PUT') {
          if (typeof b.default_lens !== 'string' || !b.default_lens.trim()) throw new HttpError(400, 'INVALID_INPUT', 'default_lens required')
          args.push('--lens', b.default_lens)
          if (b.secondary_lenses !== undefined) {
            if (!Array.isArray(b.secondary_lenses) || b.secondary_lenses.some(x => typeof x !== 'string'))
              throw new HttpError(400, 'INVALID_INPUT', 'secondary_lenses must be an array of strings')
            if (b.secondary_lenses.length) args.push('--secondary-lenses', b.secondary_lenses.join(','))
          }
        }
        await cli(args)
        reconcileCatalog(root)
        return send(res, 200, { ok: true, data: readBindings(root) })
      }
      if (url.pathname === '/api/lenses' && req.method === 'GET')
        return send(res, 200, { ok: true, data: JSON.parse((await cli(['lens', 'list', '--root', root])).stdout) })
      const li = url.pathname.match(/^\/api\/lenses\/([^/]+)\/instructions$/)
      if (li && req.method === 'PUT') {
        const b = await body(req)
        loadLensRegistry(root)
        const registry = clientCheck(() => saveLensInstructions(root, li[1], b.instructions, b.expectedHash), 'INVALID_LENS')
        return send(res, 200, { ok: true, data: { registry_hash: registry.registry_hash, lenses: registry.lenses } })
      }
      const lm = url.pathname.match(/^\/api\/lenses\/([^/]+)$/)
      if (lm && req.method === 'PUT') {
        const b = await body(req)
        loadLensRegistry(root)
        const registry = clientCheck(() => saveCustomLens(root, lm[1], b.definition, b.expectedHash), 'INVALID_LENS')
        return send(res, 200, { ok: true, data: { registry_hash: registry.registry_hash, lenses: registry.lenses } })
      }
      if (lm && req.method === 'DELETE') {
        const b = await body(req)
        loadLensRegistry(root)
        const registry = clientCheck(() => removeCustomLens(root, lm[1], b.expectedHash), 'INVALID_LENS')
        return send(res, 200, { ok: true, data: { registry_hash: registry.registry_hash, lenses: registry.lenses } })
      }
      if (url.pathname === '/api/annotations/schema' && req.method === 'GET') {
        const registry = loadLensRegistry(root)
        return send(res, 200, { ok: true, data: annotationSchema(registry.lenses) })
      }
      if (url.pathname === '/api/annotations/validate' && req.method === 'POST') {
        const b = await body(req)
        if (b.metadata !== undefined && (!b.metadata || typeof b.metadata !== 'object' || Array.isArray(b.metadata)))
          throw new HttpError(400, 'INVALID_INPUT', 'metadata must be an object')
        const registry = loadLensRegistry(root),
          resolved = typeof b.path === 'string' && b.path.trim() ? resolveDocumentPolicy(b.path, root, b.metadata || {}, registry) : null,
          targetMeta = resolved ? resolved.effectiveMetadata : b.metadata,
          result = validateAnnotationMetadata(
            targetMeta,
            registry.lenses.map(lens => lens.id),
            { allowLegacy: true }
          )
        return send(res, 200, {
          ok: true,
          data: resolved ? { ...result, effective_policy: resolved.effectiveMetadata, policy_sources: resolved.policySources } : result
        })
      }
      if (url.pathname === '/api/documents' && req.method === 'GET') return send(res, 200, { ok: true, data: listDocuments(root) })
      if (url.pathname === '/api/document' && req.method === 'GET')
        return send(res, 200, { ok: true, data: clientCheck(() => readDocument(root, url.searchParams.get('path')), 'INVALID_DOCUMENT') })
      if (url.pathname === '/api/document' && req.method === 'PUT') {
        const b = await body(req),
          knownLenses = loadLensRegistry(root).lenses.map(lens => lens.id),
          validate = async () => {
            await cli(['validate', '--root', root])
          },
          saved = await clientCheckAsync(
            () =>
              b.metadata && b.segments
                ? saveAnnotatedDocument(root, b.path, { metadata: b.metadata, segments: b.segments, expectedHash: b.expectedHash }, { validate, knownLenses })
                : saveDocument(root, b.path, b.content, b.expectedHash, { validate }),
            'INVALID_DOCUMENT'
          )
        return send(res, 200, { ok: true, data: saved })
      }
      if (url.pathname === '/api/proposals' && req.method === 'GET') {
        const project = url.searchParams.get('project')
        if (typeof project !== 'string' || !project.trim()) throw new HttpError(400, 'INVALID_INPUT', 'project path required')
        return send(res, 200, { ok: true, data: JSON.parse((await cli(['proposals', 'list', '--project', project])).stdout) })
      }
      if (url.pathname === '/api/proposals' && req.method === 'POST') {
        const b = await body(req)
        const retire = b.operation === 'retire' || b.operation === 'retire_claim'
        if (
          typeof b.project !== 'string' ||
          !b.project.trim() ||
          (!retire && (typeof b.claim !== 'string' || !b.claim.trim())) ||
          typeof b.sourceFile !== 'string' ||
          !b.sourceFile.trim()
        )
          throw new HttpError(400, 'INVALID_INPUT', 'project, claim, and sourceFile are required')
        for (const key of ['operation', 'claimId', 'reason'])
          if (b[key] !== undefined && typeof b[key] !== 'string') throw new HttpError(400, 'INVALID_INPUT', `${key} must be a string`)
        const args = ['propose', '--project', b.project, '--source-file', b.sourceFile]
        if (!retire) args.push('--claim', b.claim)
        if (b.operation) args.push('--op', b.operation)
        if (b.claimId) args.push('--claim-id', b.claimId)
        if (b.reason) args.push('--reason', b.reason)
        if (b.target) args.push('--target-file', b.target)
        if (b.evidence) args.push('--evidence', b.evidence)
        return send(res, 201, { ok: true, data: JSON.parse((await cli(args)).stdout) })
      }
      if (url.pathname === '/api/proposals/audit' && req.method === 'GET') {
        const project = url.searchParams.get('project')
        if (typeof project !== 'string' || !project.trim()) throw new HttpError(400, 'INVALID_INPUT', 'project path required')
        return send(res, 200, { ok: true, data: JSON.parse((await cli(['proposals', 'audit', '--project', project], { allowFailure: true })).stdout) })
      }
      const pp = url.pathname.match(/^\/api\/proposals\/([^/]+)\/preview$/)
      if (pp && req.method === 'POST') {
        const b = await body(req)
        if (typeof b.project !== 'string' || !b.project.trim()) throw new HttpError(400, 'INVALID_INPUT', 'project path required')
        const preview = await cli(['proposals', 'approve', pp[1], '--project', b.project, '--json'], { allowFailure: true })
        if (!preview.stdout) throw cliFailure(preview.stderr, preview.code)
        const data = JSON.parse(preview.stdout)
        return send(res, 200, {
          ok: true,
          data: {
            proposalId: data.proposal_id,
            changes: data.changes,
            previewHash: data.preview_hash,
            affectedFiles: [...new Set(data.changes.map(x => x.target))],
            evidence: [...new Set(data.changes.map(x => x.evidence).filter(Boolean))].join('; ')
          }
        })
      }
      const pm = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(approve|reject|defer|supersede)$/)
      if (pm && req.method === 'POST') {
        const b = await body(req)
        if (typeof b.project !== 'string' || !b.project.trim()) throw new HttpError(400, 'INVALID_INPUT', 'project path required')
        const args = ['proposals', pm[2], pm[1], '--project', b.project, '--yes']
        if (pm[2] === 'approve') {
          if (!b.previewHash) throw new HttpError(409, 'STALE_PREVIEW', 'Preview hash required.')
          args.push('--preview-hash', b.previewHash)
        }
        return send(res, 200, { ok: true, data: { output: (await cli(args)).stdout } })
      }
      if (url.pathname === '/api/knowledge/cleanup' && req.method === 'GET') {
        return send(res, 200, { ok: true, data: JSON.parse((await cli(['knowledge', 'cleanup', '--root', root, '--dry-run'])).stdout) })
      }
      if (url.pathname === '/api/knowledge/cleanup' && req.method === 'POST') {
        const b = await body(req)
        if (!b.plan || typeof b.plan !== 'object' || Array.isArray(b.plan) || typeof b.digest !== 'string' || !b.digest.trim())
          throw new HttpError(400, 'INVALID_INPUT', 'cleanup plan and digest are required')
        return send(res, 200, { ok: true, data: clientCheck(() => applyCleanupPlan(root, b.plan, { expectedDigest: b.digest }), 'INVALID_CLEANUP_PLAN') })
      }
      if (url.pathname === '/api/connectors' && req.method === 'GET') return send(res, 200, { ok: true, data: loadConnectors(root) })
      // Per linked space and MCP client: not-detected | detected | configured | verified | failing (read-only).
      if (url.pathname === '/api/mcp/clients' && req.method === 'GET') {
        const catalog = reconcileCatalog(root)
        return send(res, 200, { ok: true, data: catalog.spaces.map(space => ({ id: space.id, path: space.path, ...mcpClientOverview(space.path) })) })
      }
      if (url.pathname === '/api/connectors' && req.method === 'POST') {
        const b = await body(req)
        clientCheck(() => validateConnector(b), 'INVALID_CONNECTOR')
        const connector = saveConnectorExtension(root, b)
        return send(res, 201, { ok: true, data: connector })
      }
      if (url.pathname === '/api/connectors/launch' && req.method === 'POST') {
        const b = await body(req)
        if (typeof b.space !== 'string' || !b.space.trim()) throw new HttpError(400, 'INVALID_INPUT', 'space path required')
        const catalog = reconcileCatalog(root),
          space = catalog.spaces.find(item => samePath(canonicalPath(item.path), canonicalPath(b.space)))
        if (!space) throw new HttpError(400, 'SPACE_NOT_FOUND', 'space is not linked')
        const connectors = loadConnectors(root),
          plan = clientCheck(
            () => connectorLaunchPlan(connectors, { space: space.path, connectorId: b.connectorId, terminalId: b.terminalId, mode: b.mode }),
            'INVALID_CONNECTOR_LAUNCH'
          )
        return send(res, 200, { ok: true, data: { ...launchConnector(plan), connectorId: b.connectorId, terminalId: b.terminalId || null, mode: b.mode } })
      }
      if (url.pathname === '/api/harnesses' && req.method === 'GET') {
        const saved = loadHarnessSettings(settingsPath())
        return send(res, 200, { ok: true, data: detectHarnesses().map(x => ({ ...x, configuration: saved.harnesses[x.id] || null })) })
      }
      const hm = url.pathname.match(/^\/api\/harnesses\/([^/]+)$/)
      if (hm && req.method === 'PUT') {
        const b = await body(req),
          config = clientCheck(() => validateHarnessConfig(hm[1], b), 'INVALID_HARNESS'),
          saved = loadHarnessSettings(settingsPath())
        saved.harnesses[hm[1]] = config
        saveHarnessSettings(settingsPath(), saved)
        return send(res, 200, { ok: true, data: config })
      }
      const hv = url.pathname.match(/^\/api\/harnesses\/([^/]+)\/verify$/)
      if (hv && req.method === 'POST') {
        if (!HARNESS_IDS.includes(hv[1])) throw new HttpError(400, 'INVALID_HARNESS', 'unknown harness')
        const saved = loadHarnessSettings(settingsPath()),
          detected = detectHarnesses().find(item => item.id === hv[1]),
          config = saved.harnesses[hv[1]] || detected?.defaultConfiguration
        if (!config) throw new HttpError(400, 'HARNESS_UNAVAILABLE', 'No safe automatic invocation found. Use advanced settings to select the executable.')
        await runHarness(config, 'Reply only with OK', { cwd: root, timeoutMs: 15000, maxStdout: 65536 })
        config.verifiedAt = new Date().toISOString()
        saved.harnesses[hv[1]] = config
        saveHarnessSettings(settingsPath(), saved)
        return send(res, 200, { ok: true, data: config })
      }
      if (url.pathname === '/api/conversations' && req.method === 'GET') {
        const project = url.searchParams.get('project'),
          dir = conversationDir(project)
        let items = []
        if (existsSync(dir)) {
          items = readdirSync(dir)
            .filter(x => /^[0-9a-f-]{36}\.ndjson$/i.test(x))
            .map(name => {
              const id = name.slice(0, -7),
                events = conversationEvents(project, id),
                last = events.at(-1) || {}
              return { id, harness: last.harness, updatedAt: last.at, turns: events.length }
            })
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        }
        return send(res, 200, { ok: true, data: items })
      }
      const cg = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})$/)
      if (cg && req.method === 'GET')
        return send(res, 200, { ok: true, data: { id: cg[1], events: conversationEvents(url.searchParams.get('project'), cg[1]) } })
      if (url.pathname === '/api/conversation' && req.method === 'POST') {
        const b = await body(req)
        if (
          typeof b.project !== 'string' ||
          !b.project.trim() ||
          typeof b.harness !== 'string' ||
          !b.harness.trim() ||
          typeof b.message !== 'string' ||
          !b.message.trim()
        )
          throw new HttpError(400, 'INVALID_INPUT', 'project, harness, and message are required')
        const saved = loadHarnessSettings(settingsPath()),
          detected = detectHarnesses().find(item => item.id === b.harness),
          config = saved.harnesses[b.harness] || detected?.defaultConfiguration
        if (!config) throw new HttpError(400, 'HARNESS_UNAVAILABLE', 'connector unavailable')
        const project = resolve(b.project),
          id = b.id || randomUUID(),
          prior = b.id ? conversationEvents(project, id) : [],
          context = (
            await cli(
              [
                'context',
                '--project',
                project,
                '--lens',
                b.lens || 'general',
                '--task',
                String(b.message).slice(0, 500),
                '--format',
                'packet',
                '--adapter',
                b.harness
              ],
              { env: { HOLOSELF_LEDGER: 'off' } }
            )
          ).stdout
        const history = prior
            .slice(-12)
            .map(x => `User: ${x.message}\nAssistant: ${x.response}`)
            .join('\n\n')
            .slice(-32000),
          prompt =
            `${context}${history ? `\n\nRecent conversation:\n${history}` : ''}\n\nUser request:\n${b.message}\n\nDurable ` +
            `self changes require a Holoself proposal and explicit approval.`
        const result = await runHarness(config, prompt, { cwd: project })
        try {
          const packetData = contextData({
            project,
            lens: b.lens || 'general',
            task: String(b.message).slice(0, 500),
            format: 'packet',
            adapter: b.harness
          })
          const servedPacketId = context.match(/^Packet ID:\s*(\S+)/m)?.[1]
          if (servedPacketId && packetData?.packet_metadata) packetData.packet_metadata.packet_id = servedPacketId
          recordServedPacket({
            data: packetData,
            project,
            self: root,
            surface: 'workbench',
            mode: 'packet',
            host: b.harness
          })
        } catch {}
        try {
          ensureHoloselfGitignore(project)
        } catch {}
        const dir = conversationDir(project)
        mkdirSync(dir, { recursive: true })
        appendFileSync(
          join(dir, `${id}.ndjson`),
          JSON.stringify({ at: new Date().toISOString(), harness: b.harness, lens: b.lens || 'general', message: b.message, response: result.stdout }) + '\n'
        )
        return send(res, 200, { ok: true, data: { id, response: result.stdout } })
      }
      if (url.pathname === '/api/ledger' && req.method === 'GET') {
        const catalog = reconcileCatalog(root),
          spaceParam = (url.searchParams.get('space') || '').trim(),
          lensParam = url.searchParams.get('lens') || null,
          surfaceParam = url.searchParams.get('surface') || null,
          sinceParam = url.searchParams.get('since') || null,
          limitRaw = url.searchParams.get('limit')
        const limitNum = clientCheck(() => {
          if (limitRaw === null || limitRaw === '') return 100
          const parsed = Number(limitRaw)
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw new Error('limit must be an integer between 1 and 1000')
          return parsed
        }, 'INVALID_LEDGER_FILTER')
        const targets = []
        if (!spaceParam || spaceParam === 'all') {
          for (const item of catalog.spaces) targets.push({ id: item.id, name: item.name, path: item.path })
          targets.push({ id: 'self', name: 'Canonical root', path: root })
        } else if (spaceParam === 'self' || spaceParam === 'root') {
          targets.push({ id: 'self', name: 'Canonical root', path: root })
        } else {
          const matched = catalog.spaces.find(
            item =>
              item.id === spaceParam ||
              item.name === spaceParam ||
              (existsSync(spaceParam) && samePath(canonicalPath(item.path), canonicalPath(spaceParam)))
          )
          if (!matched) throw new HttpError(400, 'SPACE_NOT_FOUND', 'space not found')
          targets.push({ id: matched.id, name: matched.name, path: matched.path })
        }
        const collected = clientCheck(() => {
          const list = []
          for (const target of targets) {
            if (!existsSync(target.path)) continue
            const items = readLedgerEntries(target.path, {
              since: sinceParam,
              lens: lensParam,
              surface: surfaceParam
            })
            for (const entry of items) {
              const entryMode = entry.mode || 'packet'
              const counts =
                entryMode === 'manifest'
                  ? {
                      items_listed: entry.counts?.items_listed ?? 0,
                      restricted: entry.counts?.restricted ?? 0,
                      envelope_dropped: entry.counts?.envelope_dropped ?? 0
                    }
                  : {
                      documents_delivered: entry.counts?.documents_delivered ?? 0,
                      restricted: entry.counts?.restricted ?? 0,
                      envelope_dropped: entry.counts?.envelope_dropped ?? 0
                    }
              list.push({
                schema_version: entry.schema_version,
                served_at: entry.served_at,
                surface: entry.surface,
                mode: entryMode,
                host: entry.host ?? null,
                lens: entry.lens ?? null,
                budget: entry.budget ?? 'standard',
                need: entry.need ?? 'complete',
                task_hmac: entry.task_hmac ?? null,
                context_hash: entry.context_hash ?? null,
                packet_id: entry.packet_id ?? null,
                source_ids: Array.isArray(entry.source_ids) ? entry.source_ids.filter(id => /^hs-[A-Za-z0-9_-]+$/.test(String(id))) : [],
                counts,
                total_bytes: entry.total_bytes ?? 0,
                space_id: target.id,
                space_name: target.name
              })
            }
          }
          list.sort((a, b) => String(a.served_at).localeCompare(String(b.served_at)))
          return list.length > limitNum ? list.slice(-limitNum) : list
        }, 'INVALID_LEDGER_FILTER')
        return send(res, 200, {
          ok: true,
          data: {
            entries: collected,
            spaces: catalog.spaces.map(item => ({ id: item.id, name: item.name, lens: item.lens }))
          }
        })
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown API route' } })
      let rel
      try {
        rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
      } catch {
        throw new HttpError(400, 'INVALID_PATH', 'invalid path')
      }
      if (rel.includes('..')) throw new HttpError(400, 'INVALID_PATH', 'invalid path')
      const file = join(WEB, rel),
        ext = extname(file).toLowerCase()
      if (!file.startsWith(WEB + sep) || !existsSync(file) || !lstatSync(file).isFile() || (ext === '.html' && rel !== 'index.html')) {
        res.writeHead(404)
        return res.end('Not found')
      }
      // The session token reaches the page only inside the served shell, never through an open endpoint.
      if (rel === 'index.html') {
        const page = readFileSync(file, 'utf8').replace('__HOLOSELF_TOKEN__', token)
        res.writeHead(200, { 'content-type': mime['.html'], 'cache-control': 'no-store' })
        return res.end(page)
      }
      const content = readFileSync(file)
      res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream' })
      res.end(content)
    } catch (error) {
      try {
        if (res.headersSent) return res.destroy()
        if (error?.status === 413) res.once('finish', () => req.destroy())
        if (CONFLICT_CODES.has(error?.code) || error?.status === 409)
          return send(res, 409, {
            ok: false,
            error: { code: error.code || 'CONFLICT', message: scrubMessage(error.message, [root, project]), current_hash: error.current_hash }
          })
        if (error instanceof HttpError)
          return send(res, error.status || 400, {
            ok: false,
            error: { code: error.code || 'INVALID_INPUT', message: scrubMessage(error.message, [root, project]), current_hash: error.current_hash }
          })
        console.error('[holoself web] internal error', scrubMessage(error?.stack || error?.message || String(error), [root, project]))
        send(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'internal error' } })
      } catch {
        res.destroy()
      }
    }
  })
  await new Promise((ok, no) => {
    server.once('error', no)
    server.listen(port, host, ok)
  })
  const address = server.address()
  return { server, url: `http://${host}:${address.port}`, token, root, project: linked ? project : null, mode: linked ? 'linked-project' : 'canonical-root' }
}
