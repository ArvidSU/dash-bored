FROM oven/bun:1.3.14 AS previous
WORKDIR /source
COPY previous/ ./
RUN bun install --frozen-lockfile && bun run build:cli

FROM oven/bun:1.3.14 AS candidate
WORKDIR /source
COPY candidate/ ./
COPY bridge.ts ./release-qa-bridge.ts
RUN bun install --frozen-lockfile && bun run build:cli && bun build --compile ./release-qa-bridge.ts --outfile /bridge

FROM oven/bun:1.3.14
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates nodejs ripgrep && rm -rf /var/lib/apt/lists/*
# Explicit, operator-owned setup for a pinned external agent CLI. No agent by default.
ARG AGENT_SETUP=true
RUN sh -eu -c "$AGENT_SETUP"
COPY --from=previous /source/dist/tools/dash-bored /opt/previous/dash-bored
COPY --from=candidate /source/dist/tools/dash-bored /opt/candidate/dash-bored
COPY --from=candidate /bridge /opt/candidate/bridge
COPY runner.py /qa/runner.py
COPY fixture/ /qa/fixture/
RUN mkdir -p /evidence /home/bun/.local/bin && chown -R bun:bun /evidence /home/bun
ENV SHELL=/bin/bash
ENV HOME=/home/bun
ENV PATH=/home/bun/.local/bin:$PATH
USER bun
WORKDIR /home/bun
ENTRYPOINT ["python3", "/qa/runner.py", "worker"]
