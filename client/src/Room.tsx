/**
 * Room component — sets up RoomShell with sidebar, layout, and SQL editor.
 */

import {useEffect, useRef} from 'react';
import {RoomShell} from '@sqlrooms/room-shell';
import {SqlEditorModal} from '@sqlrooms/sql-editor';
import {ThemeSwitch, useDisclosure} from '@sqlrooms/ui';
import {TerminalIcon} from 'lucide-react';
import {roomStore, type RoomState} from './store';
import {initEntityLayers} from './setup/initEntityLayers';

const COLUMN_MAPPING = {
  longitude: 'longitude',
  latitude: 'latitude',
  altitude: 'altitude',
  label: 'label',
} as const;

export const Room = () => {
  const sqlEditorDisclosure = useDisclosure();
  const initRanRef = useRef(false);

  useEffect(() => {
    roomStore.getState().initialize?.();
  }, []);

  // Once parquet data has loaded, run our chemrooms-specific setup:
  // detect elevation columns, load the geoid grid, register the
  // geoid_offset macro, and add the entity layers with correct SQL.
  useEffect(() => {
    return roomStore.subscribe((state: RoomState) => {
      if (!state.room.isDataAvailable || initRanRef.current) return;
      initRanRef.current = true;

      const {connector} = state.db;
      const {addLayer} = state.cesium;

      initEntityLayers(connector)
        .then(({hasGeoid, elevationColumns, locationsSql, samplesSql}) => {
          console.log(
            `[init] hasGeoid=${hasGeoid} elevationColumns=[${elevationColumns.join(',')}]`,
          );
          addLayer({
            id: 'locations',
            type: 'sql-entities',
            visible: true,
            tableName: 'locations',
            heightReference: 'NONE',
            sqlQuery: locationsSql,
            columnMapping: COLUMN_MAPPING,
          });
          addLayer({
            id: 'subsurface-samples',
            type: 'sql-entities',
            visible: false,
            tableName: 'samples',
            heightReference: 'NONE',
            sqlQuery: samplesSql,
            columnMapping: COLUMN_MAPPING,
          });
        })
        .catch((e) => console.error('[init] entity layers setup failed:', e));
    });
  }, []);

  return (
    <RoomShell className="h-screen" roomStore={roomStore}>
      <RoomShell.Sidebar>
        <RoomShell.SidebarButton
          title="SQL Editor"
          onClick={sqlEditorDisclosure.onToggle}
          isSelected={false}
          icon={TerminalIcon}
        />
        <ThemeSwitch />
      </RoomShell.Sidebar>
      <RoomShell.LayoutComposer />
      <RoomShell.LoadingProgress />
      <SqlEditorModal
        isOpen={sqlEditorDisclosure.isOpen}
        onClose={sqlEditorDisclosure.onClose}
      />
    </RoomShell>
  );
};
