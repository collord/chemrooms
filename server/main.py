"""
Chemrooms server — serves ChemDuck data as parquet files for DuckDB-WASM.

Phase 1: Export tables from a .duckdb file to parquet and serve them statically.
Phase 2: Arrow Flight / HTTP Arrow streaming (future).

Usage:
    # Export parquet files from a ChemDuck database:
    python main.py export path/to/chemrooms.duckdb

    # Run the server:
    python main.py serve
    # or: uvicorn main:app --reload --port 8000
"""

import sys
from pathlib import Path

import duckdb
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

DATA_DIR = Path(__file__).parent / "data"
TILES_DIR = Path(__file__).parent / "tiles"

app = FastAPI(title="Chemrooms Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve parquet files at /data/
app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")

# Serve 3D tileset files at /tiles/
if TILES_DIR.exists():
    app.mount("/tiles", StaticFiles(directory=str(TILES_DIR)), name="tiles")


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


def export_to_parquet(db_path: str, output_dir: str | None = None):
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

    con.close()
    print(f"\nExport complete. Serve with: uvicorn main:app --port 8000")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python main.py export <path/to/chemrooms.duckdb> [output_dir]")
        print("  python main.py serve [--port 8000]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "export":
        if len(sys.argv) < 3:
            print("Error: provide path to .duckdb file")
            sys.exit(1)
        db_path = sys.argv[2]
        output_dir = sys.argv[3] if len(sys.argv) > 3 else None
        export_to_parquet(db_path, output_dir)

    elif cmd == "serve":
        import uvicorn

        port = 8000
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
