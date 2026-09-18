#!/usr/bin/env bash
# Imports locally built images into k3s's own containerd (k3s doesn't share the
# VM's Docker daemon), so pods can use them without pushing to any registry.
set -euo pipefail
cd "$(dirname "$0")/.."

for dir in services/*/; do
  name=$(basename "$dir")
  echo "importing hievents/$name:local into k3s containerd"
  docker save "hievents/$name:local" | sudo k3s ctr images import -
done
