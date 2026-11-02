#!/bin/sh
# Starts the agent: clones AGENT_REPO into /work once GitHub is logged in, then runs Claude Code
# under the metacom wrapper as AGENT_NAME in AGENT_ROOM. When it exits, the container's restart
# policy brings it back.
set -e
: "${AGENT_ROOM:?AGENT_ROOM is required}"
: "${AGENT_NAME:?AGENT_NAME is required}"

# Claude Code asks a few first-run questions (theme, trusting the folder); answer them once here
if [ ! -f "$HOME/.claude.json" ]; then
  printf '{"hasCompletedOnboarding":true,"projects":{"/work":{"hasTrustDialogAccepted":true}}}\n' > "$HOME/.claude.json"
fi

# git uses gh's login for https remotes
if gh auth status >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
  if [ -n "$AGENT_REPO" ] && [ -z "$(ls -A /work 2>/dev/null)" ]; then
    gh repo clone "$AGENT_REPO" /work
  fi
else
  echo "agent: GitHub is not logged in yet: docker exec -it <container> gh auth login" >&2
fi

if [ -z "$ANTHROPIC_AUTH_TOKEN" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "agent: no model key (ANTHROPIC_AUTH_TOKEN for OpenRouter); waiting" >&2
  exec sleep infinity
fi

# more agents in this box: one per line in $HOME/.metacom/box-agents, a folder then its command
# (`/work/strategy metacom values -n strategist …`; # for comments). Each starts headless beside
# the main agent, every time the box starts, so none is lost to a restart.
AGENTS="$HOME/.metacom/box-agents"
if [ -f "$AGENTS" ]; then
  grep -v '^[[:space:]]*\(#\|$\)' "$AGENTS" | while IFS= read -r line; do
    dir=${line%% *}
    cmd=${line#* }
    echo "agent: starting in $dir: ${cmd%% --*}" >&2
    (cd "$dir" && setsid script -qfc "$cmd" /dev/null >/dev/null 2>&1 &)
  done
fi

cd /work
# shellcheck disable=SC2086
exec metacom "$AGENT_ROOM" -n "$AGENT_NAME" --accept "${AGENT_ACCEPT:-any}" claude ${CLAUDE_ARGS}
