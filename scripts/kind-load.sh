#!/usr/bin/env bash
# Loads the locally built images into a kind cluster (kind never talks to a
# registry, so images built with 'docker build' are invisible to it otherwise).
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER_NAME=${1:-hievents}

for dir in services/*/; do
  name=$(basename "$dir")
  echo "loading hievents/$name:local into kind cluster '$CLUSTER_NAME'"
  kind load docker-image "hievents/$name:local" --name "$CLUSTER_NAME"
done
