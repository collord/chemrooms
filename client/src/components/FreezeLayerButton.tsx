/**
 * "Freeze layer" button — snapshots the current recipe state
 * (analyte, filters, aggregation, color encoding) into a personal
 * layer, persists to localStorage, and adds it to the slice.
 *
 * Disabled when no analyte is selected — there's nothing to freeze
 * about a "show all samples" overview that the layers panel can't
 * already represent as the default state.
 */

import React, {useState, useCallback} from 'react';
import {Snowflake} from 'lucide-react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {freezeCurrentState} from '../layers/layerSchema';
import {addPersonalLayer} from '../layers/layerStorage';

export const FreezeLayerButton: React.FC = () => {
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );
  const matrixFilter = useChemroomsStore(
    (s) => s.chemrooms.config.matrixFilter,
  );
  const eventAgg = useChemroomsStore((s) => s.chemrooms.config.eventAgg);
  const dupAgg = useChemroomsStore((s) => s.chemrooms.config.dupAgg);
  const ndMethod = useChemroomsStore((s) => s.chemrooms.config.ndMethod);
  const colorByResults = useChemroomsStore(
    (s) => s.chemrooms.colorBy['v_results_denormalized'],
  );
  const setPersonalLayers = useChemroomsStore(
    (s) => s.chemrooms.setPersonalLayers,
  );

  const [justFroze, setJustFroze] = useState(false);

  const handleClick = useCallback(() => {
    if (!coloringAnalyte) return;

    const defaultName = matrixFilter
      ? `${coloringAnalyte} — ${matrixFilter} — ${eventAgg}`
      : `${coloringAnalyte} — ${eventAgg}`;
    const name = window.prompt('Layer name:', defaultName);
    if (!name) return;

    const layer = freezeCurrentState({
      name,
      analyte: coloringAnalyte,
      matrix: matrixFilter,
      eventAgg,
      dupAgg,
      ndMethod,
      colorBy: colorByResults ?? null,
    });

    const updated = addPersonalLayer(layer);
    setPersonalLayers(updated);

    setJustFroze(true);
    setTimeout(() => setJustFroze(false), 1500);
  }, [
    coloringAnalyte,
    matrixFilter,
    eventAgg,
    dupAgg,
    ndMethod,
    colorByResults,
    setPersonalLayers,
  ]);

  const disabled = !coloringAnalyte;

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      title={
        disabled
          ? 'Select an analyte to freeze a layer'
          : 'Save the current recipe as a personal layer'
      }
      className="flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Snowflake className="h-3.5 w-3.5" />
      <span>{justFroze ? 'Frozen!' : 'Freeze layer'}</span>
    </button>
  );
};
