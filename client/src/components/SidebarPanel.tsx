/**
 * Sidebar panel.
 *
 * Top-down information flow:
 *  1. Analyte (drives whether the samples layer is aggregated)
 *  2. Event aggregation rule (only meaningful with an analyte)
 *  3. Layers / Bookmark
 *  4. Filters (matrix, fraction, ND method)
 *  5. Cross-section toggle
 *  6. Vertical exaggeration
 *  7. Color-by pickers (locations, samples, joined results)
 *  8. Selected location detail + analyte picker (when a location is clicked)
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
import {LayersMenu} from './LayersMenu';
import {BookmarkButton} from './BookmarkButton';
import {ColorByPicker} from './ColorByPicker';
import {TopAnalytePicker} from './TopAnalytePicker';
import {AggregationRulePicker} from './AggregationRulePicker';

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

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <TopAnalytePicker />
      <AggregationRulePicker
        category="event_agg"
        label="Show value"
        value={eventAgg}
        onChange={(name) => setEventAgg(name as EventAgg)}
        disabled={!coloringAnalyte}
      />
      <div className="flex items-center gap-2">
        <LayersMenu />
        <BookmarkButton />
      </div>
      <FilterToolbar />
      <CrossSectionToggle />
      <VerticalExaggerationSlider />
      <ColorByPicker table="locations" label="Color locations by" />
      <ColorByPicker table="samples" label="Color samples by" />
      <ColorByPicker
        table="v_results_denormalized"
        label="Color results (joined) by"
      />

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
        <div className="text-muted-foreground py-8 text-center text-sm">
          Click a location on the map to view details and select analytes for
          time-series analysis.
        </div>
      )}
    </div>
  );
};
