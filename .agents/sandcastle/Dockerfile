FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN if getent group "$AGENT_GID" > /dev/null; then \
    usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node; \
  else \
    groupmod -g "$AGENT_GID" node \
    && usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node; \
  fi

RUN npm install -g @openai/codex

USER ${AGENT_UID}:${AGENT_GID}

WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]
