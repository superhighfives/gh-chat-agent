import {
  type AgentRouteHandler,
  type AgentWebSocketHandler,
  connectMcpServer,
  createAgent,
} from '@flue/runtime';

// Worker bindings this agent reads come from the shared `Cloudflare.Env`
// augmentation in worker-env.d.ts (AI, GITHUB_TOKEN, AI_GATEWAY_ID). All config
// is env-driven — nothing about the deployment is hardcoded.
type Env = Cloudflare.Env;

// Expose the agent over HTTP POST and WebSocket at /agents/chat/<id>.
// Each middleware admits the request by calling next(); add auth here before
// deploying publicly.
export const route: AgentRouteHandler = async (_c, next) => next();
export const websocket: AgentWebSocketHandler = async (_c, next) => next();

// A placeholder/missing token must not crash agent init — the chat endpoint
// should still serve so the agent can explain what's wrong. Anything that
// isn't a plausible GitHub token is treated as "no GitHub access".
function hasUsableGitHubToken(token: string | undefined): token is string {
  // Classic PATs start `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`; fine-grained PATs
  // start `github_pat_`. Anything else (empty, the dev placeholder) means no
  // GitHub access.
  return typeof token === 'string' && /^(gh[posru]_|github_pat_)/.test(token);
}

export default createAgent<unknown, Env>(async ({ env }) => {
  // Connect the official hosted GitHub MCP server. Its tools are adapted into
  // ordinary Flue tools (named `mcp__github__<tool>`) and handed to the model.
  // Scoped read-only to the issues + pull_requests + context toolsets.
  //
  // If the token is absent or a dev placeholder, skip the connection entirely
  // and boot with no GitHub tools. A failed/garbage Authorization header would
  // otherwise throw during init and 500 the whole endpoint.
  const githubTools = hasUsableGitHubToken(env.GITHUB_TOKEN)
    ? (
        await connectMcpServer('github', {
          url: 'https://api.githubcopilot.com/mcp/',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            'X-MCP-Toolsets': 'issues,pull_requests,context',
            'X-MCP-Readonly': 'true',
          },
        })
      ).tools
    : [];

  return {
    // Workers AI model, routed via the named AI Gateway registered in app.ts.
    model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
    instructions: [
      'You are a helpful assistant that helps the user explore their own GitHub',
      'pull requests and issues across all of their organizations and repositories.',
      'Use the available github tools to look up real data before answering.',
      'Be concise. When you reference a PR or issue, cite it as <owner>/<repo>#<number>.',
      githubTools.length === 0
        ? 'NOTE: GitHub access is not configured (no valid GITHUB_TOKEN). Tell the user you cannot reach GitHub and that they need to set a GITHUB_TOKEN secret; do not invent PRs or issues.'
        : 'If a github tool call fails (for example, invalid credentials), say so plainly and suggest the user check their GITHUB_TOKEN — do not invent data.',
    ].join(' '),
    tools: githubTools,
  };
});
