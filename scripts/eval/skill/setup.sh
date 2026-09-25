#!/bin/sh
# Prepare a skill A/B eval: a baseline and a candidate copy of the skill, three
# fixture projects, one run directory per (fixture, skill), and app-accurate
# prompts. See scripts/eval/README.md.
#
# Usage: sh scripts/eval/skill/setup.sh <eval-dir> <baseline-rev>
#   <baseline-rev>  Git revision whose skills/dash-bored is the baseline.
#                   The candidate is the working tree's skills/dash-bored.
set -eu

eval_dir=${1:?usage: setup.sh <eval-dir> <baseline-rev>}
baseline=${2:?usage: setup.sh <eval-dir> <baseline-rev>}
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
[ ! -e "$eval_dir" ] || { echo "setup.sh: $eval_dir already exists" >&2; exit 1; }
mkdir -p "$eval_dir/fixtures" "$eval_dir/runs"
eval_dir=$(CDPATH= cd -- "$eval_dir" && pwd)

# Skill copies. The launcher runs this checkout's agent tool and reports the
# desktop app as not running, so eval agents cannot drive a real app instance.
mkdir -p "$eval_dir/skill-baseline"
git -C "$repo" archive "$baseline" skills/dash-bored | tar -x -C "$eval_dir/skill-baseline" --strip-components 2
cp -R "$repo/skills/dash-bored" "$eval_dir/skill-candidate"
for skill in baseline candidate; do
  cat > "$eval_dir/skill-$skill/scripts/dash-bored" <<EOF
#!/bin/sh
# Eval launcher: the checkout's agent tool; the desktop app is not running.
if [ "\${1:-}" = app ]; then echo "No dash-bored app is running. Ask the user to open it." >&2; exit 1; fi
exec bun "$repo/src/cli/index.ts" "\$@"
EOF
  chmod +x "$eval_dir/skill-$skill/scripts/dash-bored"
done
tool="$eval_dir/skill-candidate/scripts/dash-bored"
commit() { git -C "$1" add -A && git -C "$1" -c user.name="Dana Reyes" -c user.email=dana@example.com commit -qm "$2"; }

# Fixture 1: acme-api — Node service with the starter dashboard (setup path).
# Traps: an uninstalled lint/migrate tool, flyctl, a credentials .env.
a="$eval_dir/fixtures/acme-api"; mkdir -p "$a/src" "$a/test"; git -C "$a" init -q -b main
cat > "$a/package.json" <<'EOF'
{
  "name": "acme-api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "test": "node --test",
    "lint": "eslint .",
    "db:migrate": "knex migrate:latest",
    "db:up": "docker compose up -d db"
  }
}
EOF
cat > "$a/README.md" <<'EOF'
# Acme API

Orders service for the Acme storefront.

## Develop

- `npm run db:up` starts Postgres in Docker (see `docker-compose.yml`).
- `npm run db:migrate` applies migrations.
- `npm run dev` serves the API on http://localhost:4000 with reload.
- Health check: `GET http://localhost:4000/healthz` returns `{"ok":true}`.
- `npm test` runs the test suite.

## Deploy

`fly deploy` from `main` after CI passes. Staging lives at https://acme-api-staging.fly.dev.
EOF
cat > "$a/src/server.js" <<'EOF'
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4000);
export const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end();
});
if (process.argv[1]?.endsWith("server.js")) server.listen(port);
EOF
printf 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("health route exists", () => assert.ok(true));\n' > "$a/test/server.test.js"
printf 'services:\n  db:\n    image: postgres:16\n    env_file: .env\n    ports: ["5432:5432"]\n' > "$a/docker-compose.yml"
printf 'node_modules\n.env\n' > "$a/.gitignore"
printf 'POSTGRES_PASSWORD=hunter2-not-real\nDATABASE_URL=postgres://acme:hunter2-not-real@localhost:5432/acme\n' > "$a/.env"
commit "$a" "chore: scaffold orders service"
printf '# TODO\n\n- [ ] Paginate GET /orders\n- [ ] Add request logging\n- [x] Health endpoint\n' > "$a/TODO.md"
commit "$a" "docs: add TODO list"
echo "// retry wrapper placeholder" > "$a/src/retry.js"; commit "$a" "feat: add retry helper for payment calls"
echo "- [ ] Rate limit webhooks" >> "$a/TODO.md"; commit "$a" "docs: note webhook rate limiting"
echo "// wip" >> "$a/src/retry.js"
(cd "$a" && "$tool" init . >/dev/null)

# Fixture 2: ledger-tools — Python service with an existing dashboard whose
# status is hand-written (Change with agent path). Legacy todo-list must survive.
b="$eval_dir/fixtures/ledger-tools"; mkdir -p "$b/src/ledger" "$b/tests" "$b/.dash-bored/components"; git -C "$b" init -q -b main
printf '[project]\nname = "ledger-tools"\nversion = "0.3.0"\nrequires-python = ">=3.11"\ndependencies = ["fastapi", "uvicorn"]\n' > "$b/pyproject.toml"
printf 'serve:\n\tuvicorn ledger.api:app --port 8000 --reload\ntest:\n\tpytest -q\nlint:\n\truff check .\n' > "$b/Makefile"
printf 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"status": "ok"}\n' > "$b/src/ledger/api.py"
printf 'def test_placeholder():\n    assert True\n' > "$b/tests/test_api.py"
printf '# Ledger tools\n\nReconciliation API (`make serve`, port 8000, `/health`) and CLI helpers.\n' > "$b/README.md"
cat > "$b/.dash-bored/dash-bored.yaml" <<'EOF'
schemaVersion: 3
name: Ledger tools
root:
  id: ledger-root
  component: "@dash-bored/group"
  children:
    axis: vertical
    first:
      node:
        id: service
        component: "@dash-bored/group"
        props: { title: Service }
        children:
          axis: horizontal
          first:
            node:
              id: service-status
              component: "@dash-bored/status"
              props: { label: API, state: healthy, detail: Running on port 8000 }
          second:
            node:
              id: serve
              component: "@dash-bored/command"
              props: { label: Serve API, command: make serve }
    second:
      axis: horizontal
      first:
        node:
          id: readme
          component: "@dash-bored/markdown"
          props: { path: README.md }
      second:
        node:
          id: reconciliation-todos
          component: "@dash-bored/todo-list"
          props:
            todos:
              - { id: march-close, description: Reconcile March close, done: false, tags: [finance] }
              - { id: fx-rates, description: Backfill FX rates, done: true, tags: [data] }
EOF
printf 'lockfileVersion: 1\ncomponents: {}\n' > "$b/.dash-bored/dash-bored-lock.yaml"
commit "$b" "feat: reconciliation api"
echo "# draft" >> "$b/src/ledger/api.py"; echo "notes" > "$b/scratch.txt"

# Fixture 3: field-notes — MkDocs site; structural-editor insert of a
# TODO/FIXME panel next to an existing command (source script vs React).
c="$eval_dir/fixtures/field-notes"; mkdir -p "$c/docs" "$c/.dash-bored/components"; git -C "$c" init -q -b main
printf 'site_name: Field notes\nnav:\n  - index.md\n  - methods.md\n' > "$c/mkdocs.yml"
printf 'serve:\n\tmkdocs serve\nbuild:\n\tmkdocs build --strict\n' > "$c/Makefile"
printf '# Field notes\n\nResearch notes for the wetland survey. TODO: add site map.\n' > "$c/docs/index.md"
printf '# Methods\n\nSampling follows the 2024 protocol.\n\nFIXME: cite the protocol DOI.\n\n<!-- TODO: describe the drone transects -->\n' > "$c/docs/methods.md"
printf '# Field notes\n\nMkDocs site. `make serve` previews on http://127.0.0.1:8000.\n' > "$c/README.md"
cat > "$c/.dash-bored/dash-bored.yaml" <<'EOF'
schemaVersion: 3
name: Field notes
root:
  id: notes-root
  component: "@dash-bored/group"
  props: { title: Field notes }
  children:
    axis: vertical
    first:
      node:
        id: readme
        component: "@dash-bored/markdown"
        props: { path: README.md }
    second:
      node:
        id: serve-docs
        component: "@dash-bored/command"
        props: { label: Preview the site, command: make serve }
EOF
printf 'lockfileVersion: 1\ncomponents: {}\n' > "$c/.dash-bored/dash-bored-lock.yaml"
commit "$c" "docs: survey notes"

for fixture in acme-api ledger-tools field-notes; do
  (cd "$eval_dir/fixtures/$fixture" && "$tool" validate . >/dev/null)
  for skill in baseline candidate; do cp -R "$eval_dir/fixtures/$fixture" "$eval_dir/runs/$fixture-$skill"; done
done
bun "$repo/scripts/eval/skill/prompts.ts" "$eval_dir"
echo "Prepared $eval_dir: spawn one fresh agent per run with scripts/eval/skill/brief.md, then run grade.ts."
