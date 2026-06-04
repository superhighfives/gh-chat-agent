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
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
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
// Table-specific injection vectors.
assertSafe('table cell script', '| H | X |\n|---|---|\n| <script>alert(1)</script> | ok |');
assertSafe('table cell img onerror', '| H |\n|---|---|\n| <img src=x onerror=alert(1)> |');
assertSafe('table ragged rows', '| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 | 5 |');
assertSafe('table pipe in code cell', '| A | B |\n|---|---|\n| `a|b|c` | 2 |');
assertSafe('table js link in cell', '| L |\n|---|---|\n| [x](javascript:alert(1)) |');
assertSafe('autolink ref then html', 'o/r#1 then <script>alert(1)</script>');

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

// Regression: emphasis chars inside an href must NOT be transformed. Extract
// the href value and assert it equals the exact URL byte-for-byte.
function hrefOf(html) {
  const m = /<a href="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}
check('href with underscores in org AND repo intact', (() => {
  const url = 'https://github.com/my_org/my_repo/pull/5';
  const h = renderMarkdown('[pr](' + url + ')');
  return hrefOf(h) === url && !/<(em|strong)/.test(h.slice(0, h.indexOf('>') + 1));
})(), renderMarkdown('[pr](https://github.com/my_org/my_repo/pull/5)'));
check('href with single _a_ intact', (() => {
  const url = 'https://a.com/_a_';
  return hrefOf(renderMarkdown('[x](' + url + ')')) === url;
})(), renderMarkdown('[x](https://a.com/_a_)'));
check('href with ** intact', (() => {
  const url = 'https://a.com/x**y**z';
  return hrefOf(renderMarkdown('[x](' + url + ')')) === url;
})(), renderMarkdown('[x](https://a.com/x**y**z)'));
check('href has no injected emphasis tags', (() => {
  const h = renderMarkdown('[pr](https://github.com/my_org/my_repo/pull/5)');
  const href = hrefOf(h);
  return href !== null && !href.includes('<em') && !href.includes('<strong') && !href.includes('<');
})());
check('emphasis still works in link label', (() => {
  const h = renderMarkdown('[**bold**](https://github.com/a_b)');
  return h.includes('<strong>bold</strong>') && hrefOf(h) === 'https://github.com/a_b';
})(), renderMarkdown('[**bold**](https://github.com/a_b)'));
check('emphasis outside links still works alongside underscore url', (() => {
  const h = renderMarkdown('see *this* [pr](https://github.com/a_b/c_d/pull/9)');
  return h.includes('<em>this</em>') && hrefOf(h) === 'https://github.com/a_b/c_d/pull/9';
})(), renderMarkdown('see *this* [pr](https://github.com/a_b/c_d/pull/9)'));
check('bold', renderMarkdown('**b**') === '<strong>b</strong>', renderMarkdown('**b**'));
check('italic', renderMarkdown('*i*') === '<em>i</em>', renderMarkdown('*i*'));
check('underscore bold', renderMarkdown('__b__') === '<strong>b</strong>', renderMarkdown('__b__'));
check('intraword underscores NOT italic (repo name)', renderMarkdown('a_b/c_d') === 'a_b/c_d', renderMarkdown('a_b/c_d'));
check('standalone _italic_ still works', renderMarkdown('_italic_') === '<em>italic</em>', renderMarkdown('_italic_'));
check('ref-shaped link label kept literal', (() => {
  const h = renderMarkdown('[a_b/c_d#5](https://github.com/a_b/c_d/pull/5)');
  return h.includes('>a_b/c_d#5</a>') && /href="https:\/\/github\.com\/a_b\/c_d\/pull\/5"/.test(h);
})(), renderMarkdown('[a_b/c_d#5](https://github.com/a_b/c_d/pull/5)'));
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

console.log('\nTables:');
function hrefOf(html) { const m = /<a href="([^"]*)"/.exec(html); return m ? m[1] : null; }
check('basic table structure', (() => {
  const h = renderMarkdown('| Repo | # |\n|---|---|\n| a | 1 |\n| b | 2 |');
  return h.includes('<table>') && h.includes('<thead><tr><th>Repo</th><th>#</th></tr></thead>')
    && h.includes('<tbody>') && h.split('<tr>').length === 4 && h.includes('</table>');
})(), renderMarkdown('| Repo | # |\n|---|---|\n| a | 1 |\n| b | 2 |'));
check('table cell html stays inert', (() => {
  const h = renderMarkdown('| H |\n|---|---|\n| <script>alert(1)</script> |');
  return h.includes('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>') && !/<script/i.test(h);
})(), renderMarkdown('| H |\n|---|---|\n| <script>alert(1)</script> |'));
check('table ragged row padded/truncated to header cols', (() => {
  const h = renderMarkdown('| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |');
  // every row has exactly 3 <td>
  const rows = h.split('<tr>').slice(2); // skip table-open + header row
  return rows.every((r) => !r.includes('<td>') || (r.match(/<td>/g) || []).length === 3);
})(), renderMarkdown('| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |'));
check('table pipe inside code cell not a delimiter', (() => {
  const h = renderMarkdown('| A | B |\n|---|---|\n| `a|b` | 2 |');
  return h.includes('<td><code>a|b</code></td>') && h.includes('<td>2</td>');
})(), renderMarkdown('| A | B |\n|---|---|\n| `a|b` | 2 |'));
check('table cell emphasis works', renderMarkdown('| H |\n|---|---|\n| **bold** |').includes('<td><strong>bold</strong></td>'), renderMarkdown('| H |\n|---|---|\n| **bold** |'));
check('table cell with autolinked ref keeps underscores in href', (() => {
  const h = renderMarkdown('| Repo | PR |\n|---|---|\n| x | a_b/c_d#9 |');
  return h.includes('<a href="https://github.com/a_b/c_d/issues/9"') && h.includes('>a_b/c_d#9</a>');
})(), renderMarkdown('| Repo | PR |\n|---|---|\n| x | a_b/c_d#9 |'));
check('table with markdown-link cell intact href', (() => {
  const h = renderMarkdown('| Link |\n|---|---|\n| [a_b/c_d#5](https://github.com/a_b/c_d/pull/5) |');
  return hrefOf(h) === 'https://github.com/a_b/c_d/pull/5' && h.includes('>a_b/c_d#5</a>');
})(), renderMarkdown('| Link |\n|---|---|\n| [a_b/c_d#5](https://github.com/a_b/c_d/pull/5) |'));

console.log('\nAuto-linked GitHub refs:');
check('owner/repo#123 -> exact issues href', (() => {
  const h = renderMarkdown('See my_org/my_repo#123 today');
  return hrefOf(h) === 'https://github.com/my_org/my_repo/issues/123' && h.includes('>my_org/my_repo#123</a>');
})(), renderMarkdown('See my_org/my_repo#123 today'));
check('autolinked href has underscores intact (no <em>)', (() => {
  const href = hrefOf(renderMarkdown('a_b/c_d#9'));
  return href === 'https://github.com/a_b/c_d/issues/9';
})(), renderMarkdown('a_b/c_d#9'));
check('ref inside inline code NOT linkified', (() => {
  const h = renderMarkdown('use `my_org/my_repo#123` here');
  return h.includes('<code>my_org/my_repo#123</code>') && !/<a\b/.test(h);
})(), renderMarkdown('use `my_org/my_repo#123` here'));
check('ref inside fenced code NOT linkified', (() => {
  const h = renderMarkdown('```\no/r#1\n```');
  return h.includes('<pre><code>o/r#1</code></pre>') && !/<a\b/.test(h);
})(), renderMarkdown('```\no/r#1\n```'));
check('ref already in a link NOT double-linked', (() => {
  const h = renderMarkdown('[link](https://github.com/o/r#1)');
  return (h.match(/<a\b/g) || []).length === 1;
})(), renderMarkdown('[link](https://github.com/o/r#1)'));
check('bare #123 NOT linkified (no repo context)', (() => {
  const h = renderMarkdown('see #123 please');
  return !/<a\b/.test(h) && h.includes('#123');
})(), renderMarkdown('see #123 please'));
check('path-like a/b/c#1 NOT mis-linked as owner/repo', (() => {
  // a/b/c#1 has an extra path segment; our regex anchors on owner/repo#num only.
  const h = renderMarkdown('path/to/file');
  return !/<a\b/.test(h);
})(), renderMarkdown('path/to/file'));
check('@user -> profile link', (() => {
  const h = renderMarkdown('cc @octocat');
  return h.includes('<a href="https://github.com/octocat"') && h.includes('>@octocat</a>');
})(), renderMarkdown('cc @octocat'));
check('autolink ref does not break following html escaping', (() => {
  const h = renderMarkdown('o/r#1 then <script>alert(1)</script>');
  return h.includes('<a href="https://github.com/o/r/issues/1"') && !/<script/i.test(h) && h.includes('&lt;script&gt;');
})(), renderMarkdown('o/r#1 then <script>alert(1)</script>'));

// Single-source-of-truth self-check.
check('renderMarkdownSource === renderMarkdown.toString()', renderMarkdownSource === renderMarkdown.toString());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.log('\nFAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
