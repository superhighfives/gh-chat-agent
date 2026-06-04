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
 * (strong/em/code/pre/ul/ol/li/h3-h5/a/br/table/thead/tbody/tr/th/td). Link
 * hrefs are scheme-allowlisted (http/https/mailto only) or github.com URLs we
 * construct ourselves from auto-linked refs; anything else renders as plain
 * text. The result is assigned via innerHTML, but only our own tags can be
 * present. Emitted anchors are stashed before the emphasis pass so `_`/`*`
 * inside an href cannot be corrupted.
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

  // Bold then italic. Bold first so ** isn't consumed by the single-* italic
  // rule. Underscores follow CommonMark's intraword rule: `_` only delimits
  // emphasis at word boundaries, so identifiers like `a_b/c_d` are NOT
  // italicized (left as-is), while standalone `_italic_` still works. `*`
  // remains intraword-capable.
  const emphasize = (s: string): string =>
    s
      .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?!\s)([^\n]+?)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');

  // Build a stashed <a> with a trusted href and an (emphasized, already-escaped)
  // label. Stashing keeps the later emphasis pass away from the href.
  const anchor = (href: string, labelHtml: string): string =>
    stash('<a href="' + href + '" target="_blank" rel="noopener noreferrer ugc">' + labelHtml + '</a>');

  // Links: [label](url). label/url are already escaped; a `"` is &quot; so it
  // can't break out of href="...". Reject non-allowlisted schemes -> plain text.
  // Emphasis IS applied to the label first, so `[**bold**](url)` renders bold.
  text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const href = safeUrl(url);
    if (href === null) return emphasize(label); // not a real link -> plain (emphasized) text
    return anchor(href, emphasize(label));
  });

  // Auto-link bare GitHub refs AFTER explicit links + code are stashed, so we
  // never linkify inside an existing link, inside code, or inside an href.
  // Owner/repo/ref segments use GitHub's allowed name chars. A leading
  // (?<![\w/@#-]) boundary stops matches inside paths/words/code-ish text, and
  // the emitted anchor is stashed so emphasis can't touch the github.com href.
  //   owner/repo#123 -> https://github.com/owner/repo/issues/123 (PRs redirect)
  const NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
  text = text.replace(
    new RegExp("(^|[^\\w/@#-])(" + NAME + ")/(" + NAME + ")#(\\d+)(?![\\w-])", "g"),
    (_m, pre, owner, repo, num) =>
      pre + anchor("https://github.com/" + owner + "/" + repo + "/issues/" + num, owner + "/" + repo + "#" + num),
  );
  //   @user -> https://github.com/user  (1-39 chars, GitHub username rules)
  text = text.replace(
    /(^|[^\w/@-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g,
    (_m, pre, user) => pre + anchor("https://github.com/" + user, "@" + user),
  );

  // Tables are extracted and STASHED *before* the document-wide emphasis pass.
  // Each cell is emphasized individually here, so emphasis still works inside a
  // cell while `_`/`*` in cell text (repo names, paths) outside `**`/`_` pairs
  // can't be mangled by a document-wide match that would otherwise span cells.
  // Cells are already HTML-escaped and have code/links stashed, so a `|` is a
  // real delimiter (pipes inside code are NUL placeholders) and HTML in a cell
  // stays inert. Ragged rows are padded/truncated to the header column count.
  const splitRow = (line: string): string[] =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isDelimRow = (line: string): boolean =>
    /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
  {
    const src = text.split('\n');
    const acc: string[] = [];
    for (let i = 0; i < src.length; i++) {
      const line = src[i];
      if (line.includes('|') && i + 1 < src.length && isDelimRow(src[i + 1]) && !isDelimRow(line)) {
        const headers = splitRow(line);
        const cols = headers.length;
        let html = '<table><thead><tr>' + headers.map((h) => '<th>' + emphasize(h) + '</th>').join('') + '</tr></thead><tbody>';
        i += 1; // consume delimiter row
        while (i + 1 < src.length && src[i + 1].includes('|') && !isDelimRow(src[i + 1])) {
          i += 1;
          const cells = splitRow(src[i]);
          let row = '';
          for (let c = 0; c < cols; c++) row += '<td>' + emphasize(cells[c] ?? '') + '</td>';
          html += '<tr>' + row + '</tr>';
        }
        html += '</tbody></table>';
        acc.push(stash(html));
      } else {
        acc.push(line);
      }
    }
    text = acc.join('\n');
  }

  // Document-wide emphasis (links/refs/tables are already stashed, so their
  // hrefs and cell contents are safe from this pass).
  text = emphasize(text);

  // Build remaining blocks line by line: headings, ordered/unordered lists.
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

  // Restore stashed placeholders (code, links, tables). A stashed table can
  // itself contain stashed ref/code placeholders in its cells, so restore
  // repeatedly until none remain. Bounded by the stash count (each pass expands
  // at least the outermost layer) to guarantee termination.
  for (let pass = 0; pass <= codeBlocks.length && /\0\d+\0/.test(text); pass++) {
    text = text.replace(/\0(\d+)\0/g, (_m, i) => codeBlocks[Number(i)]);
  }

  // Remaining newlines -> <br>, but not those adjacent to our block tags.
  const BLOCK = 'ul|ol|li|h[3-5]|pre|table|thead|tbody|tr|th|td';
  text = text.replace(/\n/g, '<br>');
  text = text.replace(new RegExp('<br>(\\s*<(?:/?(?:' + BLOCK + ')>))', 'g'), '$1');
  text = text.replace(new RegExp('(</(?:' + BLOCK + ')>)\\s*<br>', 'g'), '$1');

  return text;
}

/**
 * The exact source of {@link renderMarkdown}, derived from the function object
 * itself. `.flue/ui.ts` inlines this into the page so the browser runs the same
 * bytes the test imports. Do not hand-write a copy.
 */
export const renderMarkdownSource: string = renderMarkdown.toString();
