/**
 * Room component — sets up RoomShell with sidebar, layout, and SQL editor.
 *
 * The chemrooms entity layer lifecycle (init, terrain sampling, reactive
 * samples SQL rebuild, per-row coloring) lives in ChemroomsEntityLayers,
 * which is rendered as a child of RoomShell so all its hooks have the
 * RoomStateProvider context.
 */

import {useEffect} from 'react';
import {RoomShell} from '@sqlrooms/room-shell';
import {SqlEditorModal} from '@sqlrooms/sql-editor';
import {ThemeSwitch, useDisclosure} from '@sqlrooms/ui';
import {TerminalIcon} from 'lucide-react';
import {roomStore} from './store';
import {ChemroomsEntityLayers} from './components/ChemroomsEntityLayers';

export const Room = () => {
  const sqlEditorDisclosure = useDisclosure();

  useEffect(() => {
    roomStore.getState().initialize?.();
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
      <ChemroomsEntityLayers />
    </RoomShell>
  );
};
