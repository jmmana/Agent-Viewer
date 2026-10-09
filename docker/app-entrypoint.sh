#!/bin/sh
# Entry point of the office + API image (ghcr.io/jmmana/agent-viewer). The defaults come from the image
# environment (AGENT_VIEWER_HOST=0.0.0.0, PORT=8787), so any flag passed to `docker run IMAGE ...` is added
# to them instead of replacing them: `docker run IMAGE --token abc` still listens on 0.0.0.0. The browser is
# never opened inside a container. Other commands (send, claude-hook, install, help, --version) run as given.
set -e
cli="${AGENT_VIEWER_CLI:-/app/dist-cli/cli.js}"

case "${1:-}" in
  send|claude-hook|install|uninstall|help|version|-h|--help|-v|--version)
    exec node "$cli" "$@"
    ;;
  start)
    shift
    ;;
esac

exec node "$cli" start --no-open "$@"
