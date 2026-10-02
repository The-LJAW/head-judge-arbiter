// Small, safe markdown renderer for judge answers.
// Escapes all HTML first, then adds a limited set of formatting plus two app-specific
// links: [[Card Name]] opens the card and rule numbers like 702.19b open the rule.
// They are inline links rather than buttons so they wrap with the surrounding text.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function escapeHtml(s) { return esc(String(s)); }

const RULE_RE = /(^|[^\d.\w])([1-9]\d{2}\.\d{1,3}[a-z]?)(?![\d\w])/g;
// "rule 704" or "section 702" (a whole section, no subrule)
const SECTION_RE = /(\b(?:[Rr]ules?|[Ss]ection) )([1-9]\d{2})(?![\d\w]|\.\d)/g;

function cardButton(name) {
  const n = name.trim();
  return `<a class="card-ref" href="#card" data-card="${esc(n)}">${esc(n)}</a>`;
}
const ruleLink = (id) => `<a class="rule-ref" href="#rule-${id}" data-rule="${id}">${id}</a>`;

export function inline(text, opts = {}) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text);
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (_, name) => keep(cardButton(name)));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) => keep(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`));
  s = esc(s);
  s = s.replace(/\*\*([^*\n](?:[^*\n]|\*(?!\*))*?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
  if (opts.rules !== false) {
    s = s.replace(RULE_RE, (m, pre, id) => {
      if (opts.ruleExists && !opts.ruleExists(id)) return m;
      return `${pre}${ruleLink(id)}`;
    });
    s = s.replace(SECTION_RE, (m, pre, id) => {
      if (opts.ruleExists && !opts.ruleExists(id)) return m;
      return `${pre}${ruleLink(id)}`;
    });
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

export function renderMarkdown(src, opts = {}) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { type: 'ul' | 'ol', items: [{ html, nested }] , start }
  let quote = [];
  let code = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const start = list.type === 'ol' && list.start > 1 ? ` start="${list.start}"` : '';
      out.push(`<${list.type}${start}>${list.items.map((it) => `<li${it.nested ? ' class="nested"' : ''}>${it.html}</li>`).join('')}</${list.type}>`);
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${renderMarkdown(quote.join('\n'), opts)}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (code) {
      if (/^\s*```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(rawLine);
      continue;
    }
    if (/^\s*```/.test(line)) { flushAll(); code = []; continue; }
    if (!line.trim()) { flushPara(); flushQuote(); if (list) list.gap = true; continue; }

    let m;
    if ((m = line.match(/^\s{0,3}>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if (quote.length) flushQuote();

    if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*)$/))) { flushAll(); out.push(`<h4>${inline(m[1].replace(/#+$/, ''), opts)}</h4>`); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    const ul = line.match(/^(\s*)[-*+\u2022]\s+(.*)$/);
    const ol = line.match(/^(\s*)(\d{1,3})[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const indent = (ul || ol)[1].length;
      const type = ul ? 'ul' : 'ol';
      const body = ul ? ul[2] : ol[3];
      const nested = indent >= 2 && list;
      if (!list || (!nested && list.type !== type)) {
        flushList();
        list = { type, items: [], start: ol ? Number(ol[2]) : 1 };
      }
      list.items.push({ html: inline(body, opts), nested: !!nested });
      list.gap = false;
      continue;
    }
    if (list && /^\s{2,}\S/.test(rawLine) && !list.gap) {
      const last = list.items[list.items.length - 1];
      last.html += '<br>' + inline(line.trim(), opts);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('');
}

// Plain-text version for copying a ruling into Discord or a text message.
export function toPlainText(src) {
  return String(src || '').replace(/\[\[([^\[\]]+)\]\]/g, '$1');
}

// Card names written as [[Name]] in a piece of text.
export function cardNamesIn(src) {
  return [...new Set([...String(src || '').matchAll(/\[\[([^\[\]\n]{1,80})\]\]/g)].map((m) => m[1].trim()))];
}

export function ruleIdsIn(src) {
  return [...new Set([...String(src || '').matchAll(RULE_RE)].map((m) => m[2]))];
}
