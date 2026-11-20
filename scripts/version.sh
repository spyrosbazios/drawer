#!/bin/sh
# Prints the repository's one version: DRAWER_VERSION if set, else the latest git tag without its `v`, else 0.0.0.
# The git tag is the only source (CONTRIBUTING.md, Versioning); nothing stores it in a package.json.
set -eu
if [ -n "${DRAWER_VERSION:-}" ]; then
  printf '%s\n' "$DRAWER_VERSION"
  exit 0
fi
tag=$(git -C "$(dirname "$0")/.." describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$tag" ]; then
  printf '%s\n' "${tag#v}"
else
  printf '0.0.0\n'
fi
