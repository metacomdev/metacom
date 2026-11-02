# A coding agent in a box: Claude Code, git, gh and the metacom CLI, as a non-root user, joining
# one room of a metacom hub with a token limited to that room. Built from the repo root:
#   docker build -f agent/Dockerfile -t metacom-agent .
FROM node:24-bookworm-slim

# git and gh for the repository; python3, make and g++ build node-pty; tini reaps what the agent
# leaves behind
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 make g++ procps tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# the metacom CLI from this checkout (it depends on ../metacom)
WORKDIR /opt/metacom
COPY metacom/package.json metacom/package-lock.json ./metacom/
RUN cd metacom && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY metacom/ ./metacom/
COPY cli/package.json cli/package-lock.json ./cli/
COPY cli/scripts/ ./cli/scripts/
RUN cd cli && npm ci --no-audit --no-fund && npm cache clean --force
COPY cli/ ./cli/
RUN ln -s /opt/metacom/cli/bin/metacom.js /usr/local/bin/metacom

COPY agent/entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod 755 /usr/local/bin/agent-entrypoint && mkdir -p /work && chown node:node /work

# the node user (uid 1000) owns its home (Claude and gh logins) and /work (the checkout)
USER node
ENV HOME=/home/node
WORKDIR /work
ENTRYPOINT ["tini", "--", "agent-entrypoint"]
