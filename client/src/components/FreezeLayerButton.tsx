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
import {useShallow} from 'zustand/react/shallow';
import {Snowflake} from 'lucide-react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {selectCurrentRecipe, selectColorByResults} from '../slices/selectors';
import {freezeCurrentState} from '../layers/layerSchema';
import {addPersonalLayer} from '../layers/layerStorage';

export const FreezeLayerButton: React.FC = () => {
  // One subscription for all recipe fields instead of 9 individual ones.
  const recipe = useChemroomsStore(useShallow(selectCurrentRecipe));
  const colorByResults = useChemroomsStore(selectColorByResults);
  const setPersonalLayers = useChemroomsStore(
    (s) => s.chemrooms.setPersonalLayers,
  );
  const personalLayers = useChemroomsStore(
    (s) => s.chemrooms.personalLayers,
  );

  const [status, setStatus] = useState<'idle' | 'frozen' | 'duplicate'>(
    'idle',
  );

  const handleClick = useCallback(async () => {
    if (!recipe.coloringAnalyte) return;

    const defaultName = recipe.matrixFilter
      ? `${recipe.coloringAnalyte} — ${recipe.matrixFilter} — ${recipe.eventAgg}`
      : `${recipe.coloringAnalyte} — ${recipe.eventAgg}`;
    const name = window.prompt('Layer name:', defaultName);
    if (!name) return;

    const layer = await freezeCurrentState({
      name,
      analyte: recipe.coloringAnalyte,
      matrix: recipe.matrixFilter,
      eventAgg: recipe.eventAgg,
      dupAgg: recipe.dupAgg,
      ndMethod: recipe.ndMethod,
      colorBy: colorByResults,
      sampleRenderAs: recipe.sampleRenderAs,
      sphereRadiusMeters: recipe.sphereRadiusMeters,
      volumeRadiusMeters: recipe.volumeRadiusMeters,
    });

    const {layers, added} = await addPersonalLayer(layer, personalLayers);
    setPersonalLayers(layers);

    setStatus(added ? 'frozen' : 'duplicate');
    setTimeout(() => setStatus('idle'), 1800);
  }, [recipe, colorByResults, personalLayers, setPersonalLayers]);

  const disabled = !recipe.coloringAnalyte;

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
      <span>
        {status === 'frozen'
          ? 'Frozen!'
          : status === 'duplicate'
            ? 'Already frozen'
            : 'Freeze layer'}
      </span>
    </button>
  );
};
