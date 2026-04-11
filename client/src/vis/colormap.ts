/**
 * Build a row → Cesium.Color function from a vis spec.
 *
 * Sequential specs use d3-scale-chromatic interpolators. Categorical
 * specs use d3-scale-chromatic schemes when an explicit category list
 * is given, falling back to a stable per-string hash for unknown values
 * so reloads are deterministic.
 */

import {scaleLinear, scaleLog, scaleSqrt} from 'd3-scale';
import * as chromatic from 'd3-scale-chromatic';
import {Color} from 'cesium';
import type {
  CategoricalColorSpec,
  ColumnSpec,
  SequentialColorSpec,
  VisSpec,
} from './visSpec';

const FALLBACK_COLOR = Color.GRAY;

/** Look up a sequential interpolator by name from d3-scale-chromatic. */
function getInterpolator(name: string): ((t: number) => string) | null {
  const key = `interpolate${capitalize(name)}` as keyof typeof chromatic;
  const fn = chromatic[key];
  return typeof fn === 'function' ? (fn as (t: number) => string) : null;
}

/** Look up a categorical scheme by name from d3-scale-chromatic. */
function getScheme(name: string): readonly string[] | null {
  const key = `scheme${capitalize(name)}` as keyof typeof chromatic;
  const v = chromatic[key];
  // Some schemes are flat arrays (Category10), others are nested by k.
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
    return v as readonly string[];
  }
  if (Array.isArray(v) && v.length > 0 && Array.isArray(v[v.length - 1])) {
    // Pick the largest available palette
    return v[v.length - 1] as readonly string[];
  }
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cssToCesiumColor(css: string): Color {
  try {
    return Color.fromCssColorString(css) ?? FALLBACK_COLOR;
  } catch {
    return FALLBACK_COLOR;
  }
}

/** Stable string → hue → Color, for unmapped categorical values. */
function hashColor(s: string): Color {
  // FNV-ish small hash
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to a hue in [0, 360); use d3-scale's HSL via interpolateRainbow
  // is overkill — just use a simple HSL → RGB inline.
  const hue = (h >>> 0) % 360;
  return hslToCesium(hue, 70, 55);
}

function hslToCesium(h: number, s: number, l: number): Color {
  const sFrac = s / 100;
  const lFrac = l / 100;
  const c = (1 - Math.abs(2 * lFrac - 1)) * sFrac;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lFrac - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return new Color(r + m, g + m, b + m, 1.0);
}

/** Build a continuous scale that maps a numeric value into [0, 1]. */
function buildNormalizer(
  spec: SequentialColorSpec,
  domain: [number, number],
): (v: number) => number {
  let scale: any;
  switch (spec.scaleType) {
    case 'log': {
      // Log scales reject zero/negative; clamp to a tiny positive.
      const lo = Math.max(domain[0], Number.EPSILON);
      const hi = Math.max(domain[1], lo * 10);
      scale = scaleLog().domain([lo, hi]).range([0, 1]).clamp(true);
      break;
    }
    case 'sqrt':
      scale = scaleSqrt().domain(domain).range([0, 1]).clamp(true);
      break;
    default:
      scale = scaleLinear().domain(domain).range([0, 1]).clamp(true);
  }
  return (v: number) => {
    if (v == null || Number.isNaN(v)) return NaN;
    return scale(v);
  };
}

/**
 * Returns a function that takes a column value (already extracted from
 * the row) and returns a Cesium.Color.
 */
export function makeColorFnForColumn(
  spec: ColumnSpec,
  derivedDomain?: [number, number],
  derivedCategories?: string[],
): (value: unknown) => Color {
  const c = spec.color;

  if (c.type === 'sequential') {
    // Live data domain wins over the spec's hardcoded one. The spec domain
    // is typically a global min/max baked at export time, which compresses
    // the gradient when the data is filtered (e.g. one analyte). Using the
    // derived domain when available makes the visual gradient meaningful
    // for whatever subset is currently rendered.
    const domain = derivedDomain ?? c.domain;
    if (!domain) {
      // No domain — can't normalize. Fall back to gray.
      return () => FALLBACK_COLOR;
    }
    const interp = getInterpolator(c.palette);
    if (!interp) {
      console.warn(`[colormap] unknown sequential palette: ${c.palette}`);
      return () => FALLBACK_COLOR;
    }
    const normalize = buildNormalizer(c, domain);
    return (value) => {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) return FALLBACK_COLOR;
      const t = normalize(num);
      if (!Number.isFinite(t)) return FALLBACK_COLOR;
      return cssToCesiumColor(interp(t));
    };
  }

  // categorical
  return makeCategoricalFn(c, derivedCategories);
}

function makeCategoricalFn(
  c: CategoricalColorSpec,
  derivedCategories?: string[],
): (value: unknown) => Color {
  const categories = c.categories ?? derivedCategories ?? [];
  const overrides = c.colors ?? {};
  const scheme = getScheme(c.palette) ?? [];

  // Pre-build a category → Color map for known values
  const map = new Map<string, Color>();
  categories.forEach((cat, i) => {
    if (overrides[cat]) {
      map.set(cat, cssToCesiumColor(overrides[cat]));
    } else if (scheme.length > 0) {
      map.set(cat, cssToCesiumColor(scheme[i % scheme.length]!));
    } else {
      map.set(cat, hashColor(cat));
    }
  });
  // Apply standalone overrides not in the categories list
  for (const [k, v] of Object.entries(overrides)) {
    if (!map.has(k)) map.set(k, cssToCesiumColor(v));
  }

  return (value) => {
    if (value == null) return FALLBACK_COLOR;
    const key = String(value);
    return map.get(key) ?? hashColor(key);
  };
}

/** Convenience: build a row → Color function from a full spec + column name. */
export function makeColorFn(
  spec: VisSpec,
  columnName: string,
  derivedDomain?: [number, number],
  derivedCategories?: string[],
): ((row: Record<string, unknown>) => Color) | null {
  const colSpec = spec.columns[columnName];
  if (!colSpec) return null;
  const inner = makeColorFnForColumn(
    colSpec,
    derivedDomain,
    derivedCategories,
  );
  return (row) => inner(row[columnName]);
}
