// Canonical adapter execution defaults. Consumers import these values rather than copy policy.
export const DEFAULT_PLATFORM_CHAINS = Object.freeze({
  'pm.manager': Object.freeze([
    'pi:grok',
    'pi:antigravity',
    'codex:openai-codex',
    'claude-code:anthropic',
  ]),
  'pm.analyst': Object.freeze([
    'pi:grok',
    'pi:antigravity',
    'codex:openai-codex',
    'claude-code:anthropic',
  ]),
  'orch.arch': Object.freeze(['codex:openai-codex', 'claude-code:anthropic', 'pi:antigravity']),
  'dev.build-jr': Object.freeze([
    'pi:grok',
    'pi:antigravity',
    'codex:openai-codex',
    'claude-code:anthropic',
  ]),
  'dev.build': Object.freeze([
    'pi:antigravity',
    'pi:grok',
    'codex:openai-codex',
    'claude-code:anthropic',
  ]),
  'dev.build-sr': Object.freeze(['pi:antigravity', 'codex:openai-codex', 'claude-code:anthropic']),
  'dev.qa': Object.freeze([
    'pi:grok',
    'pi:antigravity',
    'codex:openai-codex',
    'claude-code:anthropic',
  ]),
  'rev.review': Object.freeze(['pi:antigravity', 'claude-code:anthropic', 'codex:openai-codex']),
})

export const DEFAULT_TIER_MODEL_MATRIX = Object.freeze({
  lightweight: Object.freeze({
    'pi:grok': Object.freeze({
      runtime: 'pi',
      providerFamily: 'xai',
      model: 'grok-cli/grok-4-fast',
      effort: 'low',
    }),
    'pi:antigravity': Object.freeze({
      runtime: 'pi',
      providerFamily: 'google',
      model: 'antigravity/gemini-3.8-flash',
      effort: 'low',
    }),
    'codex:openai-codex': Object.freeze({
      runtime: 'codex',
      providerFamily: 'openai',
      model: 'gpt-5.3-codex-spark',
      effort: 'low',
    }),
    'claude-code:anthropic': Object.freeze({
      runtime: 'claude-code',
      providerFamily: 'anthropic',
      model: 'claude-haiku-4-5',
      effort: 'low',
    }),
  }),
  balanced: Object.freeze({
    'pi:grok': Object.freeze({
      runtime: 'pi',
      providerFamily: 'xai',
      model: 'grok-cli/grok-code-fast-1',
      effort: 'medium',
    }),
    'pi:antigravity': Object.freeze({
      runtime: 'pi',
      providerFamily: 'google',
      model: 'antigravity/gemini-3.8-flash',
      effort: 'medium',
    }),
    'codex:openai-codex': Object.freeze({
      runtime: 'codex',
      providerFamily: 'openai',
      model: 'gpt-6-astra',
      effort: 'medium',
    }),
    'claude-code:anthropic': Object.freeze({
      runtime: 'claude-code',
      providerFamily: 'anthropic',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    }),
  }),
  'deep-reasoning': Object.freeze({
    'pi:grok': Object.freeze({
      runtime: 'pi',
      providerFamily: 'xai',
      model: 'grok-cli/grok-4.7',
      effort: 'high',
    }),
    'pi:antigravity': Object.freeze({
      runtime: 'pi',
      providerFamily: 'google',
      model: 'antigravity/gemini-3.1-pro',
      effort: 'high',
    }),
    'codex:openai-codex': Object.freeze({
      runtime: 'codex',
      providerFamily: 'openai',
      model: 'gpt-6.1-sol',
      effort: 'high',
    }),
    'claude-code:anthropic': Object.freeze({
      runtime: 'claude-code',
      providerFamily: 'anthropic',
      model: 'claude-opus-4-6',
      effort: 'high',
    }),
  }),
  'architect-lead': Object.freeze({
    'codex:openai-codex': Object.freeze({
      runtime: 'codex',
      providerFamily: 'openai',
      model: 'gpt-6.1-sol',
      effort: 'high',
    }),
    'claude-code:anthropic': Object.freeze({
      runtime: 'claude-code',
      providerFamily: 'anthropic',
      model: 'claude-opus-4-6',
      effort: 'high',
    }),
    'pi:antigravity': Object.freeze({
      runtime: 'pi',
      providerFamily: 'google',
      model: 'antigravity/gemini-3.1-pro',
      effort: 'high',
    }),
    'pi:grok': Object.freeze({
      runtime: 'pi',
      providerFamily: 'xai',
      model: 'grok-cli/grok-4.7',
      effort: 'high',
    }),
  }),
})

export const SEAT_DEFAULT_TIER = Object.freeze({
  'pm.manager': 'lightweight',
  'pm.analyst': 'balanced',
  'orch.arch': 'architect-lead',
  'dev.build-jr': 'lightweight',
  'dev.build': 'balanced',
  'dev.build-sr': 'architect-lead',
  'dev.qa': 'balanced',
  'rev.review': 'deep-reasoning',
})

export const FRONTIER_2026_MODELS = Object.freeze({
  google: Object.freeze({
    flagship: 'antigravity/gemini-4-argon',
    deep: 'antigravity/gemini-3.1-pro',
    fast: 'antigravity/gemini-3.8-flash',
  }),
  openai: Object.freeze({
    flagship: 'gpt-6.1-sol',
    balanced: 'gpt-6-astra',
    fast: 'gpt-5.3-codex-spark',
  }),
  anthropic: Object.freeze({
    flagship: 'claude-opus-4-6',
    balanced: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5',
  }),
  xai: Object.freeze({
    flagship: 'grok-cli/grok-4.7',
    balanced: 'grok-cli/grok-code-fast-1',
    fast: 'grok-cli/grok-4-fast',
  }),
  deepseek: Object.freeze({
    fast: 'd3-flash',
  }),
})

// Project and bundle entries are explicit overrides of the shared built-in defaults.
// Both desired-seat resolution and fallback candidate selection use this merge.
export function effectiveTierModels(tier, { bundleConfig = {}, config = {} } = {}) {
  return {
    ...(DEFAULT_TIER_MODEL_MATRIX[tier] ?? {}),
    ...(bundleConfig.capability_tiers?.[tier]?.models ?? {}),
    ...(config.models?.tiers?.[tier]?.models ?? {}),
  }
}
