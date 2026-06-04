/**
 * Escape-first, XSS-safe markdown renderer for the chat UI.
 *
 * SINGLE SOURCE OF TRUTH: this exact function is shipped two ways —
 *   1. The unit test (`scripts/markdown.test.mjs`) imports `renderMarkdown` and
 *      runs it directly.
 *   2. The page (`.flue/ui.ts`) inlines `renderMarkdownSource` — which is this
 *      function's own `.toString()` — into the browser `<script>`.
 * Because the inlined string is derived from the function object itself (not a
 * copy), the browser runs byte-for-byte what the test verifies. They cannot
 * drift.
 *
 * Security model: the entire input is HTML-escaped FIRST, so no untrusted HTML
 * survives. Subsequent transforms only ADD a fixed set of our own tags
 * (strong/em/code/pre/ul/ol/li/h3-h5/a/br). Link hrefs are scheme-allowlisted
 * (http/https/mailto only); anything else renders as plain text. The result is
 * assigned via innerHTML, but only our own tags can be present.
 */
export function renderMarkdown(src: string): string {
  const esc = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Strip NUL so our placeholder sentinel can't be smuggled in via input.
  let text = esc(String(src).replace(/\0/g, ''));

  // Pull code out FIRST (operating on already-escaped text) so inline markdown
  // inside code is not transformed. Placeholders use NUL, which input lacks.
  const codeBlocks: string[] = [];
  const stash = (html: string): string => {
    codeBlocks.push(html);
    return '\0' + (codeBlocks.length - 1) + '\0';
  };
  // Fenced ```...``` (optional language label on the opening fence is dropped).
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => stash('<pre><code>' + code.replace(/\n$/, '') + '</code></pre>'));
  // Inline `code`.
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => stash('<code>' + code + '</code>'));

  // Scheme allowlist: trim leading whitespace/control chars, case-insensitive.
  const safeUrl = (u: string): string | null => {
    const trimmed = u.replace(/^[\u0000-\u0020]+/, '');
    return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
  };

  // Bold then italic. Bold first so ** isn't consumed by the single-* italic rule.
  const emphasize = (s: string): string =>
    s
      .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^\n]+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_(?!\s)([^_\n]+?)_(?![_])/g, '$1<em>$2</em>');

  // Links: [label](url). label/url are already escaped; a `"` is &quot; so it
  // can't break out of href="...". Reject non-allowlisted schemes -> plain text.
  //
  // The assembled <a> is STASHED into the same placeholder mechanism as code,
  // so the later document-wide emphasis pass cannot mangle `_`/`*` inside the
  // href (org/repo/file names use underscores heavily). Emphasis IS still
  // applied to the label first, so `[**bold**](url)` renders bold.
  text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const href = safeUrl(url);
    if (href === null) return emphasize(label); // not a real link -> plain (emphasized) text
    return stash('<a href="' + href + '" target="_blank" rel="noopener noreferrer ugc">' + emphasize(label) + '</a>');
  });

  // Document-wide emphasis (links are already stashed, so hrefs are untouched).
  text = emphasize(text);

  // Build blocks line by line: headings, ordered/unordered lists, paragraphs.
  const lines = text.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (listType) {
      out.push('</' + listType + '>');
      listType = null;
    }
  };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      // Modest headings: clamp to h3..h5 so they don't dominate a chat bubble.
      const level = Math.min(5, 2 + heading[1].length);
      out.push('<h' + level + '>' + heading[2] + '</h' + level + '>');
    } else if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push('<li>' + ul[1] + '</li>');
    } else if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push('<li>' + ol[1] + '</li>');
    } else {
      closeList();
      out.push(line);
    }
  }
  closeList();
  text = out.join('\n');

  // Restore stashed placeholders (code blocks and links). Done after emphasis
  // so neither hrefs nor code contents were touched by inline transforms.
  text = text.replace(/\0(\d+)\0/g, (_m, i) => codeBlocks[Number(i)]);

  // Remaining newlines -> <br>, but not those adjacent to our block tags.
  text = text.replace(/\n/g, '<br>');
  text = text.replace(/<br>(\s*<(?:\/?(?:ul|ol|li|h[3-5]|pre)>))/g, '$1');
  text = text.replace(/(<\/(?:ul|ol|li|h[3-5]|pre)>)\s*<br>/g, '$1');

  return text;
}

/**
 * The exact source of {@link renderMarkdown}, derived from the function object
 * itself. `.flue/ui.ts` inlines this into the page so the browser runs the same
 * bytes the test imports. Do not hand-write a copy.
 */
export const renderMarkdownSource: string = renderMarkdown.toString();
