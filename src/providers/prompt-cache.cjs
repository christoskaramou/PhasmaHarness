const { createHash } = require('node:crypto');

// Only documented endpoint hints: arbitrary OpenAI-compatible servers need not accept these fields.
function cacheRequest(baseUrl, body, sessionId) {
  const host = new URL(baseUrl).hostname;
  const key = sessionId ? createHash('sha256').update(String(sessionId)).digest('hex') : null;
  const request = { ...body }, headers = {};
  if (host === 'api.openai.com' && key) request.prompt_cache_key = key;
  if (host === 'api.x.ai' && key) headers['x-grok-conv-id'] = key;
  if (host === 'openrouter.ai') {
    if (key) request.session_id = key;
    if (String(body.model).startsWith('anthropic/')) request.cache_control = { type: 'ephemeral' };
    // Only the documented Alibaba endpoints support explicit breakpoints (snapshot models do not).
    if (['deepseek/deepseek-v3.2', 'qwen/qwen3-max', 'qwen/qwen-plus', 'qwen/qwen3.6-plus',
      'qwen/qwen3-coder-plus', 'qwen/qwen3-coder-flash'].includes(String(body.model).split(':')[0])) {
      request.messages = structuredClone(body.messages);
      const system = request.messages.find(message => message.role === 'system');
      const recent = request.messages.filter(message => message.role === 'user').slice(-2);
      for (const message of [system, ...recent].filter(Boolean)) {
        if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
        const block = Array.isArray(message.content) && message.content.findLast(block => block.type === 'text');
        if (block) block.cache_control = { type: 'ephemeral' };
      }
    }
  }
  return { body: request, headers };
}

function cacheUsage(usage) {
  const input = usage?.prompt_tokens, output = usage?.completion_tokens;
  if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const read = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const write = usage.prompt_tokens_details?.cache_write_tokens;
  return { inputTokens: input, outputTokens: output,
    cachedInputTokens: Number.isSafeInteger(read) && read >= 0 && read <= input ? read : null,
    cacheWriteInputTokens: Number.isSafeInteger(write) && write >= 0 && write + (read || 0) <= input ? write : null };
}

module.exports = { cacheRequest, cacheUsage };
