#!/usr/bin/env node
/**
 * Deploy preflight. Guards against a wrangler.jsonc that was left stripped by an
 * interrupted `dev:local` run (which removes the `ai` binding for local boot and
 * restores it on exit — a hard kill can skip that restore). Deploying without
 * the `ai` binding would silently break model calls in production, so we refuse.
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';

const CANONICAL = 'wrangler.jsonc';
const BACKUP = '.wrangler.jsonc.canonical-bak';

// Self-heal: a leftover backup means a prior dev:local run was hard-killed and
// the committed config may be the stripped one. Restore canonical first.
if (existsSync(BACKUP)) {
  copyFileSync(BACKUP, CANONICAL);
  rmSync(BACKUP, { force: true });
  console.log('[preflight] restored wrangler.jsonc from a leftover dev:local backup.');
}

const text = readFileSync(CANONICAL, 'utf8');
const config = JSON.parse(
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'),
);

const problems = [];
if (!config.ai || config.ai.binding !== 'AI') problems.push('missing `ai` binding ({ binding: "AI" })');
if (config.vars?.AI_GATEWAY_ID !== 'gh-chat-agent')
  problems.push('missing or wrong vars.AI_GATEWAY_ID (expected "gh-chat-agent")');
const classes = config.migrations?.[0]?.new_sqlite_classes ?? [];
if (!classes.includes('FlueRegistry') || !classes.includes('Chat'))
  problems.push('migration v1 must list ["FlueRegistry", "Chat"]');

if (problems.length > 0) {
  console.error('[preflight] wrangler.jsonc is not deploy-ready:');
  for (const p of problems) console.error('  - ' + p);
  console.error('[preflight] check git / restore the canonical config before deploying.');
  process.exit(1);
}

console.log('[preflight] wrangler.jsonc OK: ai binding, AI_GATEWAY_ID var, and DO migration present.');
