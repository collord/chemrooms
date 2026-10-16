#!/usr/bin/env python3
"""
Sync the ChemDuck SQL and catalogs into server/data from a chemduck checkout.

    python server/sync_chemduck.py [--chemduck ../chemduck] [--out server/data]

Writes, via chemduck's own tools/arii_hybrid.py write_consumer_bundle():

  sql/00_bootstrap.sql         DDL generated from chemduck sql/01_tables.sql
  sql/02_macros.sql            copied verbatim
  sql/03_views.sql             copied verbatim
  sql/08_aggregate_results.sql copied verbatim
  sql/SOURCE.json              the chemduck commit (and whether it was dirty)
  aggregation_rules.parquet    the catalog sql/07_catalogs.sql defines

This replaces hand-copying. The copy that was here had drifted: its
aggregate_results partitioned the event collapse on location, matrix and
depth only, so it combined dissolved and total results across events.

sql/10_chemrooms_catalogs.sql is chemrooms' own and is not touched.
An ARII folder gets the same bundle from `arii_hybrid.py publish`.
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chemduck", default=str(HERE.parent.parent / "chemduck"),
                    help="chemduck checkout (default: sibling of the chemrooms repo)")
    ap.add_argument("--out", default=str(HERE / "data"))
    args = ap.parse_args(argv)
    tools = Path(args.chemduck).resolve() / "tools"
    if not (tools / "arii_hybrid.py").exists():
        print(f"No chemduck tools/arii_hybrid.py under {args.chemduck}", file=sys.stderr)
        return 2
    sys.path.insert(0, str(tools))
    import arii_hybrid  # noqa: E402

    source = arii_hybrid.write_consumer_bundle(args.out)
    print(json.dumps(source, indent=1))
    if source["chemduck"].get("dirty"):
        print("Warning: chemduck sql/ or tools/ has uncommitted changes; SOURCE.json "
              "records the commit, not what was copied.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
