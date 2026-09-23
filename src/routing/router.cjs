const PRESETS = Object.freeze([
  { id: 'terra-light', description: 'Simple explanations, summaries, lookups and mechanical edits.', label: 'Terra light', model: 'gpt-5.6-terra', effort: 'low' },
  { id: 'sol-light', description: 'Bounded implementation with a known approach.', label: 'Sol light', model: 'gpt-5.6-sol', effort: 'low' },
  { id: 'sol-medium', description: 'Multi-file application work and ordinary debugging.', label: 'Sol medium', model: 'gpt-5.6-sol', effort: 'medium' },
  { id: 'astra-light', description: 'Nuanced analysis and tradeoffs with limited investigation.', label: 'Astra light', model: 'gpt-6-astra', effort: 'low' },
  { id: 'astra-medium', description: 'Complex implementation, review, debugging and architecture.', label: 'Astra medium', model: 'gpt-6-astra', effort: 'medium' },
  { id: 'astra-xhigh', description: 'Deep investigation or difficult coupled problems needing extensive reasoning.', label: 'Astra xhigh', model: 'gpt-6-astra', effort: 'xhigh' },
]);
const ROUTER_PRESETS = Object.freeze([
  { id: 'luna-light', description: 'Economical task classification and simple language tasks.', label: 'Luna light', model: 'gpt-5.6-luna', effort: 'low' },
  ...PRESETS,
]);

function route(text, mode = 'auto') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Write a message first.');
  if (mode === 'auto') return { provisional: true, reason: 'Model and effort are selected on Send.' };
  const preset = PRESETS.find(p => p.id === mode);
  if (!preset) throw new Error('Unknown model preset.');
  return { ...preset, reason: 'Your manual selection.', source: 'manual' };
}

module.exports = { PRESETS, ROUTER_PRESETS, route };
