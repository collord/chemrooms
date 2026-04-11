/**
 * Mounts the chemrooms-managed Cesium entity layers (locations + samples).
 * Rendered inside RoomShell so its hooks have RoomStateProvider context.
 *
 * The layer SQL strings come in as props from Room.tsx, which owns the
 * init lifecycle (initEntityLayers + rebuildSamplesSql subscriptions).
 * Visibility and the samples vis spec key come from the chemrooms slice
 * via hooks.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {ChemroomsEntityLayer} from './ChemroomsEntityLayer';

interface ChemroomsEntityLayersProps {
  locationsSql: string | null;
  samplesSql: string | null;
}

export const ChemroomsEntityLayers: React.FC<ChemroomsEntityLayersProps> = ({
  locationsSql,
  samplesSql,
}) => {
  const locationsVisible = useChemroomsStore(
    (s) => s.chemrooms.locationsVisible,
  );
  const samplesVisible = useChemroomsStore((s) => s.chemrooms.samplesVisible);
  const coloringAnalyte = useChemroomsStore(
    (s) => s.chemrooms.config.coloringAnalyte,
  );

  // When an analyte is selected, the samples SQL returns the same
  // column shape as v_results_denormalized and we want to use that
  // vis spec. Without one, it's the plain samples table.
  const samplesVisSpecTable = coloringAnalyte
    ? 'v_results_denormalized'
    : 'samples';

  return (
    <>
      <ChemroomsEntityLayer
        layerId="locations"
        sqlQuery={locationsSql}
        visSpecTable="locations"
        visible={locationsVisible}
      />
      <ChemroomsEntityLayer
        layerId="samples"
        sqlQuery={samplesSql}
        visSpecTable={samplesVisSpecTable}
        visible={samplesVisible}
      />
    </>
  );
};
