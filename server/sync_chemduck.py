#!/usr/bin/env python3
"""
Write the ChemDuck SQL and catalogs into a ChemDuck data folder.

    python server/sync_chemduck.py [--out server/data]

Uses the vendored ChemDuck (server/chemduck/, pinned by
server/vendor_chemduck.py) and its own write_consumer_bundle():

  sql/00_bootstrap.sql         DDL generated from ChemDuck's sql/01_tables.sql
  sql/<consumer SQL>           the files arii_hybrid.CONSUMER_SQL names,
                               copied verbatim
  sql/SOURCE.json              the ChemDuck version, the pinned commit, and the
                               files in the order the client loads them
  aggregation_rules.parquet    the catalog sql/07_catalogs.sql defines

The client loads the files SOURCE.json lists, so a ChemDuck that adds a
consumer file needs no client change to ship it.

An ARII folder gets the same bundle from publish_arii.py. Run this again
after re-vendoring. The SQL must match the schema the folder's parquet was
written with, so re-export the data too (main.py export).
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import chemduck  # noqa: E402  the vendored copy, server/chemduck
from vendor_chemduck import vendored_revision  # noqa: E402


def stamp_revision(folder):
    """Record the pinned commit where ChemDuck could not.

    A vendored ChemDuck writes "commit": null into sql/SOURCE.json and
    sidecars.json, because it finds no .git folder beside itself. The
    commit is what tells a reader which macros the SQL defines, so it is
    added here from VENDORED.json. The version stays ChemDuck's own.
    """
    folder = Path(folder)
    revision = {**vendored_revision(), "version": chemduck.__version__}
    for path in (folder / "sql" / "SOURCE.json", folder / "sidecars.json"):
        if path.is_file():
            doc = json.loads(path.read_text(encoding="utf-8"))
            doc["chemduck"] = {**doc.get("chemduck", {}), **revision}
            path.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    return revision


def write_bundle(out_dir):
    """write_consumer_bundle, with the pinned commit recorded. Returns SOURCE.json."""
    chemduck.write_consumer_bundle(out_dir)
    stamp_revision(out_dir)
    return json.loads((Path(out_dir) / "sql" / "SOURCE.json").read_text(encoding="utf-8"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n\n")[0])
    ap.add_argument("--out", default=str(HERE / "data"))
    args = ap.parse_args(argv)
    print(json.dumps(write_bundle(args.out), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
