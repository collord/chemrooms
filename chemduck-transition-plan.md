# Moving Chemrooms to the QGIS plugin's ChemDuck + ARII stack: the plan

**Written 2026-11-25.** This is a plan only; nothing in it is built yet. The
facts come from these sources:

- the QGIS plugin (`equis_qgis_public`) at `8aa09fe`, with its uncommitted
  re-vendor of ChemDuck to `ee6b160`;
- the plugin's `docs/chemduck-adoption-plan.md`, `docs/chemduck-spike.md`
  and `docs/chemduck-parity.md`;
- ChemDuck's `docs/shared-rules-decisions-response.md`;
- this repository at `affe146`.

Background on the ARII source is in [arii-parquet-source.md](arii-parquet-source.md).

## Where the plugin has got to

- **ChemDuck is vendored at a pinned commit, in two places.**
  - The plugin's copy is `equis_loader/chemduck/` and the pipeline's is
    `pipeline/parquet_source/chemduck/`. Both are written by
    `tools/vendor_chemduck.py` from the same commit.
  - Every file is hashed in `VENDORED.json`. `tools/test_chemduck_vendor.py`
    fails if either copy is edited or the two differ by a byte.
  - The pin is moving from `b81dd01` to `ee6b160` (ChemDuck PR #20,
    "duckdb-2", which adds DuckDB 2.0.0 to `SUPPORTED_DUCKDB`). That move
    is not yet committed in the plugin.
- **The pipeline publishes ChemDuck's sidecars every night.**
  - The step is `parquet_source/chemduck_sidecars.py`, step 5 of
    `run_nightly.py`. It writes `chemduck/` beside `manifest.json`.
  - That is the same `arii_hybrid.publish()` that this repository's
    `server/publish_arii.py` runs by hand.
  - The folder is deliberately not listed in the manifest. `sidecars.json`
    records the manifest's SHA-256, so a reader can tell current sidecars
    from stale ones.
  - If the sidecar step fails, the night still publishes the data, and the
    previous sidecars stay in place, now stale.
- **The plugin uses ChemDuck's newer macros, not 0.1's:**
  - Maps: `aggregate_points` / `rollup_points`.
  - Footer count: `point_counts`.
  - Time series: `point_series`.
  - Pivots: `sample_cell_maps`.
  - Box plots: `km_quartiles` / `km_quartiles_of`.
  - Pickers: the catalogue views, one row per method class.
  - Non-detects: named policies (`p_nd_policy`), plus `p_display_factor`
    for drawing.
  - Every macro takes the row scope: dates, sample types, reportable only,
    depth and units.
- **Speed was measured on Facility A and tuned with ChemDuck.** At 4 threads
  in native Python (2026-11-05), a map takes 0.26–0.35 s, `point_counts`
  0.08–0.09 s, and one location's series 0.21–0.22 s.

## Where Chemrooms is behind

1. **It uses an old ChemDuck.**
   - The SQL in `server/data/sql/` comes from `206b7d1` (generated
     2026-10-16), copied from a sibling `../chemduck` checkout by
     `server/sync_chemduck.py`.
   - The client loads 4 SQL files. ChemDuck's consumer bundle
     (`arii_hybrid.CONSUMER_SQL`) now has 7: `08_aggregate_points`,
     `10_sample_results` and `11_ism` are missing.
   - The local `../chemduck` checkout (`4017ace`) is also older than the
     plugin's pin.
2. **Its maps run the old rules.**
   - `buildSamplesLayerSql` calls
     `aggregate_results(..., dup_agg, nd_method)`, which runs
     `aggregate_results_legacy`.
   - That is ChemDuck 0.1's code, kept only so Chemrooms' maps would not
     change.
   - It averages samples taken on the same day by default, has no
     sample-type scope and uses no named non-detect policies.
3. **The time series has its own copy of the non-detect rules.**
   [TimeSeriesPanel.tsx](client/src/components/TimeSeriesPanel.tsx) writes its
   own limit chain (reporting limit, then method detection limit, then
   quantitation limit). It ignores reruns and the reportable flag.
4. **It needs its own publish step.** An ARII project reads a `chemrooms/`
   folder built by `publish_arii.py`. That folder adds to ChemDuck's
   sidecars:
   - `analyte_catalog` and `location_analytes`, from
     `client/src/sql/chemrooms_catalogs.sql`;
   - vis specs.
5. **It can't tell which ChemDuck a data folder was built with.**
   `ariiSource.ts` checks the `sidecars.json` format version and the manifest
   hash, but not the ChemDuck behind the macros it calls.
   - A vendored ChemDuck writes `commit: null` into `SOURCE.json`.
     `_chemduck_revision` looks for a `.git` folder beside the package, and
     a vendored copy has none.
   - So a folder the pipeline publishes says only "0.2.0", the version for
     every commit since 2026-10-28. *Confirmed 2026-11-25:*
     `write_consumer_bundle` run from the plugin's vendored copy wrote
     `"commit": null`.
6. **Its DuckDB-WASM version isn't the one ChemDuck tests against.**
   *Measured 2026-11-25* by running `select version()` in each package
   under Node:
   - Chemrooms pins `@duckdb/duckdb-wasm` 1.32.0, which is **DuckDB 1.4.3**.
   - ChemDuck's `tests/wasm` check runs 1.33.1-dev57.0, which is DuckDB
     1.5.4.
   - `SUPPORTED_DUCKDB` lists only Python versions (1.5.4, 1.5.5, 2.0.0).
   - Even so, the `ee6b160` consumer bundle loads and every macro answers on
     the demo under 1.4.3, 1.5.4 and 2.0.1.
7. **The demo data is too old for the new SQL.** `server/data`'s parquet
   lacks 20 columns that the `ee6b160` views read, among them
   `results.reported_units` and `results.method_class`. The bootstrap
   deliberately never alters `results`, so `03_views.sql` fails. Phase 0
   must re-export the demo, not only re-sync its SQL.

## Phases

Each phase ends with something run and seen, and leaves the app deployable.

### Phase 0: pin ChemDuck and load its whole bundle (maps don't change)

- Vendor ChemDuck into `server/chemduck/` at the plugin's commit, with the
  plugin's tool and the same `VENDORED.json` check. `sync_chemduck.py` and
  `publish_arii.py` import that copy instead of defaulting to `../chemduck`.
- Have the client load the SQL files named in `sql/SOURCE.json`'s `files`
  list, not four hardcoded URLs in `initEntityLayers.ts`. Re-export the demo
  data and regenerate `server/data/sql/` from the same commit.
- Keep running `02_macros.sql` twice (before and after the views), as
  `initEntityLayers.ts` does now. Under DuckDB 1.5.4 and 2.0.1, its first
  pass stops at a macro that reads `v_results_denormalized`, which doesn't
  exist yet. Under 1.4.3 the first pass succeeds.
- Run ChemDuck's `tests/wasm` check at Chemrooms' DuckDB-WASM version, or
  upgrade DuckDB-WASM. Upgrading may mean upgrading SQLRooms (0.29 today).
- Ask upstream to write the vendored commit into the published
  `SOURCE.json`, for example from `VENDORED.json`. Chemrooms then refuses or
  warns on a ChemDuck outside the range it supports.

*Done when:* the demo and Facility A draw exactly as before, still on the
legacy macro, with the full bundle loaded.

> *Done 2026-11-25 on the demo, branch `chemduck-transition`.* ChemDuck is
> vendored at `b5fdcd9` (PR #21), the commit the plugin pinned that day
> (`server/vendor_chemduck.py`, `server/tests/test_chemduck_vendor.py`).
> `sync_chemduck.py` and `publish_arii.py` use the vendored copy, and add
> its commit to `SOURCE.json` and `sidecars.json`.
> `server/export_chemduck.py` replaces `main.py export`. It writes each
> table in the current ChemDuck's shape, padding missing columns with NULL,
> and writes the bundle and vis specs, so one command makes a complete
> folder. The demo was re-exported with it.
>
> The client loads the files `SOURCE.json` lists (`chemduckBundle.ts`),
> retrying across files as ChemDuck's `load_consumer_sql` does.
> `chemduckBundle.test.ts` loads the demo's whole bundle into the app's
> DuckDB-WASM (1.4.3) and calls `aggregate_results`, `aggregate_points`,
> `point_series` and `km_quartiles`.
>
> The app opened on it in headless Chrome: "ChemDuck 0.2.0 at b5fdcd9: 7
> SQL files", and the map drew.
>
> Found on the way:
> - `index.html` preloaded DuckDB-WASM **1.31.0** while the app ran 1.32.0,
>   so every cold load fetched an engine it never used. The version is now
>   filled in by Vite from the package SQLRooms resolves.
> - Chrome still reports the preload as unused, and each engine file is
>   requested twice. Whether the second request comes from the HTTP cache
>   hasn't been measured.
>
> Not done: Facility A (its data isn't on this machine), and the WASM
> version check against ChemDuck's `tests/wasm`, which the engine test
> above stands in for.

### Phase 1: open the pipeline's `chemduck/` folder

- A manifest URL on its own finds `chemduck/sidecars.json` beside it.
  `chemrooms/` stays as a fallback for folders published before this.
- Replace `analyte_catalog` with ChemDuck's catalogue sidecars:
  `analyte_summary`, `available_filters`, `position_summary` and
  `method_class_summary`.
- `location_analytes` has no ChemDuck equivalent. Ask ChemDuck for it as a
  sidecar rather than scanning remote results in the browser.
- Build vis specs in the browser from the small sidecars, so a facility
  needs no Chemrooms-only step.
- If the sidecars are stale (their hash doesn't match the manifest), say so,
  with the date they were built, instead of a generic failure.
- Watch for a new publish, as the plugin does (`ReportStore.from_manifest`,
  `dialog._check_manifest`).
  - The pipeline rewrites `part-0000.parquet` in place.
  - The plugin found that a session with DuckDB's metadata caches on read
    the new bytes with the old metadata and failed.
  - Before Chemrooms turns those caches on, it needs the same watch: re-read
    `manifest.json` and reopen on a change.
- `publish_arii.py` becomes optional, for local exports with no pipeline in
  front of them, and a thin wrapper around the vendored `publish()`.

*Done when:* a facility the pipeline published opens from its manifest URL,
with no Chemrooms publish.

> *Done 2026-11-25, except where noted.*
>
> **What was built:**
> - **Finding the folder.** `main.tsx` looks for `chemduck/sidecars.json`,
>   then `chemrooms/`, before the app is imported (`sidecarProbe.ts`). The
>   store loads only the optional sidecars `sidecars.json` lists.
> - **`analyte_catalog`** is built from ChemDuck's `analyte_summary`
>   (`analyte_catalog_from_summary.sql`). It loses analyte groups and CAS
>   numbers. The two exports tried here have no `ANALYTE_TYPE`, so their
>   group was already "Other".
> - **`location_analytes`** stays a live view.
> - **Vis specs** for local tables are built in the browser
>   (`buildDefaultVisSpec.ts`). A test holds them to `vis_specs.py`'s on the
>   demo.
> - **Stale sidecars** are refused with the date they were built.
>
> **Found:** `vis_specs.py` wrote boolean categories as "True"/"False", but
> the client matches `String(value)`, "true". So `detected` has never
> coloured by its spec. Fixed.
>
> **Seen:** Facility C (a smaller real export), with a `chemduck/` folder published as
> the pipeline publishes it (`commit: null`, no vis specs, no Chemrooms
> catalogues), opened from its manifest URL alone. It reported 408 analytes
> and drew its map.
>
> **Not done:**
> - **The manifest watch.** It isn't needed today: the browser never turns
>   on `parquet_metadata_cache`, which ChemDuck's Python `open_consumer`
>   does.
> - **A `location_analytes` sidecar from ChemDuck.** On Facility B, the live
>   view costs a location click 3.9 s cold and about 9 MB (phase 2's table).
>   Ask ChemDuck to publish a per-location catalogue.

### Phase 2: measure speed in WASM (a gate before Phase 3)

- Time `aggregate_points`, `point_counts`, `point_series` and `km_quartiles`
  in DuckDB-WASM over HTTP on Facility A, beside today's
  `aggregate_results` call for the same question. Record the date, the
  machine and the browser.
- Use the plugin's budgets: map ≤ 0.5 s, count ≤ 0.2 s, one series ≤ 0.2 s,
  every location's series ≤ 1 s.
- WASM runs on one thread here, and neither the plugin nor ChemDuck has
  measured that. ChemDuck found its macros fastest at 4 threads, and the
  plugin found a per-call cost even on tiny inputs.
- If a call is over budget, raise it with ChemDuck with the numbers, as the
  plugin did (ChemDuck's `docs/qgis-plugin-requests-changelog.md`).

*Done when:* every call has a recorded time, and any call over budget is
either fixed or raised with ChemDuck.

> *Measured 2026-11-25. Every call is over budget. Not yet raised with
> ChemDuck.*
>
> **Setup:**
> - **Data:** Facility B, a real ARII export kept off this repository:
>   5,719,622 results in 26 partitions, 7,871 locations, 200,385 samples. It is larger
>   than Facility A (3.45 M).
> - **Sidecars:** published with the vendored ChemDuck `b5fdcd9` in 45 s.
> - **Browser:** headless Chrome on this laptop, running the app's DuckDB-WASM
>   (1.32.0, DuckDB 1.4.3, one thread). It read the partitions over HTTP Range
>   from a local server, so there was no network latency.
> - **Query:** the most-measured variable in `analyte_summary`.
> - **Runs:** four per call (`window.__chemroomsQuery`, dev builds only).
>
> **Open:** 13.0 s, 3.5 MB.
>
> | Call | Budget | First | Warm (3 runs) | Read, 4 runs |
> | --- | --- | --- | --- | --- |
> | Map today: `aggregate_results`, legacy recipe | | 0.86 s | 0.88, 0.92, 1.75 s | 1.8 MB |
> | Map: `aggregate_points` | 0.5 s | 1.15 s | 1.07, 1.09, 1.26 s | 0.3 MB |
> | Footer: `point_counts` | 0.2 s | 0.50 s | 0.51, 0.72, 0.80 s | cached |
> | One location's series: `point_series` | 0.2 s | 0.88 s | 0.64, 0.65, 0.76 s | cached |
> | Time series today (TimeSeriesPanel SQL) | | 0.61 s | 0.50, 0.54, 0.68 s | 0.2 MB |
> | Every location's series: `point_series` | 1 s | 2.20 s | 2.37, 2.72, 2.76 s | cached |
> | Box plot by location: `km_quartiles` | | 2.06 s | 1.90, 1.99, 2.01 s | 3.2 MB |
> | Inspector: `location_analytes`, live view | | 3.90 s | 1.16, 1.20, 1.26 s | 36 MB |
>
> **The same calls in native DuckDB 1.5.5** on the same local files, same
> day, warm:
>
> | Call | 1 thread | 4 threads |
> | --- | --- | --- |
> | Map today (legacy) | 0.57–0.72 s | 0.31–0.36 s |
> | `aggregate_points` | 0.93–1.37 s | 0.79–2.17 s |
> | `point_counts` | 0.44–0.48 s | 0.59–0.75 s |
> | One location's series | 0.47–0.54 s | 0.72–0.86 s |
> | Every location's series | 1.84–3.16 s | 1.72–1.85 s |
> | `km_quartiles` | 0.83–0.93 s | 0.79–0.82 s |
>
> **What the numbers say:**
> - **WASM isn't the cost.** The browser is about as fast as native on one
>   thread. Four native threads barely help these macros, and the machine
>   was busy. The time is in the shared-rules macros on a facility this
>   size.
> - **Against today's app,** a map moves from about 0.9 s to about 1.1–1.3 s.
>   The plugin's budgets are already missed by today's map.
> - **Facility C** (177,138 results, same day): every call took 0.15–0.42 s.
>
> **For ChemDuck,** as the plugin raised its own numbers:
> - the per-variable cost of `aggregate_points`, `point_counts` and
>   `point_series` at Facility B's scale;
> - a per-location catalogue sidecar, to replace the live
>   `location_analytes`.
>
> **The decision before phase 3:** go ahead at about 1.1–1.3 s per map, or
> wait for ChemDuck's speed work.

### Phase 3: maps on the shared rules

- In `buildSamplesLayerSql`, switch from `aggregate_results` to
  `aggregate_points`.
  - Chemrooms' entity key is already location, matrix, depth interval,
    fraction and basis, so each measurement point stays its own entity.
  - Chemrooms is 3D, so every depth interval can be drawn at its depth. The
    plugin's rollup question (decision 2 there) mostly doesn't arise here.
  - `rollup_points` is needed only if a flattened 2D view is wanted.
- Map the non-detect control to the dataset's policy plus
  `p_display_factor`. "Exclude" becomes a filter. Which policy is the
  default comes from the dataset, not from a constant in the browser.
- Drop `dup_agg`, which is same-day averaging.
- Migrate saved layer configs and bookmarks that still carry `dupAgg` or
  `ndMethod` (`layerSchema.ts`).
- In the pickers:
  - split variables by method class, so "pH (field)" and "pH (lab)" are two
    choices;
  - use ChemDuck's fraction names (Total/Dissolved).
- Expose the row scope in the filter toolbar: dates, sample types,
  reportable only, depth and units.
- Show provenance in the inspector: `selected_by`, `method_code`,
  `limit_source`, `limit_type`, `nd_policy`, `display_factor`,
  `unit_source`.
- Show refusals in the UI, not the console: mixed units, mixed matrix
  classes and `filters_ignored`.
- Add a parity gate: run Chemrooms' generated SQL on the plugin's fixture
  facility (`tools/chem_fixture.py`) and compare it with ChemDuck's direct
  answers. Deliberate rule breaks must fail it, following the plugin's
  mutation discipline.

*Done when:* the parity gate is green and has been mutation-checked. On
Facility A, a map for a fixed list of analytes matches the macro's answer
cell for cell. A refusal for mixed units has been seen in the UI.

> *Done 2026-11-25, apart from the row scope.* Decided by going ahead: the
> recommendations of decisions 1 and 2 (the display choice; every depth
> interval its own point).
>
> **What was built:**
> - **The map** calls `aggregate_points` (`buildSamplesLayerSql.ts`). The
>   entity id gains position and method class after its old six parts, so
>   old ids still parse.
> - **The non-detect control** is a display choice (`ndDisplay.ts`):
>   - the dataset's policy, which is the default (at the limit, under
>     `chemduck_default`);
>   - at the limit, half the limit, or zero (`p_display_factor`);
>   - hide.
>
>   Old names map to the nearest choice. A non-detect's label reads "<".
> - **`dupAgg` is gone.** `methodClass` takes its place in the recipe,
>   frozen layers, layer hash and bookmarks (`mc=`; `da=` is ignored).
> - **A method-class picker** appears when the analyte has more than one
>   class. It reads `variable_catalog`, which is `analyte_summary` for an
>   ARII source and `v_analyte_summary` otherwise.
> - **Refusals and ignored filters** reach the sidebar (`layerNotice.ts`,
>   `RecipeNotice`). A refused map shows the locations layer instead of an
>   empty globe.
> - **The inspector** shows provenance: sample, method, chosen by, limit,
>   drawn at, policy, unit source.
> - **One readiness flag.** Queries that call ChemDuck wait for
>   `selectChemduckReady`. A location from the URL had asked before init,
>   and failed with "point_series does not exist".
>
> **The gate:** `mapRules.test.ts`, on the demo in the app's DuckDB-WASM.
> - The map is `aggregate_points`, point for point, value for value, chosen
>   result for chosen result.
> - The display choice never changes which result is chosen.
> - "Hide" removes exactly the non-detects.
> - Labels mark non-detects, and the provenance columns are present.
> - It checks that its cases aren't vacuous. A first version passed on an
>   empty time series.
> - Five deliberate breaks each failed it: the display factor not passed,
>   hide not applied, labels unmarked, position dropped from the id, depth
>   dropped from a line's name.
>
> **Seen in the app:**
> - The demo maps Lead with the new rules.
> - Facility B's pH in surface water was refused with ChemDuck's message
>   ("pH in WS, N, method class field is in more than one unit (NONE: 57,
>   SU: 19073)"), and the method-class picker was offered.
>
> **Not done:** a cell-for-cell check on Facility A, whose data isn't on
> this machine.
>
> *The row scope, done 2026-11-25.* "Rows read" in the toolbar
> (`RowScopeControls.tsx`, `rowScope.ts`) covers dates, sample types,
> reportable only, depth (whole interval inside, in a chosen unit) and
> reported units.
> - **One place.** The scope lives in the recipe and goes to `aggregate_points`
>   and `point_series` alike (`rowScopeArgs`). Frozen layers, the layer hash
>   and bookmarks (`rs=`) carry it.
> - **Unscoped offers.** Lists are read from unscoped rows: sample types,
>   dates and depth units from `samples`; units from the analyte's results
>   in the chosen matrix, read only while the panel is open.
> - **Tests.** `mapRules.test.ts` holds the map to `aggregate_points` under
>   four scopes and checks that a date window and a depth bound bite.
>   Dropping the scope from the map, or from the chart, each failed it.
>
> **Seen in the app:** Facility B's pH in surface water was refused for
> mixed units. With only SU read, 3,483 points drew; from 2019 on, 2,739.
>
> **Found on the way:**
> - **Analyte maps on pipeline folders were uncoloured.** No vis spec covers
>   result columns, so Color by had nothing and every point was cyan. The
>   analyte map now gets a spec built without reading a row
>   (`analyteMapVisSpec`), and takes its range from the points drawn.
> - **The legend printed the spec's range,** while the map used the range
>   of the points drawn: "?" here, and a global range on the demo. Live
>   layers now publish the range they drew (`liveDomains`).
>
> **Changed for users:** an old link that didn't name a non-detect choice
> meant half the limit, and now opens with the dataset's policy.

### Phase 4: time series and charts

- Replace `buildTimeSeriesQuery` with `point_series`: one line per
  measurement point, labelled by depth.
- Any box plot or summary statistic uses `km_quartiles` or `km_quartiles_of`.

*Done when:* the time series for a fixed set of locations equals the macro's
answer, and a profile station plots one line per depth interval.

> *Time series done 2026-11-25; there are no box plots yet.*
> `buildTimeSeriesSql.ts` unions one `point_series` call per analyte.
> - **One line per measurement point,** named by only the parts that tell it
>   from the location's other points: matrix, fraction, depth, position,
>   method class. There's a colour legend, and non-detects are marked by
>   symbol.
> - **The demo's two-screen wells** (5–10 and 15–20) were one zig-zagging
>   line per analyte. They are now two lines.
> - **The x axis was ordinal,** samples evenly spaced whatever their dates,
>   because dates arrive as strings. It is now a time scale (`xScale:
>   'utc'`).
>
> The gate holds the chart's rows to `point_series`' rows and its lines to
> its points.

### Phase 5: remove the old paths

- Remove the legacy macro calls, then tell ChemDuck that
  `aggregate_results_legacy` can go, since Chemrooms was its only reason.
- Retire the sibling-checkout defaults and the `chemrooms/` fallback.
- Rewrite the README's data sections.

ChemDuck-format projects (not ARII) keep working through `server/main.py
export` and the vendored bundle. The newer macros run the same whether
`results` is a table or a view.

## Decisions to take

1. **How Chemrooms gets ChemDuck.** Recommended: vendor it at the plugin's
   pin and move both in lockstep. A facility the pipeline published, the
   plugin and Chemrooms then all run one commit.
2. **What the non-detect control means.** Recommended: adopt the plugin's
   decision 1. A non-detect is shown at its limit and marked as one; half the
   detection limit is a display factor only. Maps drawn this way will change
   from today's, and that is intended.
3. **Where `location_analytes` and vis specs come from.** The options are a
   ChemDuck sidecar, building them in the browser, or an optional extra
   pipeline step.
4. **How long to keep reading old `chemrooms/` folders.**

## Risks

- **Speed in WASM is unmeasured.** Phase 2 is the gate for it.
- **The app and its data can disagree.** The ChemDuck SQL travels with the
  data, so a ChemDuck 0.x that changes a macro signature can break the app
  with no build change. Phase 0's version check is what makes that visible.
- **Licensing.** ChemDuck is a private repository. Vendoring it into
  Chemrooms publishes it if Chemrooms is public. The plugin settled the same
  question as "ChemDuck is to be opened, licence to be chosen" (its decision
  7, 2026-10-29).
- **Private storage needs tokens.** If a facility sits on private Azure Blob
  storage, the browser needs a signed token in the URL. The plugin keeps a
  token out of every message, status line and log
  (`parquet_address.py`), and Chemrooms should do the same.
- **A stale folder can't be opened.** After a failed night, the sidecars are
  stale. The plugin reads its own store without them; Chemrooms cannot open
  a facility without `locations` and `samples`. Phase 1's message makes this
  understandable, but doesn't fix it.
