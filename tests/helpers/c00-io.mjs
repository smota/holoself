import fs, { promises as fsp } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { relative, resolve, sep } from 'node:path'

const syncMeta = ['statSync', 'lstatSync', 'readdirSync', 'accessSync', 'existsSync']
const callbackMeta = ['stat', 'lstat', 'readdir', 'access', 'exists']
const promiseMeta = ['stat', 'lstat', 'readdir', 'access']
const raw = ['readSync', 'read', 'readv', 'readvSync', 'openSync', 'open']
const bytes = value => Buffer.isBuffer(value) || typeof value === 'string' ? Buffer.byteLength(value) : 0
const fd = value => typeof value === 'number' || (value && typeof value.fd === 'number')
// fs/promises keeps FileHandle private. Capture its shared prototype while this
// helper loads, before any measurement window, so pre-opened handles are seen.
const bootstrapHandle = await fsp.open(fileURLToPath(import.meta.url), 'r')
const fileHandlePrototype = Object.getPrototypeOf(bootstrapHandle)
await bootstrapHandle.close()

export function installIoMeter({ roots, syntheticPaths = [] } = {}) {
  const rootsList = Object.entries(roots || {}).filter(([, root]) => typeof root === 'string').map(([kind, root]) => ({ kind, root: resolve(root) }))
  const synthetic = new Set(syntheticPaths.map(path => resolve(path)))
  const originals = []; const local = new AsyncLocalStorage()
  const state = { active: false, installed: false, bodyReads: 0, bodyBytes: 0, metadataOps: 0, byApi: {}, byPath: {}, unsupported: [] }
  const pathOf = value => typeof value === 'string' ? value : value instanceof URL && value.protocol === 'file:' ? fileURLToPath(value) : null
  const classify = value => {
    const input = pathOf(value)
    if (!input) return { classification: 'rest', path: '<unknown>', key: 'rest:<unknown>', body: false }
    const absolute = resolve(input); const root = rootsList.find(({ root }) => { const rel = relative(root, absolute); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)) })
    const path = (root ? relative(root.root, absolute) : absolute).replaceAll('\\', '/') || '.'; const markdown = absolute.toLowerCase().endsWith('.md')
    const classification = synthetic.has(absolute) ? 'synthetic' : !root ? 'rest' : markdown && ['self', 'project', 'peer'].includes(root.kind) ? `${root.kind}-body` : 'derived'
    return { classification, path, key: `${classification}:${path}`, body: Boolean(root && markdown) }
  }
  const api = name => { state.byApi[name] = (state.byApi[name] || 0) + 1 }
  const entry = (name, value) => { const info = classify(value); const item = state.byPath[info.key] ||= { classification: info.classification, path: info.path, reads: 0, bytes: 0, apis: {} }; item.apis[name] = (item.apis[name] || 0) + 1; return [info, item] }
  const body = (name, value, result) => { if (!state.active) return; api(name); const [info, item] = entry(name, value); const length = bytes(result); item.reads++; item.bytes += length; if (!info.body) return; item.bodyReads = (item.bodyReads || 0) + 1; state.bodyReads++; state.bodyBytes += length }
  const metadata = (name, value) => { if (!state.active) return; api(name); entry(name, value); state.metadataOps++ }
  const unsupported = (name, detail) => { if (state.active && !local.getStore()) state.unsupported.push({ api: name, detail }) }
  const replace = (owner, name, wrapper) => { originals.push([owner, name, owner[name]]); owner[name] = wrapper(owner[name]) }
  const escapeConsumerListeners = stream => {
    const listeners = new WeakMap()
    for (const name of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
      const original = stream[name]
      if (typeof original !== 'function') continue
      stream[name] = function (event, listener, ...args) {
        if (typeof listener !== 'function') return original.call(this, event, listener, ...args)
        const escaped = function (...values) { return local.exit(() => listener.apply(this, values)) }
        listeners.set(listener, escaped)
        return original.call(this, event, escaped, ...args)
      }
    }
    for (const name of ['off', 'removeListener']) {
      const original = stream[name]
      if (typeof original === 'function') stream[name] = function (event, listener, ...args) { return original.call(this, event, listeners.get(listener) || listener, ...args) }
    }
  }
  const install = () => {
    if (state.installed) return
    replace(fs, 'readFileSync', original => function (path, ...args) { if (fd(path)) { unsupported('readFileSync', 'numeric file descriptor'); return original.call(this, path, ...args) } return local.run(true, () => { const result = original.call(this, path, ...args); body('readFileSync', path, result); return result }) })
    replace(fs, 'readFile', original => function (path, options, callback) { if (fd(path)) { unsupported('readFile', 'numeric file descriptor'); return original.apply(this, arguments) } const cb = typeof options === 'function' ? options : callback; const opts = typeof options === 'function' ? undefined : options; return local.run(true, () => original.call(this, path, opts, (error, result) => { if (!error) body('readFile', path, result); local.exit(() => cb(error, result)) })) })
    replace(fsp, 'readFile', original => async function (path, ...args) { if (fd(path)) { unsupported('readFilePromise', 'numeric file descriptor'); return original.call(this, path, ...args) } return local.run(true, async () => { const result = await original.call(this, path, ...args); body('readFilePromise', path, result); return result }) })
    replace(fs, 'writeFileSync', original => function (...args) { return local.run(true, () => original.apply(this, args)) })
    replace(fs, 'createReadStream', original => function (path, ...args) { if (fd(path) || fd(args[0]?.fd)) { unsupported('createReadStream', 'numeric file descriptor'); return original.call(this, path, ...args) } const stream = local.run(true, () => original.call(this, path, ...args)); let total = 0; const push = stream.push; stream.push = function (chunk, ...pushArgs) { if (chunk !== null) total += bytes(chunk); return push.call(this, chunk, ...pushArgs) }; stream.once('end', () => { if (state.active) { api('createReadStream'); const [info, item] = entry('createReadStream', path); item.reads++; item.bytes += total; if (info.body) { item.bodyReads = (item.bodyReads || 0) + 1; state.bodyReads++; state.bodyBytes += total } } }); escapeConsumerListeners(stream); return stream })
    for (const name of syncMeta) replace(fs, name, original => function (path, ...args) { try { return original.call(this, path, ...args) } finally { metadata(name, path) } })
    for (const name of callbackMeta) replace(fs, name, original => function (path, ...args) { const cb = args.pop(); return original.call(this, path, ...args, (...result) => { metadata(name, path); cb(...result) }) })
    for (const name of promiseMeta) replace(fsp, name, original => async function (path, ...args) { try { return await original.call(this, path, ...args) } finally { metadata(`promises.${name}`, path) } })
    for (const name of raw) if (typeof fs[name] === 'function') replace(fs, name, original => function (...args) {
      if (name === 'openSync' && typeof args[1] === 'string' && (args[1].includes('w') || args[1].includes('a'))) {
        return local.run(true, () => original.apply(this, args))
      }
      unsupported(name, 'raw file descriptor operation'); return original.apply(this, args)
    })
    for (const name of ['read', 'readv', 'readFile', 'createReadStream']) if (typeof fileHandlePrototype[name] === 'function') replace(fileHandlePrototype, name, original => function (...args) { unsupported(`FileHandle.${name}`, 'raw FileHandle operation'); return original.apply(this, args) })
    replace(fsp, 'open', original => async function (...args) { unsupported('promises.open', 'raw FileHandle open'); return original.apply(this, args) })
    syncBuiltinESMExports(); state.installed = true
  }
  const restore = () => { while (originals.length) { const [owner, name, original] = originals.pop(); owner[name] = original }; syncBuiltinESMExports(); state.installed = false }
  const snapshot = () => { const byPath = Object.fromEntries(Object.entries(state.byPath).map(([key, value]) => [key, { ...value, apis: { ...value.apis } }])); const values = Object.values(byPath); const sum = field => values.filter(value => value.classification === 'synthetic').reduce((total, value) => total + value[field], 0); return { bodyReads: state.bodyReads, bodyBytes: state.bodyBytes, syntheticReads: sum('reads'), syntheticBytes: sum('bytes'), uniqueBodyFiles: values.filter(value => value.bodyReads > 0).length, metadataOps: state.metadataOps, byApi: { ...state.byApi }, byPath, unsupported: state.unsupported.map(value => ({ ...value })) } }
  return { start() { if (state.active) throw new Error('IO meter already active'); state.bodyReads = 0; state.bodyBytes = 0; state.metadataOps = 0; state.byApi = {}; state.byPath = {}; state.unsupported = []; install(); state.active = true }, stop() { const result = snapshot(); state.active = false; restore(); return result }, restore() { state.active = false; restore() } }
}
