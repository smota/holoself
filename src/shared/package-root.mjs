// Root directory of the installed holoself package (contribs, templates, skills).
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
