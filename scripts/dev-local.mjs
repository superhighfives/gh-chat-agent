#!/usr/bin/env node
/**
 * Credential-free local preview.
 *
 * `flue dev --target cloudflare` opens a wrangler *remote* proxy whenever a
 * remote-only binding is present. Workers AI (`ai` binding) is always remote
 * and has no local emulation, so a bare `flue dev` demands `wrangler login` (or
 * a CLOUDFLARE_API_TOKEN) before it will boot.
 *
 * For a no-credentials preview we run dev against a generated copy of the
 * canonical `wrangler.jsonc` with the `ai` binding removed. The chat endpoint
 * serves and the agent is fully wired; only live model inference is
 * unavailable locally (it works once deployed, or with a real token + the AI
 * binding). The canonical wrangler.jsonc stays the single source of truth — the
 * dev config is derived from it on every run, then restored on exit.
 */
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

const CANONICAL = 'wrangler.jsonc';
const BACKUP = '.wrangler.jsonc.canonical-bak';
// flue dev binds 127.0.0.1 only (hardcoded in @flue/cli). We run it there and
// expose a 0.0.0.0 forwarder so the preview is reachable through the container
// proxy. PORT = the public/forwarder port; FLUE_PORT = flue's internal port.
const PORT = process.env.PORT ?? '8080';
const FLUE_PORT = process.env.FLUE_PORT ?? '3583';

function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// SELF-HEAL: if a backup is left over from a prior run that was hard-killed
// (kill -9 skips our restore handlers), the committed wrangler.jsonc may be the
// stripped, ai-less version. The backup holds the real canonical bytes — restore
// them before doing anything else, so a previous crash can never cascade into
// backing up an already-stripped config.
if (existsSync(BACKUP)) {
  copyFileSync(BACKUP, CANONICAL);
  rmSync(BACKUP, { force: true });
}

// Capture the canonical bytes in memory so restore() works even if the backup
// file is later removed. We only ever strip a config that actually has `ai`.
const originalBytes = readFileSync(CANONICAL, 'utf8');
const config = JSON.parse(stripJsonComments(originalBytes));
if (!('ai' in config)) {
  console.error('[dev-local] wrangler.jsonc has no `ai` binding — refusing to run.');
  console.error('[dev-local] the committed config looks wrong; check git before continuing.');
  process.exit(1);
}
delete config.ai; // drop the remote-only binding for local boot

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  // Restore from the in-memory original bytes (authoritative), then drop the
  // backup. Idempotent and independent of the backup file's presence.
  writeFileSync(CANONICAL, originalBytes);
  rmSync(BACKUP, { force: true });
}

writeFileSync(BACKUP, originalBytes);
writeFileSync(CANONICAL, JSON.stringify(config, null, 2) + '\n');

process.on('SIGINT', () => { restore(); process.exit(0); });
process.on('SIGTERM', () => { restore(); process.exit(0); });
process.on('exit', restore);

console.log('[dev-local] booting flue dev with the `ai` binding removed (no Cloudflare login required).');
console.log('[dev-local] live model inference is disabled locally; the chat endpoint still serves.');

// Invoke the locally installed flue CLI entry directly (avoids PATH lookup).
const flueBin = 'node_modules/@flue/cli/bin/flue.mjs';
if (!existsSync(flueBin)) {
  restore();
  console.error(`[dev-local] cannot find ${flueBin}; run \`bun install\` first.`);
  process.exit(1);
}

// 0.0.0.0:PORT -> 127.0.0.1:FLUE_PORT forwarder so the preview is reachable
// from outside the container (flue dev itself only binds loopback).
const forwarder = createServer((downstream) => {
  const upstream = connect(Number(FLUE_PORT), '127.0.0.1');
  downstream.on('error', () => upstream.destroy());
  upstream.on('error', () => downstream.destroy());
  downstream.pipe(upstream);
  upstream.pipe(downstream);
});
forwarder.on('error', (err) => console.error('[dev-local] forwarder error:', err.message));
forwarder.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[dev-local] forwarding 0.0.0.0:${PORT} -> 127.0.0.1:${FLUE_PORT}`);
});

const child = spawn(
  process.execPath,
  [flueBin, 'dev', '--target', 'cloudflare', '--port', String(FLUE_PORT)],
  { stdio: 'inherit' },
);
child.on('error', (err) => { restore(); forwarder.close(); console.error('[dev-local]', err); process.exit(1); });
child.on('exit', (code) => { restore(); forwarder.close(); process.exit(code ?? 0); });
