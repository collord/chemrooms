# Chemrooms

A browser workbench for environmental chemistry data: sampling locations,
boreholes and results on a Cesium 3D globe, with per-analyte maps, a location
inspector and time-series charts. It runs entirely in the browser on
[SQLRooms](https://sqlrooms.org) and DuckDB-WASM, so the data is queried
client-side with SQL; the server only hands out files.

The domain rules (non-detect substitution, duplicate and event aggregation,
fractions kept apart) live in [ChemDuck](../chemduck)'s SQL views and macros,
not in this repository's TypeScript. Chemrooms loads that SQL at startup and
queries it.

It reads two kinds of project:

| Project | What the data folder holds | When to use it |
|---|---|---|
| **ChemDuck** | Every table as parquet: `locations`, `samples`, `results`, ... | Data converted to ChemDuck by its loaders |
| **EQuIS ARII** | ~1 MB of sidecars; results stay in the EQuIS export's own partitions | Analytical Results II exports from the `equis-parquet-export` pipeline, too large to download |

## The hosted app

<https://collord.github.io/chemrooms/> ships **no project data**. It opens on
a connect screen; paste the URL of an EQuIS ARII export's `manifest.json`
(prepared as below) and it opens that export. Nothing is uploaded: your
browser reads the data directly from where it is hosted.

The choice is kept in the page's URL fragment, so the address is a link that
reopens the same data, and bookmarks made in the app keep it:

```
https://collord.github.io/chemrooms/#manifest=<URL-encoded manifest.json URL>
https://collord.github.io/chemrooms/#manifest=<...>&data=<URL-encoded sidecar folder>
https://collord.github.io/chemrooms/#data=<URL-encoded ChemDuck data folder>
```

With only `manifest`, the sidecars are looked for in a `chemrooms/` folder
beside the manifest. A signed URL (an Azure SAS token) works: its query
string is reused for the sidecars and every partition. A URL fragment is
never sent to the web server, so the token does not reach GitHub's logs, but
**anyone you give the link to can read the data until the token expires**.
Use read-only, expiring tokens.

The data host must allow the app's origin. For Azure Blob Storage:

```bash
az storage cors add --account-name <account> --services b \
  --methods GET HEAD OPTIONS --origins https://collord.github.io \
  --allowed-headers '*' --exposed-headers 'Content-Length,Content-Range,ETag' \
  --max-age 3600
```

*Open another source* in the sidebar returns to the connect screen.

## Repository layout

```
client/   the app: React, SQLRooms 0.29, DuckDB-WASM, Cesium (Vite, pnpm)
server/   data preparation scripts, and a small FastAPI static server
  data/   the demo ChemDuck project (synthetic) and its ChemDuck SQL
utils/    DEM -> Cesium tileset conversion, geoid subset (see utils/README.md)
Chemrooms.md            the original specification (predates much of the code)
arii-parquet-source.md  design and measurements for the ARII source
```

## Quick start (demo data)

Requires Node 20+, pnpm 10, and Python 3.10+ for the server.

```bash
# 1. Serve the demo data on http://localhost:8000/data
cd server
pip install -r requirements.txt
python main.py serve

# 2. Run the client (another terminal)
cd client
pnpm install
cp .env.example .env      # then set VITE_CESIUM_ION_TOKEN
pnpm dev                  # http://localhost:5173
```

Without a Cesium Ion token the app still works, but there is no world
terrain: locations without a surveyed elevation sit on the ellipsoid.
Get a free token at <https://ion.cesium.com/tokens>.

## Configuration

The project is chosen, in order, by the URL fragment (`#manifest=` /
`#data=`, see above), then these build-time variables in `client/.env` (see
`client/.env.example`), then, in `pnpm dev` only, the demo data at
`http://localhost:8000/data`. A production build with none of them opens on
the connect screen.

| Variable | Meaning |
|---|---|
| `VITE_DATA_URL` | The project's data folder: ChemDuck parquet, or ARII sidecars. |
| `VITE_ARII_MANIFEST_URL` | Set only for an EQuIS ARII project: the export's `manifest.json`. Without `VITE_DATA_URL`, the sidecars are looked for in `chemrooms/` beside it. |
| `VITE_CESIUM_ION_TOKEN` | Cesium Ion access token, for world terrain. |

The data folder carries the ChemDuck SQL (`sql/`) alongside the data,
because the SQL must match the schema the data was written with.

## A ChemDuck project

Convert data to ChemDuck with its loaders (`../chemduck/tools/`), then export
the tables chemrooms reads:

```bash
cd server
python main.py export path/to/project.duckdb [output_dir] --create-vis-specs
python sync_chemduck.py --out output_dir     # ChemDuck SQL + aggregation catalog
```

`--create-vis-specs` writes `<table>.vis.json` files that drive the
*Color by* control. `sync_chemduck.py` copies the SQL from a chemduck
checkout (default: the sibling `../chemduck`) and records the commit in
`sql/SOURCE.json`; run it again whenever chemduck's SQL changes, including for
the demo in `server/data`.

## An EQuIS ARII project

For Analytical Results II exports published as Hive-partitioned parquet with
a `manifest.json` (the `equis-parquet-export` pipeline). The partitions are
**not** copied or converted: the browser reads them where they are published,
fetching only the row groups each query needs.

### 1. Publish the sidecars

```bash
python server/publish_arii.py path/to/export/manifest.json path/to/export/chemrooms \
    --x LONGITUDE --y LATITUDE
```

Writing the sidecars to `chemrooms/` beside the manifest, and uploading that
folder with the export, means the manifest URL alone opens the project.

This needs a chemduck checkout (default `../chemduck`, or `--chemduck`) and
Python with `duckdb` and `pyyaml`; the first run downloads DuckDB's spatial
extension. It writes about 1 MB: `locations` and `samples` tables, the
catalogs the analyte picker and inspector read, vis specs, the ChemDuck SQL,
`sql/results_view.sql` and `sidecars.json`. For a 3.45-million-row export it
takes under a minute.

`--x`/`--y` must name **WGS84 longitude/latitude** columns. EQuIS stores
coordinates in whatever datum it was given, so `X_COORD` may be longitude in
one facility and a projected easting in the next; the publisher refuses
coordinates outside WGS84 ranges rather than guess.

It also refuses, with the reason, when:

- a partition's row count disagrees with the manifest;
- the export has no `DETECT_FLAG` (every result would read as a non-detect);
- one sample or location carries conflicting values across rows;
- a depth unit is not one it can convert to metres.

Locations without coordinates are kept and counted, and shown as a count in
the app rather than drawn at an invented position.

### 2. Host both folders

Serve the sidecar folder and the export over HTTP(S) with CORS. The host
**must honour HTTP Range requests** and expose `Content-Length` and
`Content-Range` through CORS. Azure Blob Storage and S3 do. A server without
Range support still works, but the browser then downloads every partition
whole. `python -m http.server` is one such server.

A signed URL can carry its token in the manifest URL's query string; it is
appended to each partition URL and never written into SQL.

### 3. Open it

In the hosted app, paste the manifest URL into the connect screen, or
link to `#manifest=<URL-encoded manifest URL>`. Locally:

```bash
VITE_ARII_MANIFEST_URL=https://host/path/to/export/manifest.json pnpm dev
# add VITE_DATA_URL=<sidecar folder> if it is not chemrooms/ beside the manifest
```

The sidebar shows the facility, result and partition counts, and how old the
partitions are (`as_of` from the manifest, flagged when it is not recorded).
If the sidecars were built from a different manifest, or a partition's row
count has changed, the app refuses to open the source and says why:
republish the sidecars whenever the export's manifest changes.

### What to expect

Measured on a 3.45-million-row, 10-partition export (Chrome, local Range
server, so no network latency):

| | Time | Partition bytes read |
|---|---|---|
| Open the project | 20 s | 0.7 MB (file footers only) |
| First single-analyte map | 13 s | 9 MB |
| Select a station: inspector and two time series | 15 s | 5 MB |

Above 20,000 samples, the view with no analyte selected draws one point per
sampling location and depth interval instead of one per sample.

See [arii-parquet-source.md](arii-parquet-source.md) for the design, the
parity test against a full conversion, and open questions.

## Terrain tilesets and geoid

`client/public/tiles/<name>/tileset.json` directories become toggleable
layers in the Layers panel; `pnpm dev` and `pnpm build` regenerate
`tiles/manifest.json`. `client/public/geoid/local.json` corrects surveyed
NAVD88 elevations to ellipsoidal heights. Both are built with the scripts in
[utils/](utils/README.md).

## Development

```bash
cd client
pnpm test:run          # vitest
npx tsc --noEmit       # typecheck
pnpm build             # production build into client/dist
```

ChemDuck's own tests, including the hybrid ARII parity test, live in the
chemduck repository (`python tests/test_arii_hybrid.py`).

The Cesium integration is a slice vendored in `client/src/cesium/`; see its
`index.ts` for its history. All other `@sqlrooms/*` packages come from npm.

## Deployment

`.github/workflows/deploy-pages.yml` builds the client on pushes to `main`
and publishes it to GitHub Pages **without project data**: no `VITE_DATA_URL`,
no `server/data`, and the site-specific terrain, models and geoid grid under
`client/public/` are removed from the published build (local development
still uses them). The Cesium Ion token comes from the `VITE_CESIUM_ION_TOKEN`
repository secret.
