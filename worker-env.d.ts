/**
 * Worker runtime bindings. Augments the `Cloudflare.Env` interface so that
 * `import { env } from 'cloudflare:workers'` is typed in `app.ts`, and provides
 * a shared `Env` shape for agent modules.
 */
declare namespace Cloudflare {
  interface Env {
    /** Workers AI binding, routed through a named AI Gateway in app.ts. */
    AI: Ai;
    /** Classic GitHub PAT (repo scope) for the hosted GitHub MCP server. */
    GITHUB_TOKEN: string;
    /** Named Cloudflare AI Gateway slug. */
    AI_GATEWAY_ID: string;
  }
}
