"""
Chemrooms server: serves a data folder (parquet, ChemDuck SQL) statically.

    python main.py serve [--port 8000]
    # or: uvicorn main:app --reload --port 8000

Making a data folder from a ChemDuck database is export_chemduck.py, which
needs no FastAPI; `python main.py export ...` is kept as an alias for it.
"""

import sys
from pathlib import Path

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


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python export_chemduck.py <path/to/project.duckdb> [output_dir]")
        print("  python main.py serve [--port 8000]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "export":
        import export_chemduck

        sys.exit(export_chemduck.main(sys.argv[2:]))

    elif cmd == "serve":
        import uvicorn

        port = 8000
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
