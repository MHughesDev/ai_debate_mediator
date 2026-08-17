// Preset system (SPEC §3.5): every preset is a pure JSON config object; a
// session's effective config = preset deep-merged with launcher dial overrides.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const REQUIRED_KEYS = ['format_id', 'turns', 'rubric', 'scoring_visibility', 'factcheck', 'mediator', 'personality', 'display'];
const VISIBILITY = ['live', 'end', 'off'];

let cache = null;

export function loadPresets() {
  if (cache) return cache;
  cache = {};
  for (const file of readdirSync(here).filter((f) => f.endsWith('.json'))) {
    const preset = JSON.parse(readFileSync(join(here, file), 'utf8'));
    validatePreset(preset);
    cache[preset.format_id] = preset;
  }
  return cache;
}

export function validatePreset(preset) {
  for (const key of REQUIRED_KEYS) {
    if (!(key in preset)) throw new Error(`preset ${preset.format_id || '?'} missing "${key}"`);
  }
  if (!VISIBILITY.includes(preset.scoring_visibility)) {
    throw new Error(`preset ${preset.format_id}: invalid scoring_visibility`);
  }
  const weights = Object.values(preset.rubric);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.001) throw new Error(`preset ${preset.format_id}: rubric weights must sum to 1 (got ${sum})`);
  for (const turn of preset.turns.structure || []) {
    if (!turn.label || typeof turn.seconds !== 'number') {
      throw new Error(`preset ${preset.format_id}: malformed turn entry`);
    }
  }
  return true;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, overrides) {
  if (!isPlainObject(overrides)) return overrides === undefined ? base : overrides;
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = isPlainObject(base?.[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Resolve {preset: 'oxford', overrides: {...}} (or a raw config object) into a
// full effective config. Unknown preset falls back to 'casual' (safest dials).
export function resolveSessionConfig(input = {}) {
  const presets = loadPresets();
  const presetId = input.preset || 'casual';
  const base = presets[presetId] || presets.casual;
  const resolved = deepMerge(base, input.overrides || {});
  resolved.preset = base.format_id;
  return resolved;
}

export function listPresets() {
  return Object.values(loadPresets()).map((p) => ({
    format_id: p.format_id,
    label: p.label,
    description: p.description,
    scoring_visibility: p.scoring_visibility,
    personality: p.personality,
  }));
}
