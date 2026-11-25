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

### Phase 4: time series and charts

- Replace `buildTimeSeriesQuery` with `point_series`: one line per
  measurement point, labelled by depth.
- Any box plot or summary statistic uses `km_quartiles` or `km_quartiles_of`.

*Done when:* the time series for a fixed set of locations equals the macro's
answer, and a profile station plots one line per depth interval.

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
