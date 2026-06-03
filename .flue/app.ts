import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { CHAT_PAGE_HTML } from './ui.ts';

/**
 * Route every `cloudflare/...` model call through a *named* AI Gateway instead
 * of the account's default gateway. User registrations win over Flue's
 * auto-registered `cloudflare` default (last-write-wins in the generated
 * Worker), and `app.ts` runs before that default's guard.
 *
 * The gateway slug is read from the `AI_GATEWAY_ID` binding so nothing about
 * the deployment target is hardcoded.
 */
registerProvider('cloudflare', {
  api: 'cloudflare-ai-binding',
  binding: env.AI,
  gateway: { id: env.AI_GATEWAY_ID },
});

const app = new Hono();

// Minimal browser chat UI. Served before flue() so `/` returns the page; the
// page talks to the agent over the `/agents/chat/<id>` route flue() mounts.
app.get('/', (c) => c.html(CHAT_PAGE_HTML));

// `flue()` mounts the generated agent/workflow routes. The chat agent is
// exposed at `/agents/chat/<id>` (HTTP POST and WebSocket upgrade).
app.route('/', flue());

export default app;
