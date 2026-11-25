#!/usr/bin/env python3
"""Copy ChemDuck into server/chemduck/ at one commit.

    python server/vendor_chemduck.py --commit ee6b160   # pin a commit
    python server/vendor_chemduck.py                    # re-vendor the pinned one
        [--source ../chemduck]

WHY VENDORED. Chemrooms' data folders carry ChemDuck's SQL, and the
scripts here (sync_chemduck.py, publish_arii.py, main.py export) write it
using ChemDuck's own Python. They used to import whatever ../chemduck
happened to have checked out. The QGIS plugin and its nightly pipeline
vendor ChemDuck at a pinned commit (the plugin's tools/vendor_chemduck.py),
and a facility the pipeline publishes, the plugin reading it and Chemrooms
reading it should run one set of rules. So Chemrooms pins the same way, and
should move its pin together with the plugin's (chemduck-transition-plan.md,
phase 0).

WHAT IS COPIED is the `chemduck/` package as it is IN THE COMMIT, read with
`git cat-file blob`. It never comes from the checkout's working tree, so an
uncommitted edit there can't slip in. It never goes through `git archive`
either, which applies the source repository's CRLF conversion on Windows.
.gitattributes keeps the bytes as they are (`-text`). VENDORED.json records
the commit, the version and every file's hash, and
server/tests/test_chemduck_vendor.py checks the files against it.

A vendored ChemDuck can't name its own commit: _chemduck_revision() looks
for a .git folder beside the package and finds none. So sync_chemduck.py
and publish_arii.py add the commit from VENDORED.json to the SOURCE.json
they write (vendored_revision() below).
"""
import argparse
import datetime
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TARGET = HERE / "chemduck"
RECORD = TARGET / "VENDORED.json"
PACKAGE = "chemduck/"


def git(source, *args):
    result = subprocess.run(["git", "-C", str(source), *args], capture_output=True)
    if result.returncode:
        raise SystemExit("git %s failed: %s"
                         % (" ".join(args), result.stderr.decode(errors="replace").strip()))
    return result.stdout


def vendored_revision():
    """The pinned commit, for SOURCE.json: {"commit", "subject", "vendored"}."""
    record = json.loads(RECORD.read_text(encoding="utf-8"))
    return {"commit": record["commit"], "subject": record["subject"],
            "vendored": record["vendored"], "dirty": False}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", default=str(ROOT.parent / "chemduck"),
                    help="the ChemDuck checkout to read the commit from")
    ap.add_argument("--commit", help="the ChemDuck commit to vendor; default: the one "
                                     "VENDORED.json already pins")
    args = ap.parse_args(argv)

    source = Path(args.source).resolve()
    if not (source / ".git").exists():
        raise SystemExit(f"No ChemDuck checkout at {source} (--source).")
    wanted = args.commit
    previous = json.loads(RECORD.read_text(encoding="utf-8")) if RECORD.is_file() else None
    if not wanted:
        if not previous:
            raise SystemExit("Nothing is vendored yet: name a commit (--commit).")
        wanted = previous["commit"]
    commit = git(source, "rev-parse", "--verify", wanted + "^{commit}").decode().strip()

    # Replace only what this tool wrote: a folder without its record is
    # someone else's, and is not deleted on a guess.
    if TARGET.is_dir() and not RECORD.is_file():
        raise SystemExit(f"{TARGET} exists but holds no VENDORED.json; not replacing it.")

    names = [n for n in git(source, "ls-tree", "-r", "--name-only", commit, "--",
                            PACKAGE).decode().splitlines()
             if "__pycache__/" not in n and not n.endswith((".pyc", ".pyo"))]
    if PACKAGE + "__init__.py" not in names:
        raise SystemExit(f"{commit[:7]} has no {PACKAGE}__init__.py: "
                         "not a ChemDuck package commit.")
    blobs = {n[len(PACKAGE):]: git(source, "cat-file", "blob", f"{commit}:{n}")
             for n in names}
    found = re.search(rb'^__version__ = "([^"]+)"', blobs["__init__.py"], re.M)
    if not found:
        raise SystemExit(f"No __version__ in {commit[:7]}'s __init__.py.")
    version = found.group(1).decode()

    if TARGET.is_dir():
        shutil.rmtree(TARGET)
    for name, blob in blobs.items():
        path = TARGET.joinpath(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)

    remote = subprocess.run(["git", "-C", str(source), "remote", "get-url", "origin"],
                            capture_output=True, text=True).stdout.strip()
    subject = git(source, "log", "-1", "--format=%s", commit).decode().strip()
    record = {
        "note": "Written by server/vendor_chemduck.py. Do not edit these files: "
                "re-vendor, and server/tests/test_chemduck_vendor.py checks them.",
        "repository": remote,
        "commit": commit,
        "subject": subject,
        "version": version,
        # The day this commit was first vendored: re-vendoring the same pin
        # changes no byte, so it changes no date.
        "vendored": (previous["vendored"] if previous and previous.get("commit") == commit
                     else datetime.date.today().isoformat()),
        "files": {name: {"bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()}
                  for name, blob in sorted(blobs.items())},
    }
    with open(RECORD, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(record, handle, indent=1)
        handle.write("\n")
    print(f"Vendored ChemDuck {version} at {commit[:7]} ({subject}): {len(blobs)} files, "
          f"{sum(len(b) for b in blobs.values()):,} bytes, into {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
