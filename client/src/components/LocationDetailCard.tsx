/**
 * Displays summary info for the selected location.
 */

import React from 'react';
import {MapPin, Calendar, FlaskConical, Layers} from 'lucide-react';
import type {LocationSummary} from '../slices/chemrooms-slice';

interface Props {
  summary: LocationSummary;
}

export const LocationDetailCard: React.FC<Props> = ({summary}) => {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-primary" />
        <span className="font-semibold">{summary.locationId}</span>
        {summary.locType && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
            {summary.locType}
          </span>
        )}
      </div>

      {summary.locDesc && (
        <p className="text-sm text-muted-foreground">{summary.locDesc}</p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center gap-1 text-muted-foreground">
          <Layers className="h-3 w-3" />
          <span>{summary.sampleCount} samples</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <FlaskConical className="h-3 w-3" />
          <span>{summary.analyteCount} analytes</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Calendar className="h-3 w-3" />
          <span>{summary.firstDate}</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Calendar className="h-3 w-3" />
          <span>{summary.lastDate}</span>
        </div>
      </div>

      {summary.matrices.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {summary.matrices.map((m) => (
            <span
              key={m}
              className="rounded bg-muted px-1.5 py-0.5 text-xs"
            >
              {m}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
