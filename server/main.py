"""
Chemrooms server — serves ChemDuck data as parquet files for DuckDB-WASM.

Phase 1: Export tables from a .duckdb file to parquet and serve them statically.
Phase 2: Arrow Flight / HTTP Arrow streaming (future).

Usage:
    # Export parquet files from a ChemDuck database:
    python main.py export path/to/chemrooms.duckdb

    # Export and also emit per-table vis spec sidecars:
    python main.py export path/to/chemrooms.duckdb --create-vis-specs

    # Run the server:
    python main.py serve
    # or: uvicorn main:app --reload --port 8000
"""

import json
import sys
from pathlib import Path

import duckdb
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

DATA_DIR = Path(__file__).parent / "data"

app = FastAPI(title="Chemrooms Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve parquet files at /data/
app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# CLI: export tables from .duckdb to parquet
# ---------------------------------------------------------------------------

EXPORT_TABLES = [
    "locations",
    "samples",
    "results",
    "screening_levels",
    "project",
    "unit_conversions",
    "project_events",
]


VIS_SPEC_TABLES = ("locations", "samples", "results", "v_results_denormalized")

# DuckDB column types we treat as numeric → sequential color spec.
NUMERIC_TYPES = {
    "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
    "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
    "FLOAT", "DOUBLE", "REAL", "DECIMAL",
}

# Columns we exclude from auto vis spec generation (IDs, foreign keys,
# already-positioned coordinates, internal flags).
EXCLUDED_COLUMNS = {
    "location_id", "sample_id", "result_id",
    "x", "y", "z", "elevation", "measuring_pt",
}


def _column_info(con, table: str) -> list[tuple[str, str]]:
    """Return [(column_name, type_name)] for a table."""
    rows = con.execute(f"DESCRIBE {table}").fetchall()
    # DESCRIBE returns: column_name, column_type, null, key, default, extra
    return [(r[0], r[1].upper()) for r in rows]


def _is_numeric_type(t: str) -> bool:
    base = t.split("(")[0].strip()  # strip e.g. DECIMAL(10, 2)
    return base in NUMERIC_TYPES


def _build_default_spec(con, table: str) -> dict:
    """
    Inspect a table and produce a default vis spec dict. Numeric columns
    get a viridis sequential mapping with a real [min, max] domain.
    String columns get a category10 categorical mapping with the actual
    distinct values pre-listed.
    """
    columns = {}
    default_color_by = None

    for name, type_ in _column_info(con, table):
        if name in EXCLUDED_COLUMNS:
            continue

        if _is_numeric_type(type_):
            domain_row = con.execute(
                f'SELECT MIN("{name}"), MAX("{name}") FROM {table} '
                f'WHERE "{name}" IS NOT NULL'
            ).fetchone()
            if not domain_row or domain_row[0] is None:
                continue
            lo, hi = float(domain_row[0]), float(domain_row[1])
            if lo == hi:
                continue  # constant column — coloring it is pointless
            columns[name] = {
                "label": name.replace("_", " ").title(),
                "color": {
                    "type": "sequential",
                    "palette": "viridis",
                    "scaleType": "linear",
                    "domain": [lo, hi],
                },
            }
            if default_color_by is None:
                default_color_by = name
            continue

        # Treat everything else as categorical via DISTINCT lookup. Skip
        # if there are too many distinct values (probably a free-text
        # field, not a category).
        distinct_count = con.execute(
            f'SELECT COUNT(DISTINCT "{name}") FROM {table} '
            f'WHERE "{name}" IS NOT NULL'
        ).fetchone()[0]
        if distinct_count <= 1 or distinct_count > 30:
            continue  # constant column or free-text — not worth coloring

        cats = [
            row[0]
            for row in con.execute(
                f'SELECT DISTINCT "{name}" FROM {table} '
                f'WHERE "{name}" IS NOT NULL ORDER BY "{name}"'
            ).fetchall()
        ]
        cats = [str(c) for c in cats]
        columns[name] = {
            "label": name.replace("_", " ").title(),
            "color": {
                "type": "categorical",
                "palette": "category10",
                "categories": cats,
            },
        }
        # Categorical columns make better default color-bys than numeric
        # ones, so override even if a numeric one was found earlier.
        default_color_by = name

    spec = {
        "version": 1,
        "table": table,
        "columns": columns,
    }
    if default_color_by is not None:
        spec["defaultColorBy"] = default_color_by
    return spec


def export_to_parquet(
    db_path: str,
    output_dir: str | None = None,
    create_vis_specs: bool = False,
):
    """Export core ChemDuck tables from a .duckdb file to parquet."""
    out = Path(output_dir) if output_dir else DATA_DIR
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(db_path, read_only=True)

    # List available tables
    tables = [
        row[0] for row in con.execute("SHOW TABLES").fetchall()
    ]
    print(f"Tables in {db_path}: {tables}")

    for table in EXPORT_TABLES:
        if table not in tables:
            print(f"  SKIP {table} (not in database)")
            continue

        dest = out / f"{table}.parquet"
        count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        con.execute(
            f"COPY {table} TO '{dest}' (FORMAT PARQUET, COMPRESSION ZSTD)"
        )
        print(f"  {table}: {count} rows -> {dest}")

    if create_vis_specs:
        print("\nGenerating vis spec sidecars...")
        for table in VIS_SPEC_TABLES:
            if table not in tables:
                continue
            spec = _build_default_spec(con, table)
            spec_path = out / f"{table}.vis.json"
            spec_path.write_text(json.dumps(spec, indent=2))
            ncols = len(spec["columns"])
            print(f"  {table}.vis.json ({ncols} column(s))")

    con.close()
    print(f"\nExport complete. Serve with: uvicorn main:app --port 8000")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print(
            "  python main.py export <path/to/chemrooms.duckdb> [output_dir] "
            "[--create-vis-specs]"
        )
        print("  python main.py serve [--port 8000]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "export":
        if len(sys.argv) < 3:
            print("Error: provide path to .duckdb file")
            sys.exit(1)
        db_path = sys.argv[2]
        # Strip optional flags from positional args
        positional = [a for a in sys.argv[3:] if not a.startswith("--")]
        output_dir = positional[0] if positional else None
        create_vis_specs = "--create-vis-specs" in sys.argv
        export_to_parquet(db_path, output_dir, create_vis_specs=create_vis_specs)

    elif cmd == "serve":
        import uvicorn

        port = 8000
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
