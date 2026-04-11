/**
 * Generic dropdown for any aggregation_rules category.
 *
 * Options are sourced from the chemduck `aggregation_rules` catalog
 * (loaded from parquet at startup). The catalog is the single source
 * of truth for names + labels — adding a new rule in the schema
 * automatically surfaces it in this component without code changes.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';

interface AggregationRulePickerProps {
  /** aggregation_rules.category: 'event_agg' | 'dup_agg' | 'nd_method' */
  category: string;
  /** Displayed label above the dropdown. */
  label: string;
  /** Currently-selected rule name. */
  value: string;
  onChange: (name: string) => void;
  /** When true, greyed out and non-interactive. */
  disabled?: boolean;
}

export const AggregationRulePicker: React.FC<AggregationRulePickerProps> = ({
  category,
  label,
  value,
  onChange,
  disabled = false,
}) => {
  const rules = useChemroomsStore(
    (s) => s.chemrooms.aggregationRules[category] ?? [],
  );

  // If the catalog hasn't loaded yet, render a placeholder so the
  // layout doesn't reflow when the options arrive.
  const hasRules = rules.length > 0;

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        className="rounded border bg-background px-2 py-1 text-sm disabled:opacity-50"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || !hasRules}
        title={
          !hasRules
            ? 'Aggregation rules not yet loaded'
            : rules.find((r) => r.name === value)?.description ?? undefined
        }
      >
        {!hasRules && <option value={value}>Loading…</option>}
        {rules.map((rule) => (
          <option
            key={rule.name}
            value={rule.name}
            title={rule.description ?? undefined}
          >
            {rule.label}
          </option>
        ))}
      </select>
    </label>
  );
};
