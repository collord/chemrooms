#!/usr/bin/env python3
"""The vendored ChemDuck: the pinned commit, unedited, and usable here.

    python server/tests/test_chemduck_vendor.py [--source ../chemduck]
        [--plugin ../dma/equis_qgis_public]

Checks:
  * every file is the one VENDORED.json records, and none was added. A hand
    edit to a vendored rule would be a second copy of the chemistry rules
    hiding inside the one authority;
  * the scripts import this copy, at the recorded version;
  * the running DuckDB is one ChemDuck has tested (SUPPORTED_DUCKDB);
  * the consumer bundle it writes is complete and names the pinned commit;
  * where the ChemDuck checkout is present, the files are that commit's;
  * where the QGIS plugin's checkout is present, it pins the same commit
    (a warning, not a failure: the two move together, but not atomically).
"""
import argparse
import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
ROOT = SERVER.parent
VENDORED = SERVER / "chemduck"
RECORD = VENDORED / "VENDORED.json"
sys.path.insert(0, str(SERVER))
FAILURES = []


def check(label, condition, detail=""):
    print(f"[{'PASS' if condition else 'FAIL'}] {label}"
          + (f" - {detail}" if detail != "" else ""))
    if not condition:
        FAILURES.append(label)


def on_disk(folder):
    return {p.relative_to(folder).as_posix() for p in folder.rglob("*")
            if p.is_file() and p.name != "VENDORED.json"
            and "__pycache__" not in p.parts and p.suffix not in (".pyc", ".pyo")}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=str(ROOT.parent / "chemduck"))
    ap.add_argument("--plugin", default=str(ROOT.parent / "dma" / "equis_qgis_public"))
    args = ap.parse_args(argv)

    check("the vendored ChemDuck is present", RECORD.is_file(), RECORD)
    if not RECORD.is_file():
        print("\nRun: python server/vendor_chemduck.py --commit <ChemDuck commit>")
        return 1
    record = json.loads(RECORD.read_text(encoding="utf-8"))
    files, commit = record["files"], record["commit"]
    check("VENDORED.json names a full commit",
          len(commit) == 40 and all(c in "0123456789abcdef" for c in commit), commit)

    bad = []
    for name, entry in sorted(files.items()):
        path = VENDORED / name
        if not path.is_file():
            bad.append(f"{name} missing")
            continue
        blob = path.read_bytes()
        if hashlib.sha256(blob).hexdigest() != entry["sha256"] or len(blob) != entry["bytes"]:
            bad.append(f"{name} differs")
    check(f"every vendored file matches its recorded hash ({len(files)} files)",
          not bad, "; ".join(bad[:5]))
    extra = sorted(on_disk(VENDORED) - set(files))
    check("no file was added to the vendored copy", not extra, ", ".join(extra[:5]))

    import duckdb
    import chemduck
    check("`import chemduck` is the vendored copy",
          Path(chemduck.__file__).resolve().parent == VENDORED.resolve(), chemduck.__file__)
    check("the vendored version is the recorded one",
          chemduck.__version__ == record["version"], chemduck.__version__)
    check(f"DuckDB {duckdb.__version__} is one ChemDuck has tested",
          duckdb.__version__ in chemduck.SUPPORTED_DUCKDB, chemduck.SUPPORTED_DUCKDB)

    from sync_chemduck import write_bundle
    with tempfile.TemporaryDirectory() as tmp:
        with contextlib.redirect_stdout(io.StringIO()):
            source = write_bundle(Path(tmp))
        sql = Path(tmp) / "sql"
        listed = source["files"]
        check("the bundle lists the consumer SQL, bootstrap first",
              listed[:1] == ["00_bootstrap.sql"] and "08_aggregate_points.sql" in listed,
              listed)
        check("every listed file was written", all((sql / f).is_file() for f in listed))
        written = json.loads((sql / "SOURCE.json").read_text(encoding="utf-8"))
        check("SOURCE.json names the pinned commit",
              written["chemduck"].get("commit") == commit, written["chemduck"])

    source_repo = Path(args.source)
    if (source_repo / ".git").exists():
        differ = []
        for name, entry in files.items():
            blob = subprocess.run(["git", "-C", str(source_repo), "cat-file", "blob",
                                   f"{commit}:chemduck/{name}"], capture_output=True)
            if blob.returncode or hashlib.sha256(blob.stdout).hexdigest() != entry["sha256"]:
                differ.append(name)
        check("the files are the pinned commit's, in the ChemDuck checkout",
              not differ, ", ".join(differ[:5]))
    else:
        print(f"[SKIP] no ChemDuck checkout at {source_repo}")

    plugin_record = Path(args.plugin) / "equis_loader" / "chemduck" / "VENDORED.json"
    if plugin_record.is_file():
        theirs = json.loads(plugin_record.read_text(encoding="utf-8"))
        if theirs["commit"] == commit:
            print(f"[PASS] the QGIS plugin pins the same commit ({commit[:7]})")
        else:
            print(f"[WARN] the QGIS plugin pins {theirs['commit'][:7]}, this repository "
                  f"{commit[:7]}: re-vendor so both read data by the same rules")
    else:
        print(f"[SKIP] no QGIS plugin checkout at {args.plugin}")

    print(f"\n{'FAILED: ' + ', '.join(FAILURES) if FAILURES else 'All checks passed.'}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
