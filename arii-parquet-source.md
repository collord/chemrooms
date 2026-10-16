# ARII parquet as a chemrooms data source — design brief

Status: **implemented 2026-10-16**, on chemrooms branch
`sqlrooms-029-tailwind4-arii` and chemduck branch `arii-hybrid`; not yet
merged. Written 2026-10-15 as a design brief; sections 1 to 12 are the brief
as written, with the open questions answered in place. Section 0 says what
was built and what was measured.

## 0. Implementation status (2026-10-16)

### What exists

| Piece | Where |
|---|---|
| Publisher, results-view generator, bootstrap SQL, consumer opener | chemduck `tools/arii_hybrid.py` |
| Shared results SELECT (loader and view), text-date parsing | chemduck `tools/load_data.py` `results_select_sql`, mapping `source.date_formats` |
| Parity gate on any manifest | chemduck `tools/check_arii_parity.py` |
| Tests: parity, refusals, typed columns, bootstrap | chemduck `tests/test_arii_hybrid.py` |
| One-command publish for chemrooms (sidecars + catalogs + vis specs) | chemrooms `server/publish_arii.py` |
| ChemDuck SQL sync, replacing the hand copy | chemrooms `server/sync_chemduck.py` |
| Browser side: manifest check, range-read registration, results view | chemrooms `client/src/setup/ariiSource.ts` |
| Catalog views (materialized for ARII) | chemrooms `client/src/sql/chemrooms_catalogs.sql` |
| Freshness and refusal display | chemrooms `client/src/components/SourceBadge.tsx` |

To open an ARII export:

```
python server/publish_arii.py <manifest.json> <out_dir> --x LONGITUDE --y LATITUDE
VITE_DATA_URL=<url of out_dir> VITE_ARII_MANIFEST_URL=<url of manifest.json> pnpm dev
```

### Measured on the test facility, 2026-10-16

Development workstation (Windows 11). Browser numbers are Chrome
(SwiftShader WebGL) against a local Range-capable server that counts the
bytes it sends, so they include no network latency; expect blob storage to
be slower in time, not in bytes.

| | |
|---|---|
| Full conversion with the chemduck loader | 274.6 s |
| `publish` (sidecars) / `publish_arii.py` (sidecars + vis specs) | 17 s / 37 s |
| Sidecar folder | about 1 MB |
| Parity: tables, `v_analyte_summary`, 1,080 `aggregate_results` recipes over the 8 most-measured analytes | identical |
| Browser: open, until the 526-analyte picker is filled | 19.6 s; partitions 0.73 MiB in 47 requests (footers); sidecars 1.0 MiB |
| Browser: first Arsenic map, 5,610 rows | 13.3 s; 9.14 MiB in 174 range requests |
| Browser: select a station, inspector + time series of 2 analytes | 15.3 s; 4.81 MiB in 74 requests |

### Found while building it

- **DuckDB-WASM 1.32 downloads a registered HTTP file whole by default.**
  With default filesystem settings the first footer read fetched each
  partition in one plain GET (43 MiB for WS/N). `filesystem:
  {reliableHeadRequests: false, allowFullHTTPReads: true,
  forceFullHTTPReads: false}` on the connector turns on range reads: one
  partition's footer plus one analyte went from 26.6 MiB in 1 request to
  0.18 MiB in 8. Set in `client/src/store.ts`.
- **The chemduck ARII loader dropped every sample on real data.** Dates are
  text in the export; a plain cast read them as NULL. Fixed with the
  plugin's date formats, in its order (all 67,064 distinct dates
  parse).
- **A NULL in a view is INTEGER.** The hybrid `meas_basis` column broke
  `COALESCE(meas_basis, '')`; parity could not see it because every value
  is NULL. The shared SELECT now casts every column; a test compares the
  view's types with the table's.
- **One entity per sample does not scale.** With no analyte selected,
  the test facility's 104,540 drawable samples made 105,245 Cesium entities and kept
  the main thread busy for minutes. Above 20,000 samples the layer now draws
  one entity per sampling point (3,888 at the test facility); the demo's 9,940 samples
  are drawn as before.
- **The catalog queries scanned every result.** The analyte list and the
  location inspector grouped `results` through `samples`, which pushes no
  filter into the results scan. They now read `analyte_catalog` and
  `location_analytes`, views for a ChemDuck project and materialized
  sidecars for ARII.
- **Running the app found two SQLRooms 0.29 regressions** (panels need a
  `panel` field; resium 1.20.0's bundled JSX runtime), fixed on the same
  branch before this work.

### Still open

- **Q3 is the user's decision**, with the counts below.
- **Q5** (merging the feature-service location list) and **Q6** (a QC
  fixture: field duplicates and blanks excluded by default) are not done.
- **The moisture lookup** in ChemDuck's `v_results_denormalized` filters
  `UPPER(analyte) IN (...)`, which blocks row-group pruning, so every query
  reads the analyte column of every row group (1.18 MiB at the test facility). A
  chemduck change, affecting every consumer.
- **Matrix filters prune nothing** (Q2). Exposing the Hive `matrix` key on
  the view and a redundant predicate in ChemDuck's views would let them;
  also a chemduck change.
- **Row-group size drives bytes.** A one-analyte map reads whole 50,000-row
  row groups of about 15 columns. Smaller row groups in the export
  pipeline would cut that; measure before changing the shared skill.
- **The time series has its own copy of the non-detect rules**, in
  TypeScript (`TimeSeriesPanel.tsx`), the kind of copy section 2 rejects.
- **Not tested against real blob storage.** The local server honours
  Range; Azure does, but CORS must expose `Content-Range` and
  `Content-Length`.

## 1. What this is for

Chemrooms reads data in the ChemDuck model (`locations` → `samples` →
`results`, plus catalogs, views and macros). A growing share of the data it
needs to show comes from EarthSoft EQuIS as **Analytical Results II (ARII)**
report output: one wide row per result, with location and sample fields
repeated on every row. That output already exists as Hive-partitioned
parquet with a published `manifest.json`, produced by the
`equis-parquet-export` skill in the QGIS plugin repository.

The goal is for chemrooms to open such a parquet set directly and run its
whole existing feature set (map layers via `aggregate_results`, time series,
analyte picker, filters, bookmarks) against it, without a separate data
model inside chemrooms and without requiring a full offline conversion
first.

## 2. The decision

**Decided: a hybrid source.** For an ARII source:

| ChemDuck table | Provided as | Built when |
|---|---|---|
| `results` | a **view** over the ARII partitions, renaming and typing columns into ChemDuck's `results` shape | at room load, in the browser |
| `samples` | a small **materialized parquet** ("sidecar") derived from ARII by GROUP BY on `SYS_SAMPLE_CODE` | at publish time, server side |
| `locations` | a sidecar, GROUP BY `SYS_LOC_CODE` | at publish time |
| catalogs the UI scans for (`v_analyte_summary`, `v_available_filters`) | sidecars | at publish time |
| `screening_levels`, `unit_conversions`, `aggregation_rules`, etc. | unchanged ChemDuck parquet | as today |

Everything above `results`/`samples`/`locations` — the ChemDuck views,
macros and `aggregate_results` — runs **unchanged**. That is the point of
the design: the ChemDuck SQL is the single home of the domain rules.

### Rejected alternatives, and why

- **A separate ARII data model inside chemrooms.** Every rule chemrooms
  depends on (non-detect substitution, fraction separation, duplicate and
  event collapse) would need a second implementation keyed on ARII column
  names. The QGIS plugin already maintains three copies of the non-detect
  rules, each held by its own parity test. A fourth copy, in TypeScript, is
  the outcome this design exists to avoid. All of chemrooms' SQL builders
  and vis specs are keyed on ChemDuck column names.
- **Insist on full conversion to ChemDuck before use.** Conversion is cheap
  (section 3), so cost is not the objection. The objection is that it does
  not address the real bottleneck for a large facility: moving millions of
  rows into a browser tab. A view over analyte-sorted partitions lets the
  browser read only the row groups a query needs. Full conversion remains
  the right path for non-EQuIS sources and stays supported.
- **Put non-core ARII fields in ChemDuck's EAV tables.** EAV turns typed
  columns into strings and makes every attribute read a pivot. For ARII the
  fields that matter are known in advance, so they become real columns
  (section 5.3). EAV stays for genuinely unknown columns from ad-hoc
  sources.

## 3. Evidence

Measured 2026-10-15 on the development workstation (Windows 11, native
DuckDB via Python, 8 threads, 8 GB memory limit) against the full test-facility
export: 3,452,146 rows, 10 partitions, 121 MB, 71 columns. Script:
`bench_normalize.py` (kept outside the repo; reproduce from section 5 if
needed). **Native timings, not DuckDB-WASM.** WASM is single-threaded and
reads over HTTP, so re-measure there before relying on any number.

| Operation | Time | Output |
|---|---|---|
| `locations` by GROUP BY | 0.1 s | 906 rows |
| `samples` by GROUP BY | 1.1 s | 108,135 rows, 1.4 MB parquet |
| `results` projection into ChemDuck shape | 6.8 s | 34.5 MB parquet |
| EAV of the 6 result attributes in the chemduck mapping yaml | 6.2 s | 13.7M rows, 12.7 MB |
| Arsenic, WS, total: max per location, fully normalized tables | 0.05 s | |
| Same, hybrid (sidecars + `results` as view over ARII) | 0.07 s | |
| Same, directly on the raw ARII view | 0.02 s | |

Data facts about the test facility, all verified the same day:

- **Samples really are a level.** 0 of 108,135 samples have more than one
  location, date, matrix or start depth. The 15 sample-identifying columns
  are constant per `SYS_SAMPLE_CODE`, so a GROUP BY is lossless.
- **Partitions are sorted for analyte-first reads.** Files are sorted on
  `CHEMICAL_NAME, SYS_LOC_CODE, SAMPLE_DATE` in 50,000-row groups (WS/T: 17
  row groups, 800,083 rows). The plugin measured one analyte from Azure
  in 0.76 s with 0.25 MiB fetched over 5 range requests.
- 526 analytes, 906 locations; every row is `SAMPLE_TYPE_CODE = N`, because
  this export was cut without QC.

## 4. Architecture

```
 EQuIS ──(equis-parquet-export skill, nightly)──▶ <facility>/
                                                    manifest.json
                                                    matrix=WS/fraction=T/part-0000.parquet ...
                                                         │
                         chemrooms publisher (new) ──────┤ reads manifest + partitions
                                                         ▼
                                                    chemrooms/   (sidecars, new)
                                                      sidecars.json   source manifest identity, as_of, row counts
                                                      locations.parquet
                                                      samples.parquet
                                                      analyte_summary.parquet
                                                      available_filters.parquet
 Browser (DuckDB-WASM)
   1. fetch manifest.json + sidecars.json, check they belong together
   2. register sidecars as tables  locations, samples, catalogs      (SQLRooms `url` data sources: full download, fine)
   3. registerFileURL each partition (HTTP protocol, named by its Hive path), then
      CREATE VIEW results AS <mapping SQL> FROM read_parquet([those names], hive_partitioning=true)
                                                                    (chemrooms init code, NOT a SQLRooms data source; see Q1)
   4. load ChemDuck SQL (02_macros, 03_views, 08_aggregate_results) exactly as today
   5. everything downstream unchanged
```

The client chooses this path from configuration, not by sniffing columns.
A project is either a ChemDuck parquet set (today's `store.ts` data sources)
or an ARII manifest URL plus its sidecar folder.

## 5. Mapping specification

The canonical field mapping already exists:
`chemduck/tools/equis_arii_parquet_mapping.yaml`. **Decided: one mapping,
two outputs.** The same mapping generates the loader SQL (full conversion)
and the view SQL (hybrid), so a rename rule exists once. Where this brief
and the yaml disagree, fix the yaml and say so in the plan.

### 5.1 `locations` (sidecar)

`location_id = SYS_LOC_CODE`, `loc_desc = LOC_NAME`, `project =
FACILITY_CODE`, `x`, `y` from configured coordinate columns (5.5).
Chemrooms assumes WGS84 lon/lat in `x`/`y` (Chemrooms.md §3.5).

### 5.2 `samples` (sidecar)

`sample_id = SYS_SAMPLE_CODE`, `location_id = SYS_LOC_CODE`, `sample_date`
(5.4), `matrix = MATRIX_CODE`, `top_depth = START_DEPTH`, `bottom_depth =
END_DEPTH`, `depth = (top+bottom)/2`, `depth_units = DEPTH_UNIT`,
`sample_type = SAMPLE_TYPE_CODE`, `event = TASK_CODE`, `parent_sample_id =
PARENT_SAMPLE_CODE`.

**The publisher asserts constancy** for every sample-level column: if any
`SYS_SAMPLE_CODE` has more than one distinct value, publishing fails and
names the samples. Never `any_value()` silently. Same for locations.

### 5.3 `results` (view)

All ChemDuck `results` columns, per the yaml, **plus these promoted to real
typed columns** (they are in the yaml's `result_attributes` today):

| Column | Why it must be a column |
|---|---|
| `result_numeric` (`RESULT_NUMERIC`) | the measured value; NULL for a non-detect |
| `result_unit` (`RESULT_UNIT`) | unit of the measured value |
| `report_result_limit` (`REPORT_RESULT_LIMIT`) | the limit `REPORT_RESULT_VALUE` was built from |
| `test_type` (`TEST_TYPE`) | initial vs replicate; first tie-break in the plugin's pivot rule |
| `prep_method` (`PREP_METHOD`) | method identity |
| `reportable_result` (`REPORTABLE_RESULT`) | EQuIS's own reportability flag |

Also expose `matrix` on the view (from the Hive key), for partition pruning
(see open question Q2).

**`result_id` must not use a window function.** The plugin found that
`row_number() OVER ()` in a view blocks predicate pushdown and downloaded
the entire facility on the first query (31–60 s from Azure, against 1.6 s
without it). Use `(file index in manifest order) * 2^40 + file_row_number`,
as `equis_qgis/equis_loader/store.py` `_row_id_expression` does. Manifest
order makes ids stable across loads.

**`detected` comes from `DETECT_FLAG` only** (`Y` true, `N` false, blank
NULL). A source without `DETECT_FLAG` is refused with a message naming the
column. Without it every result reads as a non-detect and is halved under
½ DL, with no error (found in the plugin, 2026-10-08).

### 5.4 Dates

`SAMPLE_DATE` and `ANALYSIS_DATE` are **text** in the test facility's parquet, in
the form `3/1/2016 12:00:00 AM`. The plugin parses eight formats in Python
(`report_data.parse_date`); chemduck has its own date expression. **Decided
direction:** the export pipeline should write a real TIMESTAMP at collect
time, which retires both parsers. Until then the view parses with a
`strptime` list held to the plugin's format order, and the plan includes a
test that the two agree on the real data.

### 5.5 Coordinates

**Configured per source, never inferred from the column name.** On the test facility
`X_COORD`/`Y_COORD` are identical to `LONGITUDE`/`LATITUDE`; the chemduck
yaml comment says `X_COORD` is projected. EQuIS stores whatever datum it was
given. 76,119 rows have no coordinates at all; those locations must
still appear in the location list, flagged unplaced, not dropped and never
given a stand-in coordinate.

### 5.6 Depth units

The test facility's `DEPTH_UNIT` is `m` (779,267 rows), `cm` (331,986) or NULL
(2,340,893). Chemrooms converts depth with a hard-coded `* 0.3048`
(feet to metres) in `client/src/setup/buildSamplesLayerSql.ts`, which would
draw the test facility's boreholes at 30% of their depth and centimetre samples 100x too
deep. Depth must be canonicalized to one unit with the unit known, either
in the sidecar or in the layer SQL. That fix is needed for any source, not
only ARII.

### 5.7 Fraction, and the Hive key collision

ARII `FRACTION` is `T`, `D` or `N` (not applicable; 2,026,168 rows).
The yaml maps `T`→`Total`, `D`→`Dissolved` and passes `N` through. Keep `N`
as its own value; it is not NULL and not Total.

The partition files also carry **in-file** lowercase `matrix` and
`fraction` columns that collide with the Hive keys; DuckDB surfaces the
duplicate as `fraction_1`. The values agree on the test facility. The view must read
the Hive key for pruning and ignore the in-file duplicate, and the plan
should check this on a second facility.

### 5.8 Units

Unit conversion belongs to the export pipeline, using EQuIS's own factors
(`units.json`; the pipeline keeps `RESULT_VALUE_ORIGINAL` and
`RESULT_UNIT_ORIGINAL`). Chemrooms does not convert ARII units. A variable
reported in more than one unit is refused or flagged by ChemDuck's
`v_unit_conflicts` / `units_conflict`, not silently aggregated.

## 6. Domain rules that must survive

These come from the QGIS plugin's `CLAUDE.md`, where each was a real
failure that produced a plausible wrong number rather than an error.

1. A non-detect is not a small measurement, and can never be a location's
   maximum while a detection exists there.
2. Detection comes from `DETECT_FLAG` and nothing else.
3. Never aggregate across fractions.
4. Matrices combine only when their units agree.
5. Two methods on one sample are real data, not duplicates.
6. A filter on a column the source lacks matches everything.
7. Location codes join case-insensitively.
8. Stale data is marked wherever it appears. Each partition carries its own
   `as_of`, and the UI must show it.

## 7. Prerequisites the planner must schedule first

- **Chemrooms' ChemDuck SQL is out of date.** `server/data/sql/` differs
  from the chemduck repository in `02_macros`, `03_views`, `07_catalogs`
  and `08_aggregate_results`. The chemduck repo's `aggregate_results`
  (commit b17aa75, 2026-09-30) partitions on fraction and meas_basis and
  reports `units_conflict`. **Chemrooms' copy partitions its event collapse
  on location, matrix and depth only, so it combines dissolved and total
  across events.** That breaks rule 3 on any source and must be fixed
  before ARII is wired in, since ARII data is where both fractions appear.
  The plan should replace the copy with a sync from chemduck rather than a
  hand edit, and check the TypeScript callers against the new signature
  (it gained an optional `p_fraction`).
- **The depth unit fix** in 5.6.

## 8. Work areas for the plan

Scope the plan across these. The order is a suggestion.

1. **SQL sync and depth units** (section 7).
2. **Mapping generator** in chemduck: the yaml produces view SQL as well as
   loader SQL. Lives in chemduck so both consumers share it.
3. **Publisher**: a command that reads a manifest and writes the sidecars
   plus `sidecars.json`, with the constancy assertions. `server/main.py`
   already has an `export` command to extend.
4. **Client data source**: a project config that names an ARII manifest and
   its sidecar folder. Loads sidecars through SQLRooms `url` data sources.
   Builds the `results` view in init code with `registerFileURL` over the
   manifest's file list, because SQLRooms data sources always download and
   materialize (Q1). Then loads ChemDuck SQL as
   `client/src/setup/initEntityLayers.ts` does today. The sidecar tables
   must be ready before the view and the ChemDuck SQL run.
5. **Catalog loading**: `client/src/setup/loadCatalogs.ts` reads analytes
   from `v_analyte_summary`, a full scan; point it at the sidecar for ARII
   sources.
6. **Freshness UI**: show source name and per-partition `as_of`.
7. **Tests** (section 10).

## 9. Open questions

- **Q1. Resolved 2026-10-15: SQLRooms data sources cannot serve the
  `results` view.** First read from the fork at commit d88ebd4
  (2026-04-04), then confirmed on the published `@sqlrooms/room-shell`
  0.29.0 that chemrooms now depends on (`dist/RoomShellSlice.js`:
  `downloadFile` then `connector.loadFile`). The connector's `getDb()` is
  also present in `@sqlrooms/duckdb` 0.29.0. Chemrooms no longer uses the
  fork; see `client/src/cesium/index.ts`. Details, as read from the fork
  source:
  - A `url` data source downloads the **whole file** with `fetch`
    (`downloadRoomFiles` in `packages/room-shell/src/RoomShellSlice.ts`).
    It then registers the bytes as a temporary `BROWSER_FILEREADER` file,
    runs `CREATE TABLE <name> AS SELECT * FROM read_parquet(...)`
    (`packages/duckdb-core/src/load/load.ts`), and drops the file
    (`withTempRegisteredFile` in
    `packages/duckdb/src/connectors/WasmDuckDbConnector.ts`). A
    `loadOptions.view` flag exists but cannot help, because the file it
    would point at is dropped straight after.
  - A `sql` data source runs `createTableFromQuery` with the default
    `view: false`, so it also materializes the result.

  **Consequence.** Keep `url` data sources for the sidecars and the small
  ChemDuck tables, where a full download is what we want. Build `results`
  in chemrooms' own init code, alongside the ChemDuck SQL loading in
  `initEntityLayers.ts`:
  1. Get the `AsyncDuckDB` with `connector.getDb()`.
  2. Register each partition from the manifest with
     `registerFileURL(<hive path>, <url>, DuckDBDataProtocol.HTTP, false)`.
     Register it under its Hive path, such as
     `matrix=WS/fraction=T/part-0000.parquet`, so that `hive_partitioning`
     reads the keys from the name.
  3. Run `CREATE VIEW results AS ... read_parquet([those names],
     hive_partitioning=true)`. Running it directly through the connector
     works. So does `createTableFromQuery(..., {view: true})`.

  **Verified 2026-10-16, with one correction:** registered HTTP files are
  read by range requests only once the connector sets
  `filesystem: {reliableHeadRequests: false, allowFullHTTPReads: true,
  forceFullHTTPReads: false}`; with DuckDB-WASM 1.32's defaults each file
  is downloaded whole (see section 0).

  **Originally still to verify in the browser.** Confirm that the HTTP
  protocol issues range requests against the real host. The host must honour
  `Range` and expose `Content-Range` and `Content-Length` through CORS.
  Put a SAS token on each URL, never in the view text. The comment in
  `initEntityLayers.ts` says `read_json('https://...')` fails without
  httpfs. It may or may not apply to a registered HTTP file, so test it
  rather than assume. For contrast, loading the test facility through `url` sources
  would download all 121 MB and copy it into WASM memory before the first
  query.
- **Q2. Does partition pruning survive the views?** ChemDuck's views filter
  `s.matrix` on `samples`, not on `results`, so a matrix filter may never
  reach the `results` scan. Fraction pruning may be blocked by the
  `T`→`Total` CASE mapping over the Hive key. Analyte filters should prune
  row groups via `CHEMICAL_NAME` statistics. Measure with `EXPLAIN ANALYZE`
  and with bytes fetched in WASM. Possible fixes: add `matrix` to the view
  and a redundant predicate in the views; keep raw fraction codes for EQuIS
  sources; or partition-map in the catalog.

  **Measured 2026-10-16** (native DuckDB 1.5 with httpfs against the
  counting server, the test facility):

  | Query | MiB | Requests | Files read |
  |---|---|---|---|
  | `results` where analyte = 'Arsenic', count | 2.27 | 49 | 10 |
  | same, 15 columns | 4.65 | 75 | 10 |
  | moisture lookup inside `v_results_denormalized` | 1.18 | 105 | 10 |
  | `aggregate_results('Arsenic', ...)` | 6.18 | 189 | 10 |
  | same, matrix 'WS' | 6.01 | 180 | 10 |
  | same, `p_fraction := 'Total'` | 4.15 | 156 | 10 |

  Analyte filters prune row groups. Matrix filters prune nothing, because
  matrix is filtered on `samples`. The fraction filter reads less but still
  opens every file, since the T/D-to-Total/Dissolved CASE sits between the
  filter and the column. The moisture lookup's `UPPER()` defeats pruning on
  every query. The browser reads more than native DuckDB for the same map
  (9.14 MiB against 6.18). The fixes listed above remain open (section 0).
- **Q3. Which limit does ½ DL use?** The plugin's limit ladder starts with
  `REPORT_METHOD_DETECTION_LIMIT`; ChemDuck's `detection_limit` is
  `COALESCE(reporting_limit, method_detection_limit, quantitation_limit)`.
  The plugin's value ladder starts with `RESULT_NUMERIC`; the chemduck yaml
  maps `result` to `REPORT_RESULT_VALUE`. On the same data, QGIS and
  chemrooms can therefore plot different values for a non-detect. This is a
  domain decision for the user. The plan should surface it with counts from
  the test facility, not pick silently.

  **Counted 2026-10-16 on the test facility; the decision is still the user's.** The
  ladders agree far more than feared. All 1,836,971 detects get the same
  value. Of 1,615,175 non-detects, the 1,563,331 both ladders can value get
  the same value at ½ DL. They diverge on 51,844 non-detects (3.2%), all
  surface water (WS), in 7 field parameters (Color 34,135, Chlorophyll a
  9,044, settleable solids 5,875, Turbidity 1,563, Salinity 1,039, ...),
  that carry only a quantitation limit: the plugin's ladder has no
  quantitation limit, so QGIS plots nothing, while ChemDuck plots half the
  quantitation limit. Chemrooms keeps ChemDuck's behaviour until decided.
- **Q4. Resolved: chemduck owns the generic publisher**
  (`tools/arii_hybrid.py`, beside the loader it shares a mapping and a
  SELECT with); chemrooms wraps it (`server/publish_arii.py`) to add its
  catalogs and vis specs. The shared export skill is unchanged.
  *As written:* Recommended: chemrooms or chemduck
  owns it, reading the manifest as an input. Folding it into the shared
  `equis-parquet-export` skill's `publish_manifest.py` is possible later,
  but that skill is shared beyond these repositories.
- **Q5. Locations without results.** ARII only knows locations that have
  results (906 at the test facility); the facility's feature service lists many more.
  Decide whether the sidecar optionally merges the feature-service location
  list.
- **Q6. QC samples.** The test facility has none. A source with field duplicates and
  blanks must exclude them by default, as ChemDuck's
  `v_results_denormalized` does by sample type. Needs a synthetic fixture.

## 10. Acceptance criteria

- Opening the test facility's manifest in chemrooms shows the map, analyte picker,
  aggregation layers and time series with no ARII-specific code above the
  `results`/`samples`/`locations` layer.
- **Parity:** for a fixed set of (analyte, matrix, fraction, event_agg,
  nd_method) recipes, `aggregate_results` returns identical rows whether
  the test facility was fully converted with the chemduck loader or opened as a hybrid
  source. This is the gate for the hybrid, in the spirit of the plugin's
  `test_store_parity.py`.
- Row count of the `results` view equals `manifest.json` `rows`; a
  mismatch refuses to open.
- A source without `DETECT_FLAG` is refused with a message.
- Sidecars that do not match the manifest they were built from are refused.
- **Measured in DuckDB-WASM**, recorded with date and machine: time to
  first map and bytes fetched for a single-analyte layer on the test facility. Target
  to set in the plan; for reference, the plugin read one analyte from Azure
  in 0.76 s.
- The test facility's boreholes render at their true depth in metres and centimetres.

## 11. Out of scope

- Live EQuIS API fetches from the browser.
- Writing back to EQuIS.
- Unit conversion in chemrooms.
- Changing how the export skill slices or schedules reports.

## 12. Where to look

| Path | What it holds |
|---|---|
| `Chemrooms.md` | Chemrooms spec and ChemDuck table reference |
| `client/src/store.ts` | Current data sources (ChemDuck parquet via `type: 'url'`) |
| `client/src/setup/initEntityLayers.ts` | Loads ChemDuck SQL in the browser |
| `client/src/setup/buildSamplesLayerSql.ts` | `aggregate_results` call; the feet assumption |
| `client/src/setup/loadCatalogs.ts` | Analyte list from `v_analyte_summary` |
| `client/src/layers/layerSchema.ts` | `dataSource` union a new source type may join |
| `client/node_modules/@sqlrooms/room-shell/dist/RoomShellSlice.js` | `downloadRoomFiles`: url sources are fetched whole (0.29.0) |
| `client/node_modules/@sqlrooms/duckdb/dist/connectors/WasmDuckDbConnector.d.ts` | `getDb()` for `registerFileURL` |
| `client/src/cesium/` | The vendored Cesium slice; chemrooms no longer links the sqlrooms fork |
| `server/main.py`, `server/data/sql/` | Export command; the stale ChemDuck SQL copy |
| `../chemduck/sql/` | Current ChemDuck schema |
| `../chemduck/tools/equis_arii_parquet_mapping.yaml` | The ARII→ChemDuck mapping |
| `../chemduck/tools/load_data.py` | Full-conversion loader; `_staging_parquet` reads manifests |
| `../chemduck/docs/FUTURE_ARCHITECTURE_PLAN.md` | Prototype: `results` as a parquet view binds all 26 views |
| `../dma/equis_qgis/CLAUDE.md` | Domain rules and measurements |
| `../dma/equis_qgis/equis_loader/store.py` | `from_parquet`: the same idea in Python, row ids, refusals |
| `../dma/equis_qgis/equis_loader/report_data.py` | `COLUMNS` ladders and `REQUIRED_FOR_ANALYSIS` |
| `../dma/equis_qgis/docs/pivot-design.md` | Cell-resolution rules for multivariate views |
| `../dma/equis_qgis/.claude/skills/equis-parquet-export/references/layout.md` | Partition layout, manifest, reading it back |
