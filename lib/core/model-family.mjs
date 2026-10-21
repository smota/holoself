// A transport or gateway name is not a model's independent intelligence family.
export const MODEL_FAMILIES = Object.freeze([
  'anthropic',
  'openai',
  'google',
  'xai',
  'qwen',
  'zai',
  'deepseek',
])
export function modelFamily(model) {
  const leaf = String(model ?? '')
    .toLowerCase()
    .split('/')
    .at(-1)
  if (/^claude(?:-|$)/.test(leaf)) return 'anthropic'
  if (/^(?:gemini|gemma)(?:-|$)/.test(leaf)) return 'google'
  if (/^grok(?:-|$)/.test(leaf)) return 'xai'
  if (/^qwen(?:\d|-|$)/.test(leaf)) return 'qwen'
  if (/^glm(?:-|$)/.test(leaf)) return 'zai'
  if (/^deepseek(?:-|$)/.test(leaf)) return 'deepseek'
  if (/^(?:gpt-|codex(?:-|$)|o[134](?:-|$))/.test(leaf)) return 'openai'
  return 'unknown'
}
