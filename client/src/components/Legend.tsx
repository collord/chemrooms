/**
 * Sidebar legend for whichever column is currently being color-coded.
 *
 * Reads the active vis spec from the chemrooms slice and renders either:
 *  - a horizontal gradient bar (sequential)
 *  - a vertical list of swatches (categorical)
 *
 * Categorical legends without an explicit `categories` list and
 * sequential legends without a domain don't render anything yet —
 * a follow-up change will derive those from the data after entities
 * are loaded.
 */

import React from 'react';
import * as chromatic from 'd3-scale-chromatic';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {ColumnSpec} from '../vis/visSpec';

interface LegendProps {
  /** Which table's color-by selection to render a legend for. */
  table: string;
}

export const Legend: React.FC<LegendProps> = ({table}) => {
  const visSpec = useChemroomsStore((s) => s.chemrooms.visSpecs[table]);
  const colorByCol = useChemroomsStore((s) => s.chemrooms.colorBy[table]);

  if (!visSpec || !colorByCol) return null;
  const colSpec = visSpec.columns[colorByCol];
  if (!colSpec) return null;

  const label = colSpec.label ?? colorByCol;
  const unit = colSpec.unit ? ` (${colSpec.unit})` : '';

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-foreground">
        {label}
        {unit}
      </div>
      {colSpec.color.type === 'sequential' ? (
        <SequentialBar spec={colSpec} />
      ) : (
        <CategoricalSwatches spec={colSpec} />
      )}
    </div>
  );
};

function getInterpolator(name: string): ((t: number) => string) | null {
  const key = `interpolate${capitalize(name)}` as keyof typeof chromatic;
  const fn = chromatic[key];
  return typeof fn === 'function' ? (fn as (t: number) => string) : null;
}

function getScheme(name: string): readonly string[] | null {
  const key = `scheme${capitalize(name)}` as keyof typeof chromatic;
  const v = chromatic[key];
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
    return v as readonly string[];
  }
  if (Array.isArray(v) && v.length > 0 && Array.isArray(v[v.length - 1])) {
    return v[v.length - 1] as readonly string[];
  }
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SequentialBar: React.FC<{spec: ColumnSpec}> = ({spec}) => {
  if (spec.color.type !== 'sequential') return null;
  const interp = getInterpolator(spec.color.palette);
  if (!interp) return null;

  // 16 stops is plenty for a smooth bar
  const stops = Array.from({length: 16}, (_, i) => {
    const t = i / 15;
    return `${interp(t)} ${(t * 100).toFixed(1)}%`;
  });
  const gradient = `linear-gradient(to right, ${stops.join(', ')})`;

  const domain = spec.color.domain;
  const lo = domain ? formatNumber(domain[0]) : '?';
  const hi = domain ? formatNumber(domain[1]) : '?';

  return (
    <div className="flex flex-col gap-0.5">
      <div className="h-2 w-full rounded-sm" style={{background: gradient}} />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
    </div>
  );
};

const CategoricalSwatches: React.FC<{spec: ColumnSpec}> = ({spec}) => {
  if (spec.color.type !== 'categorical') return null;
  const cats = spec.color.categories ?? [];
  if (cats.length === 0) {
    return (
      <div className="text-[10px] text-muted-foreground italic">
        legend pending
      </div>
    );
  }
  const overrides = spec.color.colors ?? {};
  const scheme = getScheme(spec.color.palette) ?? [];
  return (
    <div className="flex flex-col gap-0.5">
      {cats.map((cat, i) => {
        const color =
          overrides[cat] ?? scheme[i % scheme.length] ?? '#888888';
        return (
          <div key={cat} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{background: color}}
            />
            <span className="text-foreground">{cat}</span>
          </div>
        );
      })}
    </div>
  );
};

function formatNumber(n: number): string {
  if (Math.abs(n) >= 10000 || (Math.abs(n) < 0.01 && n !== 0)) {
    return n.toExponential(2);
  }
  return n.toFixed(2);
}
