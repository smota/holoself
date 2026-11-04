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
