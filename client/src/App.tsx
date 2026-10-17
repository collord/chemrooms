import React, {useEffect} from 'react';
import {ThemeProvider} from '@sqlrooms/ui';
import {Room} from './Room';
import {ConnectScreen} from './components/ConnectScreen';
import {PROJECT_SOURCE, sourceParams} from './config';

export const App: React.FC = () => {
  // The project is chosen once, at load (config.ts). If the fragment's
  // source changes afterwards - an edited address bar, a pasted link - the
  // store would still hold the old one, so reload. Bookmark parameters in
  // the same fragment change freely without this.
  useEffect(() => {
    const initial = JSON.stringify(sourceParams(window.location.hash));
    const onHash = () => {
      if (JSON.stringify(sourceParams(window.location.hash)) !== initial) {
        window.location.reload();
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <ThemeProvider defaultTheme="dark" storageKey="chemrooms-theme">
      {PROJECT_SOURCE ? <Room /> : <ConnectScreen />}
    </ThemeProvider>
  );
};
