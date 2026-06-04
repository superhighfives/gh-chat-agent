#!/usr/bin/env bun
/**
 * XSS + formatting test for the chat UI markdown renderer.
 *
 * Imports the SAME `renderMarkdown` that ships in the page: `.flue/ui.ts`
 * inlines `renderMarkdown.toString()` from `.flue/markdown.ts`, and this test
 * imports `renderMarkdown` from that same module. One function, two consumers —
 * they cannot drift. Run with: `bun scripts/markdown.test.mjs`.
 *
 * SAFETY ORACLE: after escape-first rendering, the only literal `<` characters
 * in the output are tags the renderer itself emitted (every input `<` became
 * `&lt;`). So we parse the LIVE tags out of the output and assert:
 *   - every live tag is in our fixed allowlist (no script/img/svg/iframe/...),
 *   - no live tag carries an on*-event handler attribute,
 *   - every live href uses an allowlisted scheme.
 * Dangerous input that survives only as escaped text (e.g. `&lt;img onerror=…`)
 * is inert and correctly ignored.
 */
import { renderMarkdown, renderMarkdownSource } from '../.flue/markdown.ts';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' -- ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

const ALLOWED_TAGS = new Set([
  'a', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'br',
  'h3', 'h4', 'h5',
]);
const ALLOWED_HREF = /^(https?:\/\/|mailto:)/i;

// Pull every LIVE tag (real `<`, not `&lt;`) out of the rendered HTML and audit
// it. Returns an array of problems; empty means safe.
function auditLiveHtml(html) {
  const problems = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (!ALLOWED_TAGS.has(tag)) problems.push('disallowed tag <' + tag + '>');
    if (/\son[a-z]+\s*=/i.test(attrs)) problems.push('event-handler attr on <' + tag + '>: ' + attrs.trim());
    const href = /href\s*=\s*"([^"]*)"/i.exec(attrs);
    if (href && !ALLOWED_HREF.test(href[1])) problems.push('bad href scheme: ' + href[1]);
    // Any attribute value carrying a script-y scheme on a live tag is a problem.
    if (/(javascript|vbscript|data)\s*:/i.test(attrs)) problems.push('scheme in live attr on <' + tag + '>: ' + attrs.trim());
  }
  return problems;
}

function assertSafe(name, input) {
  const html = renderMarkdown(input);
  const problems = auditLiveHtml(html);
  check(name, problems.length === 0, problems.length ? problems.join('; ') + ' | out=' + html : '');
  return html;
}

console.log('XSS / injection vectors (live-HTML audit):');
assertSafe('script tag', '<script>alert(1)</script>');
assertSafe('img onerror', '<img src=x onerror=alert(1)>');
assertSafe('svg onload', '<svg onload=alert(1)>');
assertSafe('iframe + js src', '<iframe src="javascript:alert(1)"></iframe>');
assertSafe('object/embed', '<object data="x"></object><embed src="y">');
assertSafe('js link', '[click](javascript:alert(1))');
assertSafe('js link uppercase', '[x](JavaScript:alert(1))');
assertSafe('js link leading spaces', '[x](   javascript:alert(1))');
assertSafe('js link tab-obfuscated', '[x](java\tscript:alert(1))');
assertSafe('data link', '[x](data:text/html,<script>alert(1)</script>)');
assertSafe('vbscript link', '[x](vbscript:msgbox(1))');
assertSafe('href quote breakout', '[a](https://ok" onmouseover="alert(1))');
assertSafe('label tag injection', '[<img src=x onerror=alert(1)>](https://github.com)');
assertSafe('image js payload', '![alt](javascript:alert(1))');
assertSafe('bold wrapping html', '**bold <img src=x onerror=alert(1)>**');
assertSafe('code fence breakout', '```\n</code><script>alert(1)</script>\n```');
assertSafe('inline code breakout', '`</code><script>alert(1)</script>`');
assertSafe('amp colon scheme trick', '[x](javascript&colon;alert(1))');
assertSafe('mixed payload', 'Hi <b>x</b> [a](JAVASCRIPT:1) **ok** `<i>` end');

// Structural assertions on dangerous-link handling:
check('js link -> no anchor', !/<a\b/i.test(renderMarkdown('[click](javascript:alert(1))')));
check('js link -> keeps label text', renderMarkdown('[click](javascript:alert(1))').includes('click'));
check('dangerous input survives only escaped', (() => {
  const h = renderMarkdown('<img src=x onerror=alert(1)>');
  return h.includes('&lt;img') && !/<img/i.test(h);
})(), renderMarkdown('<img src=x onerror=alert(1)>'));

console.log('\nLegit formatting:');
check('safe https link -> anchor with rel', (() => {
  const h = renderMarkdown('[GitHub](https://github.com)');
  return h.includes('<a href="https://github.com"') && h.includes('rel="noopener noreferrer ugc"') && h.includes('>GitHub</a>');
})(), renderMarkdown('[GitHub](https://github.com)'));
check('mailto allowed', renderMarkdown('[mail](mailto:x@y.com)').includes('<a href="mailto:x@y.com"'));
check('bold', renderMarkdown('**b**') === '<strong>b</strong>', renderMarkdown('**b**'));
check('italic', renderMarkdown('*i*') === '<em>i</em>', renderMarkdown('*i*'));
check('underscore bold', renderMarkdown('__b__') === '<strong>b</strong>', renderMarkdown('__b__'));
check('inline code', renderMarkdown('`c`') === '<code>c</code>', renderMarkdown('`c`'));
check('inline code keeps stars literal', renderMarkdown('`**x**`') === '<code>**x**</code>', renderMarkdown('`**x**`'));
check('heading modest (h3, not h1)', (() => {
  const h = renderMarkdown('# Title');
  return h.includes('<h3>Title</h3>') && !/<h1|<h2\b/.test(h);
})(), renderMarkdown('# Title'));
check('deep heading clamps to h5', renderMarkdown('###### Deep').includes('<h5>Deep</h5>'), renderMarkdown('###### Deep'));
check('unordered list', (() => {
  const h = renderMarkdown('- one\n- two');
  return h.includes('<ul>') && h.split('<li>').length === 3 && h.includes('</ul>');
})(), renderMarkdown('- one\n- two'));
check('ordered list', (() => {
  const h = renderMarkdown('1. a\n2. b');
  return h.includes('<ol>') && h.includes('<li>a</li>') && h.includes('<li>b</li>') && h.includes('</ol>');
})(), renderMarkdown('1. a\n2. b'));
check('fenced code block', renderMarkdown('```\nconst x = 1;\n```').includes('<pre><code>const x = 1;</code></pre>'), renderMarkdown('```\nconst x = 1;\n```'));
check('newlines -> br', renderMarkdown('a\nb') === 'a<br>b', renderMarkdown('a\nb'));
check('plain ampersand escaped', renderMarkdown('a & b') === 'a &amp; b', renderMarkdown('a & b'));
check('mixed reply renders', (() => {
  const h = renderMarkdown('Here is **bold**, `code`, and a list:\n- alpha\n- beta\n\nSee [repo](https://github.com/o/r#1).');
  return h.includes('<strong>bold</strong>') && h.includes('<code>code</code>') && h.includes('<ul>') && h.includes('<a href="https://github.com/o/r#1"');
})());

// Single-source-of-truth self-check.
check('renderMarkdownSource === renderMarkdown.toString()', renderMarkdownSource === renderMarkdown.toString());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.log('\nFAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
