/**
 * Vis spec format — describes how a column in a data table should be
 * mapped to a visual encoding (currently just color).
 *
 * Specs are shipped alongside parquet files as `<table>.vis.json` and
 * loaded into the chemrooms slice on app init. They serve as the
 * preferred default; users can override them at runtime.
 */

import {z} from 'zod';

/** Sequential / continuous numeric → color */
export const SequentialColorSpec = z.object({
  type: z.literal('sequential'),
  /** d3-scale-chromatic interpolator name (without "interpolate" prefix). */
  palette: z.string(),
  /** Scale function applied to values before colormap lookup. */
  scaleType: z.enum(['linear', 'log', 'sqrt']).default('linear'),
  /** Optional explicit [min, max]. If omitted, derived from data. */
  domain: z.tuple([z.number(), z.number()]).optional(),
});

/** Discrete categorical → color */
export const CategoricalColorSpec = z.object({
  type: z.literal('categorical'),
  /** d3-scale-chromatic scheme name (without "scheme" prefix). */
  palette: z.string(),
  /** Optional ordered list of expected categories. */
  categories: z.array(z.string()).optional(),
  /**
   * Optional per-category color overrides. Categories not present here
   * fall back to palette assignment (or random hash if not in `categories`).
   */
  colors: z.record(z.string(), z.string()).optional(),
});

export const ColumnSpec = z.object({
  /** Human-readable label for legends, etc. */
  label: z.string().optional(),
  /** Optional unit string for legend display (no conversion is performed). */
  unit: z.string().optional(),
  /** Color encoding for this column. */
  color: z.discriminatedUnion('type', [
    SequentialColorSpec,
    CategoricalColorSpec,
  ]),
});

export const VisSpec = z.object({
  version: z.literal(1).default(1),
  table: z.string(),
  columns: z.record(z.string(), ColumnSpec),
  /** Default column to color by when this table is rendered. */
  defaultColorBy: z.string().optional(),
});

export type SequentialColorSpec = z.infer<typeof SequentialColorSpec>;
export type CategoricalColorSpec = z.infer<typeof CategoricalColorSpec>;
export type ColumnSpec = z.infer<typeof ColumnSpec>;
export type VisSpec = z.infer<typeof VisSpec>;

/** Parse + validate a JSON-decoded spec, returning null on error. */
export function parseVisSpec(raw: unknown): VisSpec | null {
  const result = VisSpec.safeParse(raw);
  if (!result.success) {
    console.warn('[visSpec] failed to parse:', result.error);
    return null;
  }
  return result.data;
}
