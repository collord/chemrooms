/**
 * Renders nothing — just a hook caller in component shape so React's
 * effect lifecycle handles entity creation/cleanup when props change.
 *
 * Parallel to ChemroomsEntityLayer but for polyline/polygon vector
 * layers (see useChemroomsVectorEntities for the rendering logic).
 * ChemroomsEntityLayers.tsx picks which wrapper to use per layer
 * based on dataSource.geometryType.
 */

import React from 'react';
import {
  useChemroomsVectorEntities,
  type UseChemroomsVectorEntitiesArgs,
} from '../hooks/useChemroomsVectorEntities';

export const ChemroomsVectorLayer: React.FC<UseChemroomsVectorEntitiesArgs> = (
  props,
) => {
  useChemroomsVectorEntities(props);
  return null;
};
