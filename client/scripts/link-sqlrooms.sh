#!/usr/bin/env bash
#
# Links all required @sqlrooms packages from the local fork.
#
# Usage:
#   SQLROOMS_DIR=/path/to/sqlrooms pnpm link-sqlrooms
#
# If SQLROOMS_DIR is not set, defaults to ../../../sqlrooms (sibling of chemrooms parent).

set -euo pipefail

SQLROOMS_DIR="${SQLROOMS_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)/sqlrooms}"

if [ ! -d "$SQLROOMS_DIR/packages" ]; then
  echo "ERROR: Cannot find sqlrooms packages at $SQLROOMS_DIR/packages"
  echo "Set SQLROOMS_DIR to your sqlrooms fork root, e.g.:"
  echo "  SQLROOMS_DIR=/Users/you/Documents/sqlrooms pnpm link-sqlrooms"
  exit 1
fi

# All @sqlrooms packages needed (direct + transitive)
PACKAGES=(
  cesium
  duckdb
  duckdb-core
  mosaic
  room-shell
  sql-editor
  ui
  room-config
  room-store
  utils
  data-table
  layout
  layout-config
  monaco-editor
  schema-tree
  sql-editor-config
)

echo "Linking @sqlrooms packages from: $SQLROOMS_DIR"

for pkg in "${PACKAGES[@]}"; do
  pkg_dir="$SQLROOMS_DIR/packages/$pkg"
  if [ ! -d "$pkg_dir" ]; then
    echo "  SKIP $pkg (not found at $pkg_dir)"
    continue
  fi
  echo "  Linking @sqlrooms/$pkg"
  pnpm link "$pkg_dir"
done

echo ""
echo "Done. Linked ${#PACKAGES[@]} @sqlrooms packages."
echo "Run 'pnpm dev' to start the dev server."
