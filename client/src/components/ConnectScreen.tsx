/**
 * Shown when no project is configured: the hosted build ships no data, so
 * the user names one.
 *
 * Submitting writes the choice into the URL fragment and reloads, so the
 * page URL is a link back to the same data. The fragment is never sent to
 * the web server; a signed (SAS) URL in it stays in the browser, but it is
 * in the address bar and in any link copied from it.
 */

import React, {useMemo, useState} from 'react';
import {Database} from 'lucide-react';
import {Button, Input, Label} from '@sqlrooms/ui';
import {SIDECAR_FOLDERS, defaultSidecarFolder, sourceHash} from '../config';

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export const ConnectScreen: React.FC = () => {
  const [manifest, setManifest] = useState('');
  const [data, setData] = useState('');
  const m = manifest.trim();
  const d = data.trim();

  const error = useMemo(() => {
    if (!m && !d) return null;
    if (m && !isHttpUrl(m)) return 'The manifest must be an http(s) URL.';
    if (d && !isHttpUrl(d)) return 'The data folder must be an http(s) URL.';
    if (
      window.location.protocol === 'https:' &&
      [m, d].some((u) => u.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u))
    ) {
      return 'This page is served over https, so the browser will block plain http data URLs.';
    }
    return null;
  }, [m, d]);

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    if (error || (!m && !d)) return;
    window.location.hash = sourceHash({manifest: m || null, data: d || null});
    window.location.reload();
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <form
        onSubmit={open}
        className="flex w-full max-w-xl flex-col gap-4 rounded-lg border border-border p-6"
      >
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Open a project in Chemrooms</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Nothing is loaded until you name a data source. Data is read directly by
          your browser from where it is hosted; nothing is uploaded.
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manifest">EQuIS ARII export: manifest.json URL</Label>
          <Input
            id="manifest"
            placeholder="https://<account>.blob.core.windows.net/<container>/<export>/manifest.json?<sas>"
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            The sidecars are looked for beside the manifest: in{' '}
            <code>{SIDECAR_FOLDERS[0]}/</code>, as the export pipeline publishes them, then
            in <code>{SIDECAR_FOLDERS[1]}/</code>, as <code>server/publish_arii.py</code> did
            {m && isHttpUrl(m) ? (
              <>
                {' '}
                (<code className="break-all">{defaultSidecarFolder(m).split('?')[0]}</code>)
              </>
            ) : null}
            . A signed URL's token is reused for them and for every partition.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="data">
            Data folder URL <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="data"
            placeholder="Sidecar folder, if not beside the manifest; or a ChemDuck parquet folder"
            value={data}
            onChange={(e) => setData(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            With no manifest, this opens a converted ChemDuck project instead.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            The host must allow this site in its CORS rules and answer HTTP Range requests.
          </p>
          <Button type="submit" disabled={Boolean(error) || (!m && !d)}>
            Open
          </Button>
        </div>
      </form>
    </div>
  );
};
