#!/usr/bin/env bash
# Builds every service image locally, tagged for the k8s manifests (hievents/<name>:local).
set -euo pipefail
cd "$(dirname "$0")/.."

for dir in services/*/; do
  name=$(basename "$dir")
  echo "building hievents/$name:local"
  docker build -t "hievents/$name:local" "$dir"
done
