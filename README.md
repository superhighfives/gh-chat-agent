# gh-chat-agent

A small chat agent — built with [Flue](https://flueframework.com) on top of the
Cloudflare Agents SDK — that you talk to about **your own GitHub pull requests
and issues** across all your orgs and repos.

- **Framework:** `@flue/runtime` (agent harness) compiled to a Cloudflare Worker.
- **Runtime:** Cloudflare Agents SDK (`agents`) — each agent instance is a
  Durable Object; sessions persist in DO SQLite.
- **GitHub access:** the official hosted GitHub MCP server
  (`https://api.githubcopilot.com/mcp/`), read-only, scoped to the `issues`,
  `pull_requests`, and `context` toolsets. Tools are adapted into Flue tools
  automatically.
- **Model:** Workers AI, routed through a **named Cloudflare AI Gateway**.
- **Config:** everything is read from Worker `env` bindings — nothing hardcoded.

## Layout

```
.flue/app.ts            # Hono entry: serves the chat UI at /, registers the AI Gateway provider, mounts flue()
.flue/agents/chat.ts    # the chat agent: connects GitHub MCP, exposes /agents/chat/<id>
.flue/ui.ts             # the minimal browser chat page (CHAT_PAGE_HTML), served at /
wrangler.jsonc          # CF config: ai binding + DO migration (FlueRegistry, Chat)
worker-env.d.ts         # types the AI / GITHUB_TOKEN / AI_GATEWAY_ID bindings
scripts/dev-local.mjs   # credential-free local preview (boots without wrangler login)
.dev.vars               # LOCAL placeholder secrets (gitignored)
```

## Browser chat UI

`GET /` serves a single self-contained HTML page (no framework, no build step).
It POSTs `{ message }` to `/agents/chat/<session>` and renders the assistant
reply; non-2xx responses (missing `GITHUB_TOKEN`, or no AI binding in
credential-free local dev) render as an inline error bubble, so the page stays
usable without secrets. The session id is generated per browser tab so the
conversation maps to a stable Durable Object-backed agent instance.

## Configuration (all via `env` bindings)

| Binding | What | Where set |
| --- | --- | --- |
| `AI` | Workers AI binding | `wrangler.jsonc` (`ai.binding`) |
| `GITHUB_TOKEN` | classic GitHub PAT, `repo` + `read:org` scopes (a **secret**) | `.dev.vars` (local) / `wrangler secret put` (deployed) |
| `AI_GATEWAY_ID` | named AI Gateway slug (non-secret **var**) | `.dev.vars` (local) / `wrangler.jsonc` `vars` (deployed) |

### GitHub token

The agent reads its GitHub credential **only** from `env.GITHUB_TOKEN`. Use a
**classic** Personal Access Token with these scopes:

- **`repo`** — read issues and pull requests in your repositories (including private ones).
- **`read:org`** — see the organizations you belong to, so the agent can reach
  PRs/issues across all of them.

Create one at <https://github.com/settings/tokens> (Tokens (classic) → Generate
new token). A classic PAT acts on behalf of your account, so it spans **every org
and repo you can access**.

> **Why not a fine-grained PAT?** Fine-grained tokens are scoped to a single
> resource owner (one user or one org), so they can't span all of your orgs at
> once. For "all my PRs and issues everywhere," a classic PAT is the right fit.

Store it as a deployed secret (never commit it):

```sh
wrangler secret put GITHUB_TOKEN
```

For local development, put it in `.dev.vars` (gitignored). The agent boots fine
without a token — the GitHub tools are simply disabled until one is present.

## Build

```sh
bun install
bun run build          # flue build --target cloudflare  ->  ./dist
```

The build emits `dist/gh_chat_agent/index.js` (the Worker) and a generated
`wrangler.json`. The agent Durable Object class is **`Chat`**; the migration in
`wrangler.jsonc` declares `["FlueRegistry", "Chat"]` to match.

## Local preview (no Cloudflare login, no real PAT)

```sh
bun run dev:local      # node scripts/dev-local.mjs  -> http://127.0.0.1:3583
```

Workers AI is a remote-only binding with no local emulation, so a bare
`flue dev` would require `wrangler login`. `dev:local` runs the dev server with
the `ai` binding temporarily removed (canonical `wrangler.jsonc` is restored on
exit), so the **chat endpoint serves with no credentials**. With the placeholder
`GITHUB_TOKEN`, the agent boots with no GitHub tools and is told to say it can't
reach GitHub. Live **model** replies are unavailable in this mode (no AI binding
locally) — a prompt returns Flue's "Cloudflare AI binding not available" error.
That's expected; full inference works once deployed (or locally with
`bun run dev` + a `CLOUDFLARE_API_TOKEN`).

Open the UI in a browser at **http://0.0.0.0:8080/** (the forwarder port), or
talk to the endpoint directly:

```sh
curl -X POST http://0.0.0.0:8080/agents/chat/my-session \
  -H 'Content-Type: application/json' -d '{"message":"list my open PRs"}'
```

Reuse the same `<id>` (`my-session`) to continue a conversation; use a new `<id>`
to start fresh. A WebSocket upgrade is available at the same path.

## Full local run (real inference)

```sh
export CLOUDFLARE_API_TOKEN=...   # or: wrangler login
# put a real GITHUB_TOKEN in .dev.vars
bun run dev                        # flue dev --target cloudflare (remote AI proxy)
```

> Note: `flue dev` binds to `127.0.0.1:3583` (hardcoded in `@flue/cli@0.9.1`; no
> `--host` flag). To expose it from inside this container, front it with a TCP
> forwarder to `0.0.0.0`, or run from the host.

## Deploy

`AI_GATEWAY_ID` is a non-secret `var` baked into `wrangler.jsonc`, so the only
secret to set is the GitHub PAT. You can deploy first and add it afterwards —
the worker boots fine without `GITHUB_TOKEN` (GitHub tools are simply disabled
until the secret is present).

Validate the entire deploy offline (no credentials needed):

```sh
bun run deploy:check     # preflight + flue build + wrangler deploy --dry-run
```

Real deploy (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` exported):

```sh
bun run deploy                   # preflight + flue build --target cloudflare + wrangler deploy
wrangler secret put GITHUB_TOKEN # add the GitHub PAT (classic, repo scope) when ready
```

`wrangler deploy` automatically targets the merged config that `flue build`
writes to `dist/gh_chat_agent/wrangler.json` (via a `.wrangler/deploy/config.json`
redirect) — not the bare root `wrangler.jsonc`. That merged config carries the
entry point, the `ai` binding, the `AI_GATEWAY_ID` var, and the
`v1 [FlueRegistry, Chat]` Durable Object migration.

Deployed endpoints:
`https://gh-chat-agent.<subdomain>.workers.dev/` (chat UI),
`/agents/chat/<id>` (HTTP POST) and `wss://.../agents/chat/<id>` (WebSocket).
