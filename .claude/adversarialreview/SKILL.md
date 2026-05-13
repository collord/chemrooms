---
name: adversarial-review
description: Adversarial architectural review for a Zustand + DuckDB-WASM +
  Mosaic client. Surfaces drift from the intent-in-store / data-in-queries
  separation, names concrete costs, and shows replacement code in the same
  stack. Use when reviewing a slice, hook, panel, or feature module for
  architectural soundness; when the user asks for critique, a "second
  opinion," or a review; or when a slice has grown past ~400 lines and
  hasn't been audited recently. Not for line-level bug hunting, not for
  style-linter issues, not for code currently being drafted.
---

# Adversarial review (chemrooms)

The goal is to name drift from good practice *in this stack*, not against
a generic style guide. Drift is the accretion of individually-reasonable
local decisions into a shape that wasn't designed. Bugs are symptoms;
drift is the thing.

## The canonical shape for this stack

A reader fluent in Zustand + DuckDB-WASM + Mosaic + sqlrooms expects a
specific separation. Name this anchor explicitly before you critique —
the review has to measure against something concrete.

**Zustand holds user intent.** Filter values, selections, aggregation
choices, render configuration, panel/tab/visibility flags, persisted
user-owned objects (personal layers, saved bookmarks), per-table UI
config that only changes when the user acts (color-by column, vis spec
overrides). Serializable. URL-hash-friendly. The thing a bookmark
captures.

**DuckDB-WASM holds data.** Tables, views, query results. Everything
the user could in principle ask a question of. Nothing in Zustand
should duplicate DuckDB contents.

**The query layer bridges them.** TanStack Query, Mosaic selections +
coordinator, or direct `useEffect`-plus-`connector.query` patterns —
the *mechanism* varies, but the *role* is fixed: take intent from
Zustand, issue SQL to DuckDB, own the result cache keyed on the
intent, track loading/error. Components subscribe to both layers;
the store itself never caches query output.

**Mosaic selections are the bridge for plot-linked data.** A
`Selection` is reactive filter state that plots and tables bind to.
When a Selection changes, Mosaic re-queries. Store intent that feeds
Mosaic belongs in Zustand; the resulting filtered data belongs in
Mosaic's coordinator, not in a store field.

**Catalogs (schemas, dictionaries, enum-like lookups) are query
results, not store fields.** `availableAnalytes`, `availableMatrices`,
`aggregationRules`, column types, table schemas — these look like
configuration but they're loaded from DuckDB. They belong in the query
layer with appropriate cache lifetimes (often `Infinity` or session-long).

## Stance

Be adversarial toward the code, not the author. Each decision was
probably locally reasonable — your job is to find the ones that
compound badly across the module, and to distinguish them from the
ones that are fine. Don't flag things because they violate a generic
convention; flag them because they cost something concrete
(invalidation bugs, hidden coupling, re-render storms, test
brittleness, refactor friction, context confusion for future agents).
If you can't name the cost, don't flag it.

Be direct. No "it might be worth considering." If you think something
is wrong, say so and say why. If you're uncertain, say that explicitly
— calibrated confidence beats polite hedging.

## Drift patterns to look for

These are the specific failure modes this stack tends toward. Scan
for them deliberately; they're the high-value finds.

**Query results in the store.** Fields like `locationSummary`,
`detections`, `analytesAt<something>`, any `Record<string, T[]>` keyed
by a filter value — these are usually query results stashed in the
store because it was handy when the query resolved. The cost is
manual invalidation (you have to remember to clear them when upstream
selection changes), duplicated loading state, and cache-coherence
bugs when two paths can populate the same field. Exemplar replacement
is almost always `useQuery` with the filter value in the query key.

**`isLoadingXxx` flags in the store.** These almost always indicate a
query cache that's been hand-rolled. A proper query layer tracks
loading per query key for free. If you see a loading flag in a
Zustand slice, the field it's tracking the loading of is probably
misplaced.

**Manual invalidation logic in setters.** A setter that also clears
other fields ("when selection changes, clear the summary and the
analytes-at-location") is doing cache invalidation that a query key
would do automatically. The setter logic isn't wrong — it's a sign
the cleared fields don't belong where they are.

**Catalog fields with setters called from hooks.** Pattern: a slice
has `availableAnalyteNames: string[]` plus `setAvailableAnalyteNames`,
and somewhere a hook does `const names = await query(...); setAvailableAnalyteNames(names)`.
That's a one-way data cache with extra steps. `useQuery` replaces
both the field and the setter.

**Derived state stored instead of computed.** Filtered counts, sorted
views, joined tables, "selected items" arrays computed from a
selection set plus a base table — if it can be derived from existing
state in <1ms, store the inputs and derive in a selector. Storing the
derivation creates two sources of truth.

**Mosaic-shaped state not using Mosaic.** If there's filter state
that drives multiple plots/tables and you're manually re-issuing SQL
on change, that's what Mosaic Selections are for. Not always worth
adopting for one case, but name it when the shape is clearly there.

**Store shape mirroring UI layout rather than domain intent.** Fields
named after panels (`leftPanelData`, `detailPanelSelection`) rather
than after what the user is asking (`selectedLocationId`,
`activeAnalyteFilter`) are a sign the store grew by "I needed state
for this panel" rather than by "the user has this intent." UI
visibility is fine to store; UI-layout-shaped data fields are drift.

**Store shape mirroring the database schema.** Opposite failure: a
slice with fields named after tables (`locationsData`, `samplesData`).
Means the store is being used as a cache of DuckDB. Same fix as
query-results-in-store.

**Actions doing transactional domain logic vs. actions doing field
updates.** Fine: `promoteBookmarkLayer` moves an item between two
lists atomically — that's a real transaction that needs to happen in
one `set` call. Not fine: an action that fetches, transforms, then
sets — that's a query masquerading as a state transition. The test is
whether the action is synchronous and pure over current state.

**Selector explosion at call sites.** If components routinely pull
five or six fields from the store with `useChemroomsStore`, and those
fields are always used together, there's a missing derived selector
or the grouping in the store is wrong. Cheap to fix, compounds
badly if ignored.

**Config vs. runtime mixing.** This slice wisely separates
`config` (bookmarkable intent) from runtime flags. Watch for new
fields being added to one that belong in the other. The test:
would you want this in a URL hash? If yes, config. If no, runtime.

## Method

1. **State the canonical shape for this file's role** (slice, hook,
   panel, etc.) before reading critically. One or two sentences. This
   is your anchor.

2. **Read once for macro-decisions.** Is the intent/data split
   correct? Is `config` vs. runtime correct? Are persisted vs.
   ephemeral fields correctly separated? Get these right before any
   micro-critique.

3. **Read again, scanning for the drift patterns above.** Note each
   instance with a line reference.

4. **Bucket each finding by severity:**
   - **Wrong shape**: the abstraction is doing something it shouldn't
     and the cost is concrete. Name it, explain the cost, show the
     replacement.
   - **Drift worth watching**: locally fine, but the pattern is
     visible enough that the next few instances will compound. Name
     the pattern, flag the threshold.
   - **Fine**: if the code is good, say so and move on. Don't fill
     space.

## Output format

For each finding:

**What.** Quote the specific code or name the specific pattern, with
line reference. Be specific enough that the author can `grep` for it.

**Why it's drift.** The concrete cost. Invalidation bugs, hidden
coupling, test friction, re-render cost, refactor expense later,
context bloat for agents. If you can't articulate a concrete cost,
the finding is weak — drop it or demote it.

**Exemplar pattern.** Show the replacement in real code — actual
TypeScript, actual `useQuery` / `Selection` / selector, in the same
stack. Not "consider using X." Write the three lines that would
replace the ten. If the replacement requires a library the project
doesn't yet use, name it and whether adopting it is worth it for
this alone vs. as part of a broader migration.

**Severity.** Wrong shape / drift worth watching / fine.

End with a **What's working** section naming the macro-decisions
that are right. The author needs to know which abstractions are
load-bearing and shouldn't be disturbed by any refactor prompted
by the review. This isn't softening — you can only be confidently
critical of specific things if you're confidently positive about
the rest.

## Anti-patterns in reviews themselves

Aim for three to seven substantive findings ordered by severity. A
forty-finding review is a review nobody acts on.

Cost every refactor recommendation. "Extract this into a query
layer" is cheap to say, expensive to do. Say roughly what it costs
and what it buys.

Don't hide behind "it depends." If the answer depends on context
you don't have, ask one question and stop. If you have the context,
commit.

Don't review against a style guide this project hasn't adopted.
Review against the idioms of the stack it actually uses.

Don't confuse "I would have written it differently" with "this is
wrong." The test: can you name a concrete cost the current shape is
paying?

## Exemplar exemplars

These are the shapes replacement code should take. Use them as
templates when writing the exemplar pattern for a finding.

**Query-result field → useQuery**:

```ts
// Before: in slice
availableAnalyteNames: string[];
setAvailableAnalyteNames: (names: string[]) => void;
isLoadingFilters: boolean;

// Before: in a hook somewhere
useEffect(() => {
  setIsLoadingFilters(true);
  connector.query('SELECT DISTINCT analyte ...').then((rows) => {
    setAvailableAnalyteNames(rows.map(r => r.analyte));
    setIsLoadingFilters(false);
  });
}, []);

// After
export function useAvailableAnalyteNames() {
  const connector = useConnector();
  return useQuery({
    queryKey: ['analyteNames'],
    queryFn: () => connector.query<{analyte: string}>(
      'SELECT DISTINCT analyte FROM v_analyte_summary ORDER BY analyte'
    ).then(rows => rows.map(r => r.analyte)),
    staleTime: Infinity,
  });
}
```

**Selection-keyed query result → useQuery with key**:

```ts
// Before
locationSummary: LocationSummary | null;
setLocationSummary: (s: LocationSummary | null) => void;
// Plus manual clearing in setSelectedEntity

// After
export function useLocationSummary(locationId: string | null) {
  const connector = useConnector();
  return useQuery({
    queryKey: ['locationSummary', locationId],
    queryFn: () => connector.query(locationSummarySql(locationId!)).then(first),
    enabled: locationId !== null,
  });
}
// No manual clearing. The query key changes, React Query handles it.
```

**Derived state → selector**:

```ts
// Before
visibleLayerIds: string[]; // stored, must be recomputed on every change

// After
export const selectVisibleLayerIds = (s: RoomStateWithChemrooms) =>
  s.chemrooms.personalLayers.filter(l => l.visible).map(l => l.id);

const ids = useChemroomsStore(selectVisibleLayerIds);
```

**Multi-plot filter → Mosaic Selection**:

```ts
// Before: matrixFilter in store, each plot does
//   useEffect(() => { connector.query(`... WHERE matrix = ${matrixFilter}`) }, ...)

// After: one Selection bound to all plots
const matrixSelection = useMemo(() => Selection.single(), []);
// Plots subscribe; changing matrixSelection re-queries all of them.
// The store still holds "current matrix choice" if it needs to persist
// to URL, but the query fan-out is Mosaic's job.
```
