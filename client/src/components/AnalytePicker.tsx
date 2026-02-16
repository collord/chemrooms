/**
 * Searchable, grouped analyte list for the selected location.
 * Click to toggle selection (max 4 for multi-analyte overlay).
 */

import React, {useMemo, useState} from 'react';
import {Check, Search} from 'lucide-react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {AnalyteInfo} from '../slices/chemrooms-slice';

export const AnalytePicker: React.FC = () => {
  const [search, setSearch] = useState('');

  const analytesAtLocation = useChemroomsStore(
    (s) => s.chemrooms.analytesAtLocation,
  );
  const selectedAnalytes = useChemroomsStore(
    (s) => s.chemrooms.config.timeSeriesAnalytes,
  );
  const addAnalyte = useChemroomsStore(
    (s) => s.chemrooms.addTimeSeriesAnalyte,
  );
  const removeAnalyte = useChemroomsStore(
    (s) => s.chemrooms.removeTimeSeriesAnalyte,
  );

  // Group by analyte_group, filter by search
  const grouped = useMemo(() => {
    const lowerSearch = search.toLowerCase();
    const filtered = analytesAtLocation.filter(
      (a) =>
        a.analyte.toLowerCase().includes(lowerSearch) ||
        a.analyteGroup.toLowerCase().includes(lowerSearch) ||
        a.casNumber.includes(search),
    );

    const groups = new Map<string, AnalyteInfo[]>();
    for (const a of filtered) {
      const group = a.analyteGroup || 'Other';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(a);
    }
    return groups;
  }, [analytesAtLocation, search]);

  const toggleAnalyte = (analyte: string) => {
    if (selectedAnalytes.includes(analyte)) {
      removeAnalyte(analyte);
    } else {
      addAnalyte(analyte);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Analytes at Location
        {selectedAnalytes.length > 0 && (
          <span className="ml-1 text-primary">
            ({selectedAnalytes.length}/4 selected)
          </span>
        )}
      </span>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search analytes..."
          className="w-full rounded border bg-background py-1 pl-7 pr-2 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Grouped list */}
      <div className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
        {Array.from(grouped.entries()).map(([group, analytes]) => (
          <div key={group}>
            <div className="sticky top-0 bg-background px-1 py-0.5 text-xs font-medium text-muted-foreground">
              {group}
            </div>
            {analytes.map((a) => {
              const isSelected = selectedAnalytes.includes(a.analyte);
              const detectPct =
                a.resultCount > 0
                  ? Math.round((a.detectCount / a.resultCount) * 100)
                  : 0;

              return (
                <button
                  key={a.analyte}
                  onClick={() => toggleAnalyte(a.analyte)}
                  disabled={
                    !isSelected && selectedAnalytes.length >= 4
                  }
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-muted disabled:opacity-40 ${
                    isSelected ? 'bg-primary/10 text-primary' : ''
                  }`}
                >
                  <div
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground'
                    }`}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </div>
                  <span className="flex-1 truncate">{a.analyte}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {a.resultCount}r {detectPct}%D
                  </span>
                </button>
              );
            })}
          </div>
        ))}

        {grouped.size === 0 && (
          <div className="py-2 text-center text-xs text-muted-foreground">
            No analytes found
          </div>
        )}
      </div>
    </div>
  );
};
