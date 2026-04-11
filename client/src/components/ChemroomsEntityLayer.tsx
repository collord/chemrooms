/**
 * Renders nothing — just a hook caller in component shape so React's
 * effect lifecycle handles entity creation/cleanup when props change.
 *
 * Two of these are mounted by Room.tsx (one for locations, one for
 * samples). Each owns a set of viewer.entities tagged with its layerId.
 */

import React from 'react';
import {
  useChemroomsEntities,
  type UseChemroomsEntitiesArgs,
} from '../hooks/useChemroomsEntities';

export const ChemroomsEntityLayer: React.FC<UseChemroomsEntitiesArgs> = (
  props,
) => {
  useChemroomsEntities(props);
  return null;
};
