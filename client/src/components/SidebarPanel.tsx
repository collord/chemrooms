/**
 * Sidebar panel with:
 * - Filter toolbar (matrix, fraction, ND method)
 * - Location detail card (when a location is selected)
 * - Analyte picker (for time-series at the selected location)
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
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

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <LayersMenu />
        <BookmarkButton />
      </div>
      <FilterToolbar />
      <CrossSectionToggle />
      <VerticalExaggerationSlider />
      <ColorByPicker table="locations" label="Color locations by" />
      <ColorByPicker table="samples" label="Color samples by" />

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
