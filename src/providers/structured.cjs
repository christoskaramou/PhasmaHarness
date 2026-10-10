function invalidResponse() {
  return Object.assign(new Error('The model returned an invalid structured response. No action was taken from that response.'), { code: 'INVALID_STRUCTURED_RESPONSE' });
}

// Only the schema vocabulary used by Harness; reject unsupported validation keywords instead of ignoring them.
function matches(value, schema) {
  const supported = ['type', 'properties', 'required', 'additionalProperties', 'anyOf', 'enum', 'items', 'minLength', 'maxLength', 'minimum', 'maximum', 'description'];
  if (Object.keys(schema).some(key => !supported.includes(key))) throw new Error('Unsupported structured response schema.');
  if (schema.anyOf && !schema.anyOf.some(option => matches(value, option))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !(schema.required || []).some(key => !Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => Object.hasOwn(schema.properties || {}, key)
      ? matches(value[key], schema.properties[key]) : schema.additionalProperties !== false);
  if (schema.type === 'array') return Array.isArray(value) && (!schema.items || value.every(item => matches(item, schema.items)));
  if (schema.type === 'integer') return Number.isInteger(value) && !(value < schema.minimum || value > schema.maximum);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) && !(value < schema.minimum || value > schema.maximum);
  if (schema.type && typeof value !== schema.type) return false;
  if (typeof value === 'string' && (value.length < schema.minLength || value.length > schema.maxLength)) return false;
  return true;
}

function structuredResponse(value, schema) {
  if (typeof value === 'string') {
    // Accept a whole fenced JSON document, never extract an action from surrounding prose.
    const fenced = value.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    try { value = JSON.parse(fenced ? fenced[1] : value); }
    catch { throw invalidResponse(); }
  }
  if (!matches(value, schema)) throw invalidResponse();
  return value;
}

module.exports = { structuredResponse, invalidResponse };
