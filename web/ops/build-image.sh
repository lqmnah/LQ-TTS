#!/usr/bin/env bash
# Release image build: builds from a clean `git archive` of committed web/ so .dockerignore applies
# and untracked/test files never reach the image. Usage: ops/build-image.sh [extra-tag...]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse --short HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive HEAD:web | tar -x -C "$tmp"
tags=(-t "lq-tts-web:$sha")
for t in "${@:-stg}"; do tags+=(-t "lq-tts-web:$t"); done
docker build "${tags[@]}" "$tmp"
