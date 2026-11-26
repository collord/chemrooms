"""
Default vis specs: per-table colour mappings the client's color-by uses.

Numeric columns get a viridis sequential mapping with the data's real
[min, max]; string columns with 2-30 distinct values get category10 with
those values listed. Written as `<table>.vis.json` beside the data.

Kept free of FastAPI so the export command and the ARII publisher
(publish_arii.py) share one builder.
"""

import json
from pathlib import Path

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
        # As the client keys them: colormap.ts matches String(value), so a
        # boolean is 'true'/'false'. Python's str() gave 'True', which no
        # value ever matched, and `detected` drew in hashed colours.
        cats = [("true" if c else "false") if isinstance(c, bool) else str(c) for c in cats]
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


def write_vis_specs(con, out_dir, tables=VIS_SPEC_TABLES) -> list[str]:
    """Write `<table>.vis.json` for each table present on `con`."""
    out_dir = Path(out_dir)
    present = {r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables").fetchall()}
    written = []
    for table in tables:
        if table not in present:
            continue
        spec = _build_default_spec(con, table)
        (out_dir / f"{table}.vis.json").write_text(json.dumps(spec, indent=2))
        written.append(table)
    return written
