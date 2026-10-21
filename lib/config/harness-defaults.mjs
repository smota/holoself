// Shared defaults for scaffolding, projection, and runtime loading.
export const DEFAULT_ORCHESTRATION_MODEL = {
  lifecycle: 'dual-gate',
  preCodeReview: {
    enabled: true,
    gate: 'specification-sparring',
    targetPhases: ['architect', 'implementation-planner'],
    blockingSeverity: ['blocker', 'structural'],
  },
  concurrency: {
    maxWriters: 1,
    maxAdvisors: 3,
    isolatedWorktreeRequired: true,
  },
}

export const DEFAULT_EXECUTION_POLICY = {
  escalation: {
    maxAttemptsPerTier: 2,
    tierProgression: ['balanced', 'deep-reasoning', 'architect-lead'],
    suspendOnRepeatedRejections: 2,
  },
  fallbackCascade: {
    primary: 'external-cli',
    onQuotaExhausted: 'human-gate',
    onSubagentExhausted: 'human-gate',
    recordDegradationInEvidence: true,
  },
}

export const DEFAULT_MODEL_CATALOG = {
  tiers: {
    'architect-lead': {
      capabilities: ['high-context', 'formal-logic', 'deep-reasoning'],
      defaultEffort: 'medium',
      fallbacks: ['antigravity/gemini-4-argon', 'claude-opus-4-6', 'o1'],
      highEffortMaxContextTokens: 30000,
      preferredModel: 'grok-4.7',
      recommended2026Model: 'gpt-6.1-sol',
    },
    'deep-reasoning': {
      capabilities: ['adversarial-audit', 'security-analysis'],
      defaultEffort: 'medium',
      fallbacks: ['antigravity/gemini-3.1-pro', 'claude-opus-4-6', 'o3-mini'],
      highEffortMaxContextTokens: 35000,
      preferredModel: 'grok-4.7',
      recommended2026Model: 'gpt-6-astra',
    },
    balanced: {
      capabilities: ['fast-implementation', 'unit-testing', 'subagent-coordination'],
      defaultEffort: 'medium',
      fallbacks: ['claude-sonnet-4-6', 'gpt-6-astra', 'gpt-4o', 'grok-composer-2.5-fast'],
      highEffortMaxContextTokens: 40000,
      preferredModel: 'claude-sonnet-4-5',
      recommended2026Model: 'antigravity/gemini-4-argon',
    },
    lightweight: {
      capabilities: ['fixtures', 'formatting', 'inventory', 'fast-verification'],
      defaultEffort: 'low',
      fallbacks: [
        'antigravity/gemini-3.8-flash',
        'gpt-5.3-codex-spark',
        'claude-haiku-4-5',
        'claude-haiku-3-5',
        'gpt-4o-mini',
        'd3-flash',
      ],
      highEffortMaxContextTokens: 120000,
      preferredModel: 'grok-fast',
      recommended2026Model: 'antigravity/gemini-3.8-flash',
    },
  },
  roleAssignments: {
    coordinator: 'architect-lead',
    architect: 'architect-lead',
    'adversarial-reviewer': 'deep-reasoning',
    reviewer: 'deep-reasoning',
    developer: 'balanced',
    'developer-jr': 'lightweight',
    tester: 'deep-reasoning',
    'fixture-builder': 'lightweight',
  },
}

export const DEFAULT_HARNESS_PARAMETERS = {
  shellRunner: {
    windowsStrategy: 'cmd-type-stream',
    posixStrategy: 'direct-pipe',
    stdinTimeoutMs: 15000,
  },
  limits: {
    envelopeByteCapKb: 48,
    maxReviewIterations: 12,
    largeFileScriptThresholdLines: 800,
  },
  scratchPath: '.agent-runs/scratch',
}
