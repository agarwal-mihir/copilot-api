#!/bin/sh
if [ -n "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN is not accepted because environment and process metadata can expose it. Mount a protected file and set GH_TOKEN_FILE instead." >&2
  exit 1
fi

if [ "$1" = "auth" ] || [ "$1" = "--auth" ]; then
  shift
  exec bun --use-system-ca run dist/main.js auth "$@"
fi

if [ "$1" = "start" ]; then
  shift
fi

if [ -n "${GH_TOKEN_FILE:-}" ]; then
  set -- --github-token-file "$GH_TOKEN_FILE" "$@"
fi

exec bun --use-system-ca run dist/main.js start "$@"
