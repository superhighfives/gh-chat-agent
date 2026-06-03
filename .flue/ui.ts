/**
 * Minimal browser chat UI, served as a single self-contained HTML page.
 *
 * No framework, no build step: it POSTs `{ message }` to
 * `/agents/chat/<session>` (the same endpoint the agent already exposes) and
 * renders the assistant `text` from the JSON reply. Non-2xx responses (e.g. a
 * missing GITHUB_TOKEN or, in credential-free local dev, no AI binding) are
 * shown inline as an error bubble so the page stays usable without secrets.
 */
export const CHAT_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GitHub Chat Agent</title>
<style>
  :root { color-scheme: light dark; --fg: #1c1c1e; --muted: #6b6b70; --line: #d8d8dc;
    --user: #0b67ff; --agent: #f0f0f3; --err: #b00020; --errbg: #fdecef; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #f2f2f5; --muted: #a0a0a8; --line: #2c2c30; --agent: #1e1e22;
      --errbg: #3a1e22; --err: #ff6b81; }
    body { background: #131316; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, system-ui, Segoe UI, Roboto, sans-serif; color: var(--fg); }
  .wrap { max-width: 720px; margin: 0 auto; height: 100dvh; display: flex; flex-direction: column; }
  header { padding: 14px 16px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 16px; margin: 0; }
  header p { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 80%; padding: 9px 13px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
  .user { align-self: flex-end; background: var(--user); color: #fff; border-bottom-right-radius: 4px; }
  .agent { align-self: flex-start; background: var(--agent); border-bottom-left-radius: 4px; }
  .error { align-self: flex-start; background: var(--errbg); color: var(--err); border: 1px solid var(--err);
    border-radius: 10px; font-size: 13px; }
  .meta { align-self: center; color: var(--muted); font-size: 12px; }
  form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
  #input { flex: 1; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px;
    font: inherit; background: transparent; color: var(--fg); }
  button { padding: 10px 16px; border: 0; border-radius: 10px; background: var(--user); color: #fff;
    font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>GitHub Chat Agent</h1>
    <p>Ask about your GitHub pull requests and issues. Session: <span id="sid"></span></p>
  </header>
  <div id="log">
    <div class="meta">New conversation. Try: "list my open pull requests".</div>
  </div>
  <form id="form">
    <input id="input" placeholder="Message the agent…" autocomplete="off" autofocus />
    <button id="send" type="submit">Send</button>
  </form>
</div>
<script>
  // Stable per-tab session id -> same Durable Object-backed agent instance.
  const session = (() => {
    const key = "gh-chat-session";
    let id = sessionStorage.getItem(key);
    if (!id) { id = "web-" + Math.random().toString(36).slice(2, 10); sessionStorage.setItem(key, id); }
    return id;
  })();
  document.getElementById("sid").textContent = session;

  const log = document.getElementById("log");
  const form = document.getElementById("form");
  const input = document.getElementById("input");
  const send = document.getElementById("send");

  function add(text, cls) {
    const el = document.createElement("div");
    el.className = "msg " + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    add(message, "user");
    input.value = "";
    input.disabled = send.disabled = true;
    const pending = add("…", "agent");
    try {
      const res = await fetch("/agents/chat/" + encodeURIComponent(session), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const raw = await res.text();
      if (!res.ok) {
        pending.remove();
        add("Error " + res.status + ": " + raw.split("\\n")[0], "error");
        return;
      }
      let text = raw;
      try {
        const data = JSON.parse(raw);
        text = data.text ?? data.message ?? (typeof data === "string" ? data : raw);
      } catch { /* non-JSON: show raw */ }
      pending.textContent = text;
    } catch (err) {
      pending.remove();
      add("Network error: " + (err && err.message ? err.message : String(err)), "error");
    } finally {
      input.disabled = send.disabled = false;
      input.focus();
    }
  });
</script>
</body>
</html>`;
