#!/usr/bin/env python3
"""
Make a Chemrooms data folder from a ChemDuck database.

    python server/export_chemduck.py <project.duckdb> [out_dir] [--no-vis-specs]

Writes, into out_dir (default server/data):

  <table>.parquet   the core ChemDuck tables, each in the vendored ChemDuck's
                    current shape (current_schema_select)
  sql/, aggregation_rules.parquet
                    the vendored ChemDuck's consumer bundle (sync_chemduck.py)
  <table>.vis.json  default colour mappings for the client's Color by,
                    computed over the folder as the client opens it

The parquet and the SQL come from one ChemDuck, the vendored copy
(server/chemduck), because the SQL reads the columns that ChemDuck's schema
defines. Exporting an older database with a newer SQL bundle is what broke
the demo once: its results had no method_class or reported_units, and
03_views.sql refused to load.

Needs Python with duckdb and pyyaml. No FastAPI, no DuckDB extension.
"""

import argparse
import contextlib
import io
import sys
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import chemduck  # noqa: E402  the vendored copy, server/chemduck
from sync_chemduck import write_bundle  # noqa: E402
from vis_specs import write_vis_specs  # noqa: E402

DATA_DIR = HERE / "data"

# The tables client/src/store.ts loads for a ChemDuck project, plus the
# project tables. aggregation_rules is not here: write_bundle() writes it
# from ChemDuck's catalog, so it matches the SQL rather than the database.
EXPORT_TABLES = [
    "locations",
    "samples",
    "results",
    "screening_levels",
    "project",
    "unit_conversions",
    "project_events",
    "downhole_survey",
]


def _columns(con, catalog, schema, table):
    return con.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_catalog = ? AND table_schema = ? AND table_name = ? "
        "ORDER BY ordinal_position", [catalog, schema, table]).fetchall()


def current_schema_select(con, table, template_catalog="memory", template_schema="chemduck"):
    """SELECT src.main.<table> in the vendored ChemDuck's shape for that table.

    Returns (select_sql, padded_columns, dropped_columns).

    The client loads the vendored ChemDuck's SQL, and that SQL reads columns
    an older database lacks: results.method_class, reported_units, nd_limit,
    limit_source and more, all derived by ChemDuck's loader. ChemDuck's views
    take a NULL in each of them as "an older table" and fall back
    (03_views.sql: COALESCE(r.method_class, ...); a NULL limit_source
    re-derives the limit). So a missing column is exported as NULL. That is
    the shape a current consumer reads, with nothing invented.

    A column the source has and ChemDuck doesn't is kept, except a GEOMETRY.
    Reading one needs the spatial extension, and ChemDuck's core no longer
    has one (geometry moved to optional/spatial.sql). The client places
    points by x/y.
    """
    have = dict(_columns(con, "src", "main", table))
    want = _columns(con, template_catalog, template_schema, table)
    if not want:  # a table ChemDuck doesn't define: as it is
        return f"SELECT * FROM src.main.{table}", [], []
    exprs, padded = [], []
    for name, kind in want:
        if name in have:
            exprs.append(f'CAST("{name}" AS {kind}) AS "{name}"')
        else:
            exprs.append(f'CAST(NULL AS {kind}) AS "{name}"')
            padded.append(name)
    wanted = {name for name, _ in want}
    dropped = [n for n, k in have.items() if n not in wanted and "GEOMETRY" in k.upper()]
    exprs += [f'"{n}"' for n in have if n not in wanted and n not in dropped]
    return f"SELECT {', '.join(exprs)} FROM src.main.{table}", padded, dropped


def export_tables(db_path, out):
    """Write each EXPORT_TABLES table present in db_path as parquet. Returns their names."""
    con = duckdb.connect()
    with contextlib.redirect_stdout(io.StringIO()):  # load_schema prints a line per file
        chemduck.load_schema(con, schema="chemduck")
    con.execute(f"ATTACH '{Path(db_path).as_posix()}' AS src (READ_ONLY)")
    present = {r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'src' "
        "AND table_schema = 'main' AND table_type = 'BASE TABLE'").fetchall()}
    written = []
    for table in EXPORT_TABLES:
        if table not in present:
            print(f"  skip {table} (not in the database)")
            continue
        dest = out / f"{table}.parquet"
        select, padded, dropped = current_schema_select(con, table)
        count = con.execute(f"SELECT count(*) FROM src.main.{table}").fetchone()[0]
        con.execute(f"COPY ({select}) TO '{dest.as_posix()}' "
                    "(FORMAT PARQUET, COMPRESSION ZSTD)")
        note = (f"; added as NULL: {', '.join(padded)}" if padded else "") + \
               (f"; dropped: {', '.join(dropped)}" if dropped else "")
        print(f"  {table}: {count:,} rows{note}")
        written.append(table)
    con.close()
    return written


def open_folder(out, tables):
    """A connection holding the folder as the client opens it: the parquet
    as tables, then the bundle's SQL (00_bootstrap first, as SOURCE.json
    orders it)."""
    con = duckdb.connect()
    for table in tables:
        con.execute(f"CREATE TABLE {table} AS SELECT * FROM "
                    f"read_parquet('{(out / f'{table}.parquet').as_posix()}')")
    con.execute("CREATE TABLE aggregation_rules AS SELECT * FROM "
                f"read_parquet('{(out / 'aggregation_rules.parquet').as_posix()}')")
    with contextlib.redirect_stdout(io.StringIO()):
        chemduck.load_consumer_sql(con, out / "sql",
                                   adopt=[*tables, "aggregation_rules"])
    return con


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n\n")[0])
    ap.add_argument("db_path")
    ap.add_argument("out_dir", nargs="?", default=str(DATA_DIR))
    ap.add_argument("--no-vis-specs", action="store_true")
    # Accepted for old command lines: vis specs are now written by default.
    ap.add_argument("--create-vis-specs", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    print(f"Exporting {args.db_path} -> {out}")
    tables = export_tables(args.db_path, out)
    source = write_bundle(out)
    rev = source["chemduck"]
    print(f"  sql/: ChemDuck {rev['version']} at {(rev.get('commit') or '?')[:7]}, "
          f"{len(source['files'])} files")
    if not args.no_vis_specs:
        con = open_folder(out, tables)
        print(f"  vis specs: {', '.join(write_vis_specs(con, out))}")
        con.close()
    print("Done. Serve with: python main.py serve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
