/**
 * What the live recipe's map query said instead of drawing, or alongside
 * it (layers/layerNotice.ts): ChemDuck's refusal of a variable in mixed
 * units, say, or the filters its source can't apply. Shown under the
 * analyte picker, where the choice that caused it was made.
 */

import React from 'react';
import {useChemroomsStore} from '../slices/chemrooms-slice';

/** The live recipe's layer (ChemroomsEntityLayers' samples layer). */
const LIVE_LAYER = 'samples';

export const RecipeNotice: React.FC = () => {
  const notice = useChemroomsStore((s) => s.chemrooms.layerNotices[LIVE_LAYER]);
  const analyte = useChemroomsStore((s) => s.chemrooms.config.coloringAnalyte);
  if (!notice || !analyte) return null;
  const refused = notice.kind === 'refused';
  return (
    <div
      role={refused ? 'alert' : 'status'}
      className={
        'rounded border px-2 py-1.5 text-xs ' +
        (refused
          ? 'border-destructive/50 bg-destructive/10 text-destructive'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300')
      }
    >
      <span className="font-medium">{refused ? 'Not mapped: ' : 'Note: '}</span>
      {notice.message}
    </div>
  );
};
