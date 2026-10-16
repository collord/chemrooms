#!/usr/bin/env python3
"""
Publish an EQuIS ARII export as a chemrooms data folder.

    python server/publish_arii.py <manifest.json> <out_dir> --x LONGITUDE --y LATITUDE
        [--chemduck ../chemduck] [--memory-limit 8GB]

Then serve <out_dir> and run the client with

    VITE_DATA_URL=<url of out_dir>  VITE_ARII_MANIFEST_URL=<url of manifest.json>

The partitions are not copied: the browser reads them where the export
pipeline published them, by HTTP range requests (see
client/src/setup/ariiSource.ts). <out_dir> gets about 1 MB for the test facility:

  1. chemduck's tools/arii_hybrid.py publish: locations and samples
     sidecars, the ChemDuck SQL bundle, sql/results_view.sql and
     sidecars.json, refusing a source without DETECT_FLAG, with conflicting
     sample or location values, non-WGS84 coordinates or an unknown depth
     unit. client/src/sql/chemrooms_catalogs.sql is materialized, so the
     analyte picker and the inspector never scan every remote result.
  2. Vis specs (<table>.vis.json) for the client's color-by, computed here
     over the same hybrid tables the browser will open. Without them every
     point draws in the fallback colour.

--x/--y name the WGS84 longitude/latitude columns. They are a setting, not
a guess: at the test facility X_COORD equals LONGITUDE, at other facilities it is a
projected easting.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
CATALOGS_SQL = HERE.parent / "client" / "src" / "sql" / "chemrooms_catalogs.sql"
sys.path.insert(0, str(HERE))
from vis_specs import write_vis_specs  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("manifest")
    ap.add_argument("out_dir")
    ap.add_argument("--x", required=True, help="WGS84 longitude column, e.g. LONGITUDE")
    ap.add_argument("--y", required=True, help="WGS84 latitude column, e.g. LATITUDE")
    ap.add_argument("--chemduck", default=str(HERE.parent.parent / "chemduck"))
    ap.add_argument("--memory-limit", default="8GB")
    args = ap.parse_args(argv)

    tools = Path(args.chemduck).resolve() / "tools"
    if not (tools / "arii_hybrid.py").exists():
        print(f"No chemduck tools/arii_hybrid.py under {args.chemduck}", file=sys.stderr)
        return 2
    sys.path.insert(0, str(tools))
    import arii_hybrid as hy  # noqa: E402

    t = time.time()
    try:
        sidecars = hy.publish(args.manifest, args.out_dir, x_col=args.x, y_col=args.y,
                              memory_limit=args.memory_limit, materialize=[CATALOGS_SQL])
    except Exception as e:  # SourceRefused, ManifestError, LoadConflictError
        print(f"Refused: {e}", file=sys.stderr)
        return 2
    print(f"  sidecars: {time.time() - t:.1f}s")

    t = time.time()
    manifest = Path(args.manifest)
    parts = [manifest.parent / p["path"]
             for p in json.loads(manifest.read_text(encoding="utf-8"))["partitions"]]
    con = duckdb.connect()
    con.execute(f"SET memory_limit = '{args.memory_limit}'")
    hy.open_consumer(con, args.out_dir, parts)
    written = write_vis_specs(con, args.out_dir)
    con.close()
    print(f"  vis specs ({', '.join(written)}): {time.time() - t:.1f}s")
    print(f"  {sidecars['source_manifest']['rows']:,} results, "
          f"{sidecars['tables']['locations']['rows']:,} locations "
          f"({sidecars['coordinates']['unplaced_locations']:,} without coordinates), "
          f"{sidecars['tables']['samples']['rows']:,} samples")
    return 0


if __name__ == "__main__":
    sys.exit(main())
