/**
 * Where the data on screen came from, and how old it is.
 *
 * An EQuIS ARII source is a nightly export. The pipeline keeps yesterday's
 * partition when a slice fails, so partitions can differ in age, and a
 * stale map that looks live is the outcome worth guarding against. The
 * badge names the facility and the partitions' as_of range, says plainly
 * when the manifest records no dates, and shows the refusal message when
 * the source could not be opened at all.
 *
 * A converted ChemDuck project shows nothing: it is a fixed file set.
 */

import React from 'react';
import {Database, TriangleAlert} from 'lucide-react';
import {useChemroomsStore} from '../slices/chemrooms-slice';
import {describeFreshness} from '../setup/ariiSource';
import {PROJECT_SOURCE} from '../config';

/** Back to the connect screen: the page without its fragment. */
const OpenAnother: React.FC = () =>
  PROJECT_SOURCE?.from === 'link' ? (
    <a
      className="text-primary underline-offset-2 hover:underline"
      href={window.location.origin + window.location.pathname}
    >
      Open another source
    </a>
  ) : null;

export const SourceBadge: React.FC = () => {
  const info = useChemroomsStore((s) => s.chemrooms.sourceInfo);
  const error = useChemroomsStore((s) => s.chemrooms.sourceError);

  if (error) {
    return (
      <div
        role="alert"
        className="flex gap-2 rounded-md border border-destructive/60 bg-destructive/10 p-2 text-xs"
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div>
          <div className="font-medium">EQuIS source not opened</div>
          <div className="text-muted-foreground">{error}</div>
          <OpenAnother />
        </div>
      </div>
    );
  }
  if (!info) return null;
  if (info.kind !== 'arii') {
    // A ChemDuck folder opened from a link: say which, and how to leave.
    return PROJECT_SOURCE?.from === 'link' ? (
      <div className="flex gap-2 rounded-md border border-border p-2 text-xs">
        <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate font-medium" title={PROJECT_SOURCE.dataBaseUrl}>
            ChemDuck · {PROJECT_SOURCE.dataBaseUrl.split('?')[0]}
          </div>
          <OpenAnother />
        </div>
      </div>
    ) : null;
  }

  const freshness = describeFreshness(info.partitions);
  const undated = freshness.startsWith('partition dates not recorded');
  return (
    <div
      className="flex gap-2 rounded-md border border-border p-2 text-xs"
      title={`${info.manifestUrl}\nSidecars generated ${info.sidecarsGenerated}`}
    >
      <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="truncate font-medium">
          EQuIS ARII{info.facility ? ` · ${info.facility}` : ''}
        </div>
        <div className={undated ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
          {info.rows.toLocaleString()} results, {info.partitions.length} partitions,{' '}
          {freshness}
        </div>
        {info.unplacedLocations > 0 && (
          <div className="text-muted-foreground">
            {info.unplacedLocations} location(s) have no coordinates and are not drawn
          </div>
        )}
        <OpenAnother />
      </div>
    </div>
  );
};
