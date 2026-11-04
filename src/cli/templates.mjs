// Starter profile and context documents written by holoself init.
import { DEFAULT_LENS_IDS } from '../lenses.mjs'

export const metadata = (access, disclosure = 'internal-only', sensitivity = 'personal', role = 'content') =>
  `---\naccess_lenses: [${access.join(', ')}]\ndisclosure: ${disclosure}\nsensitivity: ${sensitivity}\ndocument_role: ${role}\n---\n`
export const ALL_LENSES = DEFAULT_LENS_IDS
export const PROFILE_FILES = {
  'identity.md': metadata(ALL_LENSES) + '# Identity\n\nWrite a short description of who you are.\n',
  'preferences.md': metadata(ALL_LENSES, 'internal-only', 'personal', 'policy') + '# Preferences\n\nDescribe how you prefer to work with AI tools.\n',
  'voice.md': metadata(ALL_LENSES, 'internal-only', 'personal', 'policy') + '# Voice\n\nDescribe your writing voice.\n',
  'thinking.md': metadata(ALL_LENSES, 'internal-only', 'personal', 'policy') + '# Thinking\n\nDescribe how you reason and make decisions.\n',
  'work-context.md': metadata(ALL_LENSES) + '# Work context\n\nDescribe current work and priorities.\n',
  'change.md': metadata(ALL_LENSES, 'internal-only', 'personal', 'policy') + '# Change compass\n\nDescribe current goals and patterns only if useful.\n'
}
export const CONTEXT_FILES = {
  'projects.md': metadata(['general', 'professional', 'technical', 'leadership', 'private']) + '# Projects\n\nList active projects and their context.\n',
  'people.md': metadata(['general', 'leadership', 'private']) + '# People\n\nRecord useful relationship context with care.\n',
  'decisions.md': metadata(['general', 'professional', 'technical', 'leadership', 'private']) + '# Decisions\n\nRecord decisions, rationale, and date.\n',
  'story-bank.md':
    metadata(['general', 'professional', 'public-voice', 'leadership', 'interview', 'private'], 'review-required', 'personal', 'evidence') +
    '# Story bank\n\nKeep evidence-backed stories and examples.\n',
  'career.md':
    metadata(['general', 'professional', 'public-voice', 'interview', 'private'], 'review-required', 'personal', 'evidence') +
    '# Career\n\nKeep career context and evidence.\n',
  'admin.md': metadata(['general', 'private']) + '# Admin\n\nKeep relevant logistics and recurring details.\n',
  'leadership.md':
    metadata(['general', 'professional', 'public-voice', 'leadership', 'interview', 'private'], 'review-required') +
    '# Leadership\n\nKeep leadership and reflection context.\n',
  'technical.md':
    metadata(['general', 'professional', 'public-voice', 'technical', 'interview', 'private'], 'review-required') +
    '# Technical\n\nKeep technical context, constraints, and preferences.\n',
  'publishing.md':
    metadata(['general', 'public-voice', 'private'], 'internal-only', 'personal', 'policy') +
    '# Publishing\n\nKeep publishing goals, audiences, and format preferences.\n'
}
