/**
 * Sidebar panel — three sections, top to bottom:
 *
 *   1. The active recipe (boxed): analyte + filters + aggregation +
 *      color encoding + freeze button. All controls below the analyte
 *      grey out together when no analyte is selected.
 *
 *   2. Saved layers (accordion): list of frozen personal layers, with
 *      visibility toggles and delete buttons. Empty until the user
 *      clicks Freeze layer.
 *
 *   3. Scene tools: Bookmark, Cross Section, Vertical Exaggeration.
 *      Per-scene state, not part of the recipe.
 *
 * The selected location detail card and time-series analyte picker
 * (when a location is clicked) appear at the bottom.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import type {EventAgg} from '../slices/chemrooms-slice';
import {useAvailableFilters} from '../hooks/useAvailableFilters';
import {useLocationClick, useLocationDetail} from '../hooks/useLocationClick';
import {useKeyboardShortcuts} from '../hooks/useKeyboardShortcuts';
import {LocationDetailCard} from './LocationDetailCard';
import {AnalytePicker} from './AnalytePicker';
import {FilterToolbar} from './FilterToolbar';
import {CrossSectionToggle} from './CrossSectionToggle';
import {VerticalExaggerationSlider} from './VerticalExaggerationSlider';
import {BookmarkButton} from './BookmarkButton';
import {ColorByPicker} from './ColorByPicker';
import {TopAnalytePicker} from './TopAnalytePicker';
import {AggregationRulePicker} from './AggregationRulePicker';
import {FreezeLayerButton} from './FreezeLayerButton';
import {LayersPanel} from './LayersPanel';

export const SidebarPanel: React.FC = () => {
  // Activate hooks
  useAvailableFilters();
  useLocationClick();
  useLocationDetail();
  useKeyboardShortcuts();

  const selectedLocationId = useChemroomsStore(
    (s) => s.chemrooms.config.selectedLocationId,
  );
  const locationSummary = useChemroomsStore(
    (s) => s.chemrooms.locationSummary,
  );
  const isLoadingLocation = useChemroomsStore(
    (s) => s.chemrooms.isLoadingLocation,
  );
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );
  const eventAgg = useChemroomsStore((s) => s.chemrooms.config.eventAgg);
  const setEventAgg = useChemroomsStore((s) => s.chemrooms.setEventAgg);

  const recipeDisabled = !coloringAnalyte;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/* ── 1. The active recipe ───────────────────────────────────── */}
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <TopAnalytePicker />
        <AggregationRulePicker
          category="event_agg"
          label="Show value"
          value={eventAgg}
          onChange={(name) => setEventAgg(name as EventAgg)}
          disabled={recipeDisabled}
        />
        <FilterToolbar disabled={recipeDisabled} />
        <ColorByPicker disabled={recipeDisabled} />
        <FreezeLayerButton />
      </div>

      {/* ── 2. Saved layers ────────────────────────────────────────── */}
      <LayersPanel />

      {/* ── 3. Scene tools ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <BookmarkButton />
        <CrossSectionToggle />
        <VerticalExaggerationSlider />
      </div>

      {/* ── Selected location detail (when a point is clicked) ─────── */}
      {selectedLocationId ? (
        <>
          {isLoadingLocation ? (
            <div className="text-muted-foreground py-4 text-center text-sm">
              Loading location data...
            </div>
          ) : locationSummary ? (
            <>
              <LocationDetailCard summary={locationSummary} />
              <AnalytePicker />
            </>
          ) : null}
        </>
      ) : (
        <div className="text-muted-foreground py-2 text-center text-[11px] italic">
          Click a location on the map to view details and select analytes
          for time-series analysis.
        </div>
      )}
    </div>
  );
};
