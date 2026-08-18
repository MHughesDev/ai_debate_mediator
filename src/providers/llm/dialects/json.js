// Getting JSON back out of a model that may or may not have honoured a schema.
//
// Hosted vendors with real structured-output support return clean JSON. Local
// models often wrap it in a markdown fence, prefix it with "Sure! Here's the
// JSON:", or emit reasoning before it. We would rather recover the object than
// discard a valid answer over formatting.

export function extractJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();

  try {
    return JSON.parse(text);
  } catch {
    // fall through to recovery
  }

  // ```json ... ``` fences.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // keep trying
    }
  }

  // First balanced {...} or [...], skipping braces that appear inside strings.
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Some servers accept a schema but ignore it, so the shape still has to be
// stated in the prompt for the fallback modes to stand any chance.
export function schemaInstruction(schema) {
  return (
    '\n\nRespond with JSON only — no prose, no markdown fence — matching this JSON Schema exactly:\n' +
    JSON.stringify(schema)
  );
}
