import './helpers/isolated-config.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  ensureCatalogPartition,
  contextData,
  buildIndex,
  searchIndex,
  ecosystemValidationErrors,
  policyProvenanceSummary,
  resolveDocumentPolicy,
  validatePolicyDefaultsObject,
  discoverPolicyFiles
} from '../src/ecosystem.mjs';
import { isPartitionFresh } from '../src/catalog/partitions.mjs';
import { canonicalFiles } from '../src/markdown/files.mjs';
import { loadLensRegistry } from '../src/lenses.mjs';
import { readDocument, listDocuments, saveAnnotatedDocument } from '../src/documents.mjs';
import { planPolicyMigration, verifyNonAmplification } from '../src/migration.mjs';
import { frontmatter as parseFrontmatter } from '../src/policy/privacy-fields.mjs';
import { analysis } from '../src/proposals/analysis.mjs';

const CLI = path.resolve('bin/holoself.mjs');

function makeTempDir(prefix = 'holoself-policy-defaults-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, options = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...options
  });
}

function initDataRoot({ root }) {
  runCli(['init', '--root', root]);
}

function buildSelfCatalog(root) {
  const registry = loadLensRegistry(root);
  const files = canonicalFiles(root, { includeHistory: true });
  return ensureCatalogPartition('self', root, files, registry).catalog;
}

function checkSelfFresh(catalog, root) {
  const registry = loadLensRegistry(root);
  const files = canonicalFiles(root, { includeHistory: true });
  return isPartitionFresh(catalog, root, files, registry, null, 'self');
}

test('inheritance from _policy.yaml and per-field frontmatter override precedence', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const contextDir = path.join(root, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, '_policy.yaml'), [
    'access_lenses: [professional, technical, private]',
    'disclosure: review-required',
    'sensitivity: personal',
    'document_role: content',
    'read_scope: local',
    'confidence: medium'
  ].join('\n') + '\n', 'utf8');

  // 1. Document with no frontmatter at all inherits all policy fields
  fs.writeFileSync(path.join(contextDir, 'bare.md'), '# Bare Context\n\nInherited content body.\n', 'utf8');

  // 2. Document with partial frontmatter overrides only specified fields (including explicit widening)
  fs.writeFileSync(path.join(contextDir, 'override.md'), [
    '---',
    'access_lenses: [general, professional, public-voice, private]',
    'disclosure: publish-approved',
    'read_scope: shared',
    '---',
    '# Override Context',
    '',
    'Explicitly widened content body.'
  ].join('\n') + '\n', 'utf8');

  const catalog = buildSelfCatalog(root);
  const bare = catalog.sources.find((s) => s.file === 'context/bare.md');
  const override = catalog.sources.find((s) => s.file === 'context/override.md');

  assert.ok(bare, 'bare.md should be included in catalog.sources via _policy.yaml defaults');
  assert.deepEqual(bare.frontmatter.access_lenses, ['professional', 'technical', 'private']);
  assert.equal(bare.frontmatter.disclosure, 'review-required');
  assert.equal(bare.frontmatter.sensitivity, 'personal');
  assert.equal(bare.frontmatter.document_role, 'content');
  assert.equal(bare.frontmatter.read_scope, 'local');
  assert.equal(bare.frontmatter.confidence, 'medium');
  assert.deepEqual(bare.policy_sources, {
    access_lenses: 'policy:context/_policy.yaml',
    confidence: 'policy:context/_policy.yaml',
    disclosure: 'policy:context/_policy.yaml',
    document_role: 'policy:context/_policy.yaml',
    read_scope: 'policy:context/_policy.yaml',
    sensitivity: 'policy:context/_policy.yaml'
  });

  assert.ok(override, 'override.md should be included with frontmatter overrides');
  assert.deepEqual(override.frontmatter.access_lenses, ['general', 'professional', 'public-voice', 'private']);
  assert.equal(override.frontmatter.disclosure, 'publish-approved');
  assert.equal(override.frontmatter.sensitivity, 'personal');
  assert.equal(override.frontmatter.document_role, 'content');
  assert.equal(override.frontmatter.read_scope, 'shared');
  assert.equal(override.frontmatter.confidence, 'medium');
  assert.deepEqual(override.policy_sources, {
    access_lenses: 'frontmatter',
    confidence: 'policy:context/_policy.yaml',
    disclosure: 'frontmatter',
    document_role: 'policy:context/_policy.yaml',
    read_scope: 'frontmatter',
    sensitivity: 'policy:context/_policy.yaml'
  });

  assert.equal(ecosystemValidationErrors(root).length, 0);
});

test('nested _policy.yaml replaces parent defaults field-by-field without merging lists and never resolves above self root', () => {
  const parentWrapper = makeTempDir('holoself-outer-');
  // Place a stray _policy.yaml above the self root to verify containment
  fs.writeFileSync(path.join(parentWrapper, '_policy.yaml'), [
    'access_lenses: [general]',
    'disclosure: publish-approved',
    'sensitivity: public',
    'document_role: policy'
  ].join('\n') + '\n', 'utf8');

  const root = path.join(parentWrapper, 'self-root');
  initDataRoot({ root });

  // Untracked file in history/ with no _policy.yaml in root or history/ must NOT inherit from parentWrapper/_policy.yaml
  fs.writeFileSync(path.join(root, 'history', 'untagged.md'), '# Untagged\n\nShould not inherit above root.\n', 'utf8');

  const contextDir = path.join(root, 'context');
  const subDir = path.join(contextDir, 'architecture', 'deep');
  fs.mkdirSync(subDir, { recursive: true });

  fs.writeFileSync(path.join(contextDir, '_policy.yaml'), [
    'access_lenses: [professional, technical, leadership, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content',
    'task_include: [architecture, design]'
  ].join('\n') + '\n', 'utf8');

  // Nested policy in context/architecture/ replaces access_lenses and sensitivity, keeps disclosure/document_role/task_include
  fs.writeFileSync(path.join(contextDir, 'architecture', '_policy.yaml'), [
    'access_lenses: [technical, private]',
    'sensitivity: employer-confidential'
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(subDir, 'adr.md'), '# ADR\n\nDeep nested document.\n', 'utf8');

  const catalog = buildSelfCatalog(root);
  const untaggedIgnored = catalog.ignored_sources.find((s) => s.file === 'history/untagged.md');
  assert.ok(untaggedIgnored, 'history/untagged.md must be ignored and not inherit from _policy.yaml above self root');

  const adr = catalog.sources.find((s) => s.file === 'context/architecture/deep/adr.md');
  assert.ok(adr);
  // Replaced, not merged with professional/leadership
  assert.deepEqual(adr.frontmatter.access_lenses, ['technical', 'private']);
  assert.equal(adr.frontmatter.sensitivity, 'employer-confidential');
  // Retained from parent context/_policy.yaml
  assert.equal(adr.frontmatter.disclosure, 'internal-only');
  assert.equal(adr.frontmatter.document_role, 'content');
  assert.deepEqual(adr.frontmatter.task_include, ['architecture', 'design']);
  assert.deepEqual(adr.policy_sources, {
    access_lenses: 'policy:context/architecture/_policy.yaml',
    disclosure: 'policy:context/_policy.yaml',
    document_role: 'policy:context/_policy.yaml',
    sensitivity: 'policy:context/architecture/_policy.yaml',
    task_include: 'policy:context/_policy.yaml'
  });
});

test('fail-closed on malformed YAML, unknown keys, disallowed lifecycle keys, and symlinked _policy.yaml', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  // 1. Unknown key in context/unknown/_policy.yaml
  const unknownDir = path.join(root, 'context', 'unknown');
  fs.mkdirSync(unknownDir, { recursive: true });
  fs.writeFileSync(path.join(unknownDir, '_policy.yaml'), [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content',
    'unknown_key: foo'
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(unknownDir, 'doc.md'), '# Doc under unknown key policy\n', 'utf8');

  // 2. Disallowed per-document lifecycle key (superseded_by / valid_until) in context/disallowed/_policy.yaml
  const disallowedDir = path.join(root, 'context', 'disallowed');
  fs.mkdirSync(disallowedDir, { recursive: true });
  fs.writeFileSync(path.join(disallowedDir, '_policy.yaml'), [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content',
    'superseded_by: context/other.md',
    'valid_until: 2027-01-01'
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(disallowedDir, 'doc.md'), '# Doc under disallowed key policy\n', 'utf8');

  // 3. Malformed YAML in context/malformed/_policy.yaml
  const malformedDir = path.join(root, 'context', 'malformed');
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, '_policy.yaml'), 'access_lenses: [unclosed\n: bad yaml\n', 'utf8');
  fs.writeFileSync(path.join(malformedDir, 'doc.md'), '# Doc under malformed policy\n', 'utf8');

  // 4. Symlinked _policy.yaml in context/symlinked/_policy.yaml
  const symlinkDir = path.join(root, 'context', 'symlinked');
  fs.mkdirSync(symlinkDir, { recursive: true });
  const outsidePolicy = path.join(os.tmpdir(), `outside-policy-${Date.now()}.yaml`);
  fs.writeFileSync(outsidePolicy, [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsidePolicy, path.join(symlinkDir, '_policy.yaml'));
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }
  fs.writeFileSync(path.join(symlinkDir, 'doc.md'), '# Doc under symlinked policy\n', 'utf8');

  // 5. Document with full valid frontmatter under malformed policy still keeps its own frontmatter
  fs.writeFileSync(path.join(malformedDir, 'self-contained.md'), [
    '---',
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content',
    '---',
    '# Self-contained doc'
  ].join('\n') + '\n', 'utf8');

  const catalog = buildSelfCatalog(root);
  for (const rel of ['context/unknown/doc.md', 'context/disallowed/doc.md', 'context/malformed/doc.md']) {
    assert.ok(!catalog.sources.some((s) => s.file === rel), `${rel} must not be included in catalog.sources`);
    const ignored = catalog.ignored_sources.find((s) => s.file === rel);
    assert.ok(ignored, `${rel} must fail closed into ignored_sources when _policy.yaml is invalid`);
    assert.match(ignored.reason, /missing access_lenses/);
  }
  if (symlinkCreated) {
    const symIgnored = catalog.ignored_sources.find((s) => s.file === 'context/symlinked/doc.md');
    assert.ok(symIgnored, 'symlinked _policy.yaml must fail closed');
  }

  const selfContained = catalog.sources.find((s) => s.file === 'context/malformed/self-contained.md');
  assert.ok(selfContained, 'document with complete own frontmatter keeps its own frontmatter');

  const errors = ecosystemValidationErrors(root);
  assert.ok(errors.some((e) => e.includes('context/unknown/_policy.yaml') && e.includes('unknown_key')));
  assert.ok(errors.some((e) => e.includes('context/disallowed/_policy.yaml') && e.includes('superseded_by')));
  assert.ok(errors.some((e) => e.includes('context/malformed/_policy.yaml')));
  if (symlinkCreated) {
    assert.ok(errors.some((e) => e.includes('context/symlinked/_policy.yaml') && e.includes('symlink')));
  }
  for (const err of errors) {
    assert.ok(!err.includes(root), `Validation error must not leak absolute root path: ${err}`);
  }
});

test('policy cannot grant restricted sensitivity or read_scope to non-private lenses', () => {
  // Direct validation unit checks
  const errSensitivity = validatePolicyDefaultsObject({
    access_lenses: ['professional', 'private'],
    disclosure: 'internal-only',
    sensitivity: 'restricted',
    document_role: 'content'
  });
  assert.ok(errSensitivity.some((e) => e.includes('restricted') && e.includes('private')));

  const errReadScope = validatePolicyDefaultsObject({
    access_lenses: ['technical', 'private'],
    disclosure: 'internal-only',
    sensitivity: 'personal',
    document_role: 'content',
    read_scope: 'restricted'
  });
  assert.ok(errReadScope.some((e) => e.includes('restricted') && e.includes('private')));

  const errPublishConfidential = validatePolicyDefaultsObject({
    access_lenses: ['public-voice', 'private'],
    disclosure: 'publish-approved',
    sensitivity: 'employer-confidential',
    document_role: 'content'
  });
  assert.ok(errPublishConfidential.some((e) => e.includes('publish-approved')));

  // Cross-level combination: parent sets access_lenses: [professional, private], child sets sensitivity: restricted
  const root = makeTempDir();
  initDataRoot({ root });
  const parentDir = path.join(root, 'context');
  const childDir = path.join(parentDir, 'secret');
  fs.mkdirSync(childDir, { recursive: true });

  fs.writeFileSync(path.join(parentDir, '_policy.yaml'), [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(childDir, '_policy.yaml'), 'sensitivity: restricted\n', 'utf8');
  fs.writeFileSync(path.join(childDir, 'note.md'), '# Secret note\n', 'utf8');

  const catalog = buildSelfCatalog(root);
  assert.ok(!catalog.sources.some((s) => s.file === 'context/secret/note.md'));
  const noteIgnored = catalog.ignored_sources.find((s) => s.file === 'context/secret/note.md');
  assert.ok(noteIgnored, 'Cross-level restricted + non-private lens combination must fail closed');

  const errors = ecosystemValidationErrors(root);
  assert.ok(errors.some((e) => e.includes('context/secret/_policy.yaml') && e.includes('restricted')));
});

test('catalog partition freshness invalidates when _policy.yaml is added, modified, or deleted', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const subDir = path.join(root, 'context', 'memos');
  fs.mkdirSync(subDir, { recursive: true });
  const docPath = path.join(subDir, 'memo.md');
  fs.writeFileSync(docPath, '# Memo\n\nBody text without frontmatter.\n', 'utf8');

  // Initial build without _policy.yaml: memo.md is ignored
  const cat1 = buildSelfCatalog(root);
  assert.ok(cat1.ignored_sources.some((s) => s.file === 'context/memos/memo.md'));
  assert.equal(checkSelfFresh(cat1, root), true);

  // Add _policy.yaml without touching memo.md
  const policyPath = path.join(subDir, '_policy.yaml');
  fs.writeFileSync(policyPath, [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');

  assert.equal(checkSelfFresh(cat1, root), false, 'Adding _policy.yaml must invalidate partition freshness');

  const cat2 = buildSelfCatalog(root);
  const memo2 = cat2.sources.find((s) => s.file === 'context/memos/memo.md');
  assert.ok(memo2);
  assert.deepEqual(memo2.frontmatter.access_lenses, ['professional', 'private']);
  assert.equal(checkSelfFresh(cat2, root), true);

  // Modify _policy.yaml without touching memo.md
  fs.writeFileSync(policyPath, [
    'access_lenses: [technical, private]',
    'disclosure: review-required',
    'sensitivity: employer-confidential',
    'document_role: evidence'
  ].join('\n') + '\n', 'utf8');

  assert.equal(checkSelfFresh(cat2, root), false, 'Modifying _policy.yaml must invalidate partition freshness');

  const cat3 = buildSelfCatalog(root);
  const memo3 = cat3.sources.find((s) => s.file === 'context/memos/memo.md');
  assert.ok(memo3);
  assert.deepEqual(memo3.frontmatter.access_lenses, ['technical', 'private']);
  assert.equal(memo3.frontmatter.disclosure, 'review-required');
  assert.equal(memo3.frontmatter.sensitivity, 'employer-confidential');
  assert.equal(memo3.frontmatter.document_role, 'evidence');

  // Remove _policy.yaml
  fs.unlinkSync(policyPath);
  assert.equal(checkSelfFresh(cat3, root), false, 'Removing _policy.yaml must invalidate partition freshness');

  const cat4 = buildSelfCatalog(root);
  assert.ok(cat4.ignored_sources.some((s) => s.file === 'context/memos/memo.md'), 'Removing _policy.yaml must re-evaluate memo.md as missing metadata');
});

test('provenance in validate, catalog, Workbench, and owner-direct context_receipt, and omitted from linked callers; _policy.yaml never delivered', async () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const subDir = path.join(root, 'context', 'plans');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, '_policy.yaml'), [
    'access_lenses: [professional, technical, private]',
    'disclosure: review-required',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(subDir, 'roadmap.md'), [
    '---',
    'schema_version: 1',
    'document_role: evidence',
    '---',
    '# Roadmap Architecture',
    '',
    'Unique roadmap milestone token ZETA_POLICY_73.'
  ].join('\n') + '\n', 'utf8');

  // 1. Validate CLI output includes [policy] provenance summary
  const validateOut = runCli(['validate', '--root', root]);
  assert.match(validateOut, /\[policy\] context\/plans\/roadmap\.md:.*access_lenses=policy:context\/plans\/_policy\.yaml/);
  assert.match(validateOut, /document_role=frontmatter/);

  const summaryLines = policyProvenanceSummary(root);
  assert.ok(summaryLines.some((line) => line.includes('context/plans/roadmap.md:') && line.includes('policy:context/plans/_policy.yaml')));

  // 2. _policy.yaml is never in catalog.sources, context sources, or search results
  const catalog = buildSelfCatalog(root);
  assert.ok(!catalog.sources.some((s) => s.file.endsWith('_policy.yaml')), '_policy.yaml must never be indexed in catalog.sources');

  // 3. Owner-direct context packet includes context_receipt.policy_sources, and omits policy_sources from sources[]
  const ownerCtx = JSON.parse(runCli([
    'context',
    '--root', root,
    '--lens', 'professional',
    '--task', 'roadmap architecture ZETA_POLICY_73',
    '--budget', 'standard',
    '--format', 'json'
  ], { cwd: root }));
  assert.ok(ownerCtx.context_receipt.policy_sources, 'Owner-direct context_receipt must include policy_sources');
  assert.deepEqual(ownerCtx.context_receipt.policy_sources['context/plans/roadmap.md'], {
    access_lenses: 'policy:context/plans/_policy.yaml',
    disclosure: 'policy:context/plans/_policy.yaml',
    document_role: 'frontmatter',
    sensitivity: 'policy:context/plans/_policy.yaml'
  });
  for (const src of ownerCtx.sources) {
    assert.ok(!('policy_sources' in src), 'sources[] entries must not expose policy_sources directly');
    assert.ok(!String(src.path || '').endsWith('_policy.yaml'));
  }

  // 4. Linked project caller MUST NOT receive policy_sources in context_receipt, and search never delivers _policy.yaml
  const projectDir = makeTempDir('holoself-linked-proj-');
  runCli([
    'link', 'add',
    '--project', projectDir,
    '--self', root,
    '--lens', 'professional',
    '--secondary-lenses', 'technical',
    '--no-mcp',
    '--no-hooks',
    '--yes'
  ]);

  const idx = buildIndex(projectDir);
  assert.ok(!idx.entries.some((e) => String(e.file || '').endsWith('_policy.yaml')), '_policy.yaml must never be in search index');
  const searchRes = searchIndex(idx, 'review-required ZETA_POLICY_73', 'professional');
  assert.ok(!(searchRes.results || []).some((r) => String(r.file || r.path || '').includes('_policy.yaml')), '_policy.yaml must never appear in search results');

  const linkedCtx = contextData({
    project: projectDir,
    lens: 'professional',
    task: 'roadmap architecture ZETA_POLICY_73',
    budget: 'standard'
  });
  assert.equal('policy_sources' in (linkedCtx.context_receipt || {}), false, 'Linked caller context_receipt must NOT expose policy_sources');

  // 5. Workbench readDocument / listDocuments / saveAnnotatedDocument
  const docView = readDocument(root, 'context/plans/roadmap.md');
  assert.deepEqual(docView.annotations.metadata, { schema_version: 1, document_role: 'evidence' });
  assert.deepEqual(docView.effective_policy, {
    schema_version: 1,
    access_lenses: ['professional', 'technical', 'private'],
    disclosure: 'review-required',
    sensitivity: 'personal',
    document_role: 'evidence'
  });
  assert.deepEqual(docView.policy_sources, {
    access_lenses: 'policy:context/plans/_policy.yaml',
    disclosure: 'policy:context/plans/_policy.yaml',
    document_role: 'frontmatter',
    sensitivity: 'policy:context/plans/_policy.yaml'
  });

  const docsList = listDocuments(root);
  const roadmapItem = docsList.find((d) => d.path === 'context/plans/roadmap.md');
  assert.ok(roadmapItem);
  assert.deepEqual(roadmapItem.policy_sources, docView.policy_sources);

  // Saving from Workbench with only frontmatter override writes frontmatter only (does not copy inherited defaults into file)
  await saveAnnotatedDocument(
    root,
    'context/plans/roadmap.md',
    {
      expectedHash: docView.hash,
      metadata: { schema_version: 1, document_role: 'content' },
      segments: docView.annotations.segments
    },
    { knownLenses: ['general', 'professional', 'public-voice', 'technical', 'leadership', 'interview', 'private'] }
  );
  const savedRaw = fs.readFileSync(path.join(subDir, 'roadmap.md'), 'utf8');
  const parsedSaved = parseFrontmatter(savedRaw);
  assert.deepEqual({ ...parsedSaved.metadata }, { schema_version: 1, document_role: 'content' }, 'saveAnnotatedDocument must write only document frontmatter');
});

test('Windows path handling normalizes backslashes in policy provenance and relPath', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const subDir = path.join(root, 'topics', 'win-sub');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, '_policy.yaml'), [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(subDir, 'item.md'), '# Item\n', 'utf8');

  const resolved = resolveDocumentPolicy('topics\\win-sub\\item.md', root, {});
  assert.equal(resolved.policyErrors.length, 0);
  assert.equal(resolved.policySources.access_lenses, 'policy:topics/win-sub/_policy.yaml');

  const discovered = discoverPolicyFiles(root);
  assert.ok(discovered.some((entry) => entry.file === 'topics/win-sub/_policy.yaml'));
  for (const entry of discovered) {
    assert.ok(!entry.file.includes('\\'), `Discovered policy path must use forward slashes: ${entry.file}`);
  }
});

test('migrate policy respects _policy.yaml defaults and preserves verifyNonAmplification', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const topicsDir = path.join(root, 'topics');
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.writeFileSync(path.join(topicsDir, '_policy.yaml'), [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');

  // File with minimal frontmatter covered by _policy.yaml should not need migration (governed by directory policy)
  fs.writeFileSync(path.join(topicsDir, 'governed.md'), [
    '---',
    'document_role: evidence',
    '---',
    '# Governed by directory policy'
  ].join('\n') + '\n', 'utf8');

  // File with legacy visibility: private in context/ (no _policy.yaml) should still be planned for migration
  fs.writeFileSync(path.join(root, 'context', 'legacy.md'), [
    '---',
    'visibility: private',
    '---',
    '# Legacy'
  ].join('\n') + '\n', 'utf8');

  const plan = planPolicyMigration(root, { dryRun: true });
  const governedEntry = plan.entries.find((f) => f.path === 'topics/governed.md');
  assert.ok(governedEntry);
  assert.equal(governedEntry.needs_migration, false);
  const nonAmp = verifyNonAmplification(governedEntry.before_metadata, governedEntry.after_metadata);
  assert.ok(nonAmp);

  const legacyEntry = plan.entries.find((f) => f.path === 'context/legacy.md');
  assert.ok(legacyEntry);
  assert.equal(legacyEntry.needs_migration, true);
});

test('legacy visibility and public_safe documents skip directory policy defaults without widening and report policy_skipped', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const contextDir = path.join(root, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, '_policy.yaml'), [
    'access_lenses: [general, professional, public-voice, technical, private]',
    'exclude_lenses: [leadership]',
    'disclosure: publish-approved',
    'sensitivity: personal',
    'document_role: content',
    'read_scope: shared'
  ].join('\n') + '\n', 'utf8');

  // 1. visibility: private under permissive _policy.yaml (read_scope: shared, access_lenses including general)
  fs.writeFileSync(path.join(contextDir, 'legacy-private.md'), [
    '---',
    'visibility: private',
    '---',
    '# Legacy Private',
    '',
    'Must never leak to general lens LEGACY_PRIV_TOKEN.'
  ].join('\n') + '\n', 'utf8');

  // 2. visibility: professional (with exclude_lenses: [general] and bare) under permissive _policy.yaml
  fs.writeFileSync(path.join(contextDir, 'legacy-prof.md'), [
    '---',
    'visibility: professional',
    'exclude_lenses: [general]',
    '---',
    '# Legacy Professional',
    '',
    'Must not leak to general or public-voice lens LEGACY_PROF_TOKEN.'
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(contextDir, 'legacy-prof-bare.md'), [
    '---',
    'visibility: professional',
    '---',
    '# Legacy Professional Bare',
    '',
    'Must not inherit public-voice or technical from policy LEGACY_PROF_BARE_TOKEN.'
  ].join('\n') + '\n', 'utf8');

  // 3. public_safe: false under publish-approved _policy.yaml
  fs.writeFileSync(path.join(contextDir, 'legacy-public-safe.md'), [
    '---',
    'visibility: private',
    'public_safe: false',
    '---',
    '# Legacy Public Safe',
    '',
    'Must not inherit policy defaults LEGACY_PUBSAFE_TOKEN.'
  ].join('\n') + '\n', 'utf8');

  // 4. Modern document with explicit exclude_lenses: [] overrides policy exclude_lenses: [leadership]
  fs.writeFileSync(path.join(contextDir, 'modern-unexcluded.md'), [
    '---',
    'exclude_lenses: []',
    '---',
    '# Modern Unexcluded',
    '',
    'Explicit empty exclude_lenses widens leadership MODERN_UNEXCLUDED_TOKEN.'
  ].join('\n') + '\n', 'utf8');

  const catalog = buildSelfCatalog(root);
  const privEntry = catalog.sources.find((s) => s.file === 'context/legacy-private.md');
  assert.ok(privEntry);
  assert.deepEqual(privEntry.frontmatter.access_lenses, ['private']);
  assert.equal(privEntry.frontmatter.read_scope, 'restricted');
  assert.equal(privEntry.frontmatter.disclosure, 'internal-only');
  assert.deepEqual(privEntry.policy_sources, {
    policy_skipped: 'legacy-visibility',
    visibility: 'frontmatter'
  });

  const profEntry = catalog.sources.find((s) => s.file === 'context/legacy-prof.md');
  assert.ok(profEntry);
  assert.deepEqual(profEntry.frontmatter.access_lenses, ['general', 'professional', 'interview', 'private']);
  assert.deepEqual(profEntry.frontmatter.exclude_lenses, ['general']);
  assert.equal(profEntry.frontmatter.disclosure, 'internal-only');
  assert.deepEqual(profEntry.policy_sources, {
    exclude_lenses: 'frontmatter',
    policy_skipped: 'legacy-visibility',
    visibility: 'frontmatter'
  });

  const profBareEntry = catalog.sources.find((s) => s.file === 'context/legacy-prof-bare.md');
  assert.ok(profBareEntry);
  assert.deepEqual(profBareEntry.frontmatter.access_lenses, ['general', 'professional', 'interview', 'private']);
  assert.equal(profBareEntry.frontmatter.disclosure, 'internal-only');
  assert.deepEqual(profBareEntry.policy_sources, {
    policy_skipped: 'legacy-visibility',
    visibility: 'frontmatter'
  });

  const pubSafeEntry = catalog.sources.find((s) => s.file === 'context/legacy-public-safe.md');
  assert.ok(pubSafeEntry);
  assert.equal(pubSafeEntry.frontmatter.disclosure, 'review-required');
  assert.equal(pubSafeEntry.frontmatter.publication_allowed, false);
  assert.deepEqual(pubSafeEntry.policy_sources, {
     policy_skipped: 'legacy-visibility',
    public_safe: 'frontmatter',
    visibility: 'frontmatter'
  });

  // Delivery under general lens must NOT include legacy-private.md or legacy-prof.md
  const generalCtx = JSON.parse(runCli([
    'context',
    '--root', root,
    '--lens', 'general',
    '--task', 'LEGACY_PRIV_TOKEN LEGACY_PROF_TOKEN',
    '--budget', 'standard',
    '--format', 'json'
  ], { cwd: root }));
  const generalPaths = generalCtx.self.documents.map((d) => d.path);
  assert.ok(!generalPaths.includes('context/legacy-private.md'), 'visibility: private must not be delivered under general');
  assert.ok(!generalPaths.includes('context/legacy-prof.md'), 'visibility: professional with exclude_lenses: [general] must not be delivered under general');

  // Delivery under public-voice lens must NOT include legacy-prof-bare.md
  const pubVoiceCtx = JSON.parse(runCli([
    'context',
    '--root', root,
    '--lens', 'public-voice',
    '--task', 'LEGACY_PROF_BARE_TOKEN',
    '--budget', 'standard',
    '--format', 'json'
  ], { cwd: root }));
  const pubVoicePaths = pubVoiceCtx.self.documents.map((d) => d.path);
  assert.ok(!pubVoicePaths.includes('context/legacy-prof-bare.md'), 'visibility: professional must not inherit public-voice from policy');

  // Modern document with exclude_lenses: [] overrides policy exclude_lenses: [leadership]
  const modernEntry = catalog.sources.find((s) => s.file === 'context/modern-unexcluded.md');
  assert.ok(modernEntry);
  assert.deepEqual(modernEntry.frontmatter.exclude_lenses, []);
  assert.equal(modernEntry.policy_sources.exclude_lenses, 'frontmatter');

  // Validate CLI reports policy_skipped=legacy-visibility
  const validateOut = runCli(['validate', '--root', root]);
  assert.match(validateOut, /\[policy\] context\/legacy-private\.md:.*policy_skipped=legacy-visibility/);
  assert.match(validateOut, /\[policy\] context\/legacy-prof\.md:.*policy_skipped=legacy-visibility/);
});

test('analysis passes self to createRecordDelivery so policy defaults apply during delivery', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const contextDir = path.join(root, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, '_policy.yaml'), [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');

  // Self document with partial frontmatter (only document_role), relying on _policy.yaml for access_lenses/disclosure/sensitivity
  const sharedBody = '# Architecture Playbook\n\nWe use event-driven projections with 99.9% uptime guarantees.\n';
  fs.writeFileSync(path.join(contextDir, 'playbook.md'), [
    '---',
    'document_role: evidence',
    '---',
    sharedBody.trim()
  ].join('\n') + '\n', 'utf8');

  // Restricted directory where _policy.yaml excludes private via task_include or invalid policy fails closed
  const brokenDir = path.join(contextDir, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, '_policy.yaml'), 'unknown_key: bad\n', 'utf8');
  fs.writeFileSync(path.join(brokenDir, 'incomplete.md'), [
    '---',
    'document_role: evidence',
    '---',
    '# Incomplete Doc',
    '',
    'Should be rejected by delivery because _policy.yaml is invalid.'
  ].join('\n') + '\n', 'utf8');

  const projectDir = makeTempDir('holoself-analysis-proj-');
  fs.writeFileSync(path.join(projectDir, 'playbook-copy.md'), sharedBody, 'utf8');
  runCli([
    'link', 'add',
    '--project', projectDir,
    '--self', root,
    '--lens', 'professional',
    '--project-include', '**/*.md',
    '--no-mcp',
    '--no-hooks',
    '--yes'
  ]);

  const report = analysis(projectDir);
  const dup = report.findings.find(
    (f) => f.classification === 'Exact duplicate' && f.self_file === 'context/playbook.md' && f.project_file === 'playbook-copy.md'
  );
  assert.ok(dup, 'analysis must deliver canonical doc governed by _policy.yaml and detect duplicate');
  assert.ok(!report.findings.some((f) => f.self_file === 'context/broken/incomplete.md'));
});

test('documents.mjs loads lens registry so unregistered lenses in _policy.yaml fail closed like catalog', async () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const topicsDir = path.join(root, 'topics');
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.writeFileSync(path.join(topicsDir, '_policy.yaml'), [
    'access_lenses: [unregistered-lens, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');

  const docPath = path.join(topicsDir, 'note.md');
  fs.writeFileSync(docPath, [
    '---',
    'schema_version: 1',
    'document_role: evidence',
    '---',
    '# Note'
  ].join('\n') + '\n', 'utf8');

  // Catalog rejects unregistered-lens in _policy.yaml
  const catalog = buildSelfCatalog(root);
  assert.ok(!catalog.sources.some((s) => s.file === 'topics/note.md'));

  // readDocument and listDocuments also reject unregistered-lens in _policy.yaml (no inherited defaults)
  const doc = readDocument(root, 'topics/note.md');
  assert.deepEqual(doc.policy_defaults, {});
  assert.deepEqual(doc.effective_policy, { schema_version: 1, document_role: 'evidence' });
  assert.deepEqual(doc.policy_sources, { document_role: 'frontmatter' });

  const listed = listDocuments(root).find((d) => d.path === 'topics/note.md');
  assert.ok(listed);
  assert.deepEqual(listed.policy_sources, { document_role: 'frontmatter' });

  // saveAnnotatedDocument rejects saving incomplete metadata when _policy.yaml has an unregistered lens
  await assert.rejects(
    () =>
      saveAnnotatedDocument(
        root,
        'topics/note.md',
        {
          expectedHash: doc.hash,
          metadata: { schema_version: 1, document_role: 'evidence' },
          segments: doc.annotations.segments
        },
        { knownLenses: ['general', 'professional', 'public-voice', 'technical', 'leadership', 'interview', 'private'] }
      ),
    /Select at least one Access Lens|access_lenses/
  );
});

test('BOM-prefixed _policy.yaml is parsed after stripping leading UTF-8 BOM while real YAML errors still fail closed', () => {
  const root = makeTempDir();
  initDataRoot({ root });

  const contextDir = path.join(root, 'context', 'bom');
  fs.mkdirSync(contextDir, { recursive: true });
  const bomPolicy = '\uFEFF' + [
    'access_lenses: [professional, private]',
    'disclosure: internal-only',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(contextDir, '_policy.yaml'), bomPolicy, 'utf8');
  fs.writeFileSync(path.join(contextDir, 'doc.md'), '# BOM Policy Doc\n\nContent.\n', 'utf8');

  const badBomDir = path.join(root, 'context', 'bom-bad');
  fs.mkdirSync(badBomDir, { recursive: true });
  fs.writeFileSync(path.join(badBomDir, '_policy.yaml'), '\uFEFFaccess_lenses: [unclosed\n: invalid\n', 'utf8');
  fs.writeFileSync(path.join(badBomDir, 'doc.md'), '# Bad BOM Policy Doc\n', 'utf8');

  const catalog = buildSelfCatalog(root);
  const goodDoc = catalog.sources.find((s) => s.file === 'context/bom/doc.md');
  assert.ok(goodDoc, 'BOM-prefixed valid _policy.yaml must be accepted');
  assert.deepEqual(goodDoc.frontmatter.access_lenses, ['professional', 'private']);

  assert.ok(!catalog.sources.some((s) => s.file === 'context/bom-bad/doc.md'), 'BOM-prefixed malformed _policy.yaml must still fail closed');
  const errors = ecosystemValidationErrors(root);
  assert.ok(!errors.some((e) => e.includes('context/bom/_policy.yaml')));
  assert.ok(errors.some((e) => e.includes('context/bom-bad/_policy.yaml')));
});

test('migrate policy judges AFTER with inherited _policy.yaml defaults: removing visibility cannot widen through inheritance', () => {
  const root = makeTempDir();
  initDataRoot({ root });
  const contextDir = path.join(root, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, '_policy.yaml'), [
    'access_lenses: [general, private]',
    'read_scope: shared',
    'disclosure: publish-approved',
    'sensitivity: personal',
    'document_role: content'
  ].join('\n') + '\n', 'utf8');
  const docRel = 'context/legacy-secret.md';
  const before = '---\nvisibility: private\n---\n# Secret\n';
  fs.writeFileSync(path.join(root, docRel), before, 'utf8');
  const opts = { selfRoot: root, docPath: docRel };

  // Replacing visibility with explicit fields but leaving access_lenses to inheritance grants general: refused.
  const inheritsLenses = '---\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Secret\n';
  const r1 = verifyNonAmplification(before, inheritsLenses, opts);
  assert.equal(r1.valid, false);
  assert.match(r1.violation, /DENY -> ALLOW/);

  // Explicit private lenses but disclosure left to inheritance (publish-approved): only visible with inheritance.
  const inheritsDisclosure = '---\naccess_lenses: [private]\nread_scope: restricted\nsensitivity: personal\ndocument_role: content\n---\n# Secret\n';
  assert.equal(verifyNonAmplification(before, inheritsDisclosure).valid, true, 'frontmatter-only view misses the inherited widening');
  const r2 = verifyNonAmplification(before, inheritsDisclosure, opts);
  assert.equal(r2.valid, false);
  assert.match(r2.violation, /obsidian-public|public|Publication gate/);
  assert.match(r2.violation, /DENY -> ALLOW/);

  // Fully self-describing replacement: nothing left for the policy to widen.
  const explicit = '---\naccess_lenses: [private]\nread_scope: restricted\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Secret\n';
  const r3 = verifyNonAmplification(before, explicit, opts);
  assert.equal(r3.valid, true);
  assert.deepEqual(r3.coverageLoss, {});

  // The plan writes all four required fields plus read_scope, so the document stays private even if a later
  // edit removes legacy visibility and turns policy inheritance on.
  const plan = planPolicyMigration(root, { dryRun: true });
  assert.equal(plan.summary.non_amplification_verified, true);
  const entry = plan.entries.find((e) => e.path === docRel);
  assert.ok(entry);
  assert.equal(entry.needs_migration, true);
  assert.deepEqual(entry.changes, {
    read_scope: 'restricted',
    access_lenses: ['private'],
    disclosure: 'internal-only',
    sensitivity: 'personal',
    document_role: 'content',
    visibility: null
  });
  assert.deepEqual(entry.after_metadata.access_lenses, ['private']);
  assert.ok(!entry.after_text.includes('visibility:'), 'the plan removes the deprecated field');
  const withoutVisibility = entry.after_text.replace(/^visibility: private\r?\n/m, '');
  assert.ok(!withoutVisibility.includes('visibility:'));
  const effective = resolveDocumentPolicy(docRel, root, parseFrontmatter(withoutVisibility, { tolerant: true }).metadata).effectiveMetadata;
  assert.deepEqual(effective.access_lenses, ['private']);
  assert.equal(effective.read_scope, 'restricted');
  assert.equal(effective.disclosure, 'internal-only');
  assert.equal(verifyNonAmplification(before, withoutVisibility, opts).valid, true);
});

test('migrate policy reports coverage loss when inherited _policy.yaml defaults narrow a migrated document', () => {
  const root = makeTempDir();
  initDataRoot({ root });
  const topicsDir = path.join(root, 'topics');
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.writeFileSync(path.join(topicsDir, '_policy.yaml'), 'read_scope: restricted\naccess_lenses: [private]\n', 'utf8');
  const docRel = 'topics/prof.md';
  const before = '---\nvisibility: professional\n---\n# Professional\n';
  fs.writeFileSync(path.join(root, docRel), before, 'utf8');
  // Visibility replaced by the exact legacy lens mapping; read_scope is left to inheritance (restricted).
  const after = '---\naccess_lenses: [general, professional, interview, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Professional\n';

  assert.deepEqual(verifyNonAmplification(before, after).coverageLoss, {}, 'frontmatter-only mapping is exact');
  const result = verifyNonAmplification(before, after, { selfRoot: root, docPath: docRel });
  assert.equal(result.valid, true);
  for (const lens of ['general', 'professional', 'interview']) {
    assert.ok(result.coverageLoss[lens] > 0, `expected coverage loss for ${lens}`);
  }
  assert.equal(result.coverageLoss.private, undefined);
});
