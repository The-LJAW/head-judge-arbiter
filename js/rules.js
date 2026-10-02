// Comprehensive Rules lookup and search. Runs in the browser and in Node (for tests).
// data/rules.json shape: { effective, sections: { "702": "Keyword Abilities" }, rules: [[id, text, examples?]], glossary: [[term, definition]] }

const STOP = new Set(('a an and are as at be but by can do does for from has have if in into is it its of on or that the their them then there these they this to was what when where which while who will with you your i my me we our ' +
  'how why would could should does did any each than so not no yes').split(' '));

export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

const RULE_ID = /^\d{3}(\.\d+[a-z]*)?$/;

export function createRulesIndex(data) {
  const byId = new Map();
  const order = [];
  for (const [id, text, examples] of data.rules) {
    byId.set(id, { id, text, examples: examples || [] });
    order.push(id);
  }
  const glossary = data.glossary.map(([term, def]) => ({ term, def }));
  const glossByTerm = new Map(glossary.map((g) => [g.term.toLowerCase(), g]));

  const sectionOf = (id) => id.slice(0, 3);
  const parentOf = (id) => id.replace(/[a-z]+$/, '');

  // A rule like "702.19 Trample" is a heading for its subrules.
  function heading(id) {
    const parent = byId.get(parentOf(id));
    if (parent && parent.text.length < 60 && !/[.:]$/.test(parent.text)) return parent.text;
    return data.sections[sectionOf(id)] || '';
  }

  function children(id) {
    const prefix = id + (/\.\d+$/.test(id) ? '' : '.');
    if (/\.\d+$/.test(id)) {
      return order.filter((r) => r !== id && r.startsWith(id) && /^[a-z]+$/.test(r.slice(id.length)));
    }
    return order.filter((r) => r.startsWith(prefix) && /^\d+$/.test(r.slice(prefix.length)));
  }

  // ---------- BM25 index ----------
  const docs = [];
  for (const id of order) {
    const r = byId.get(id);
    const head = heading(id);
    const toks = [...tokenize(head), ...tokenize(head), ...tokenize(r.text), ...tokenize(r.examples.join(' '))];
    docs.push({ kind: 'rule', id, toks });
  }
  for (const g of glossary) {
    const toks = [...tokenize(g.term), ...tokenize(g.term), ...tokenize(g.term), ...tokenize(g.def)];
    docs.push({ kind: 'glossary', id: g.term, toks });
  }
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    d.tf = new Map();
    for (const t of d.toks) d.tf.set(t, (d.tf.get(t) || 0) + 1);
    for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    d.len = d.toks.length;
    totalLen += d.len;
    delete d.toks;
  }
  const avgLen = totalLen / docs.length;
  const N = docs.length;
  const idf = (t) => {
    const n = df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  function search(query, limit = 8) {
    const out = [];
    const seen = new Set();
    // Direct rule numbers in the query come first.
    for (const m of query.matchAll(/\b(\d{3}\.\d+[a-z]?)\b/g)) {
      if (byId.has(m[1]) && !seen.has(m[1])) { seen.add(m[1]); out.push({ kind: 'rule', id: m[1], score: 999 }); }
    }
    const q = [...new Set(tokenize(query))];
    if (q.length) {
      const k1 = 1.2, b = 0.75;
      const scored = [];
      for (const d of docs) {
        let s = 0, hits = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          hits++;
          s += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
        }
        if (s > 0) {
          // Reward documents that match more of the query's distinct terms.
          s *= 1 + (0.6 * hits) / q.length;
          if (d.kind === 'glossary') s *= 0.85;
          scored.push({ kind: d.kind, id: d.id, score: s });
        }
      }
      scored.sort((a, b2) => b2.score - a.score);
      for (const r of scored) {
        if (out.length >= limit) break;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
    return out.slice(0, limit);
  }

  function lookupGlossary(term) {
    return glossByTerm.get(term.toLowerCase().trim()) || null;
  }

  function formatRule(r, withExamples = true) {
    let s = `${r.id} ${r.text}`;
    if (withExamples) for (const ex of r.examples) s += `\n  Example: ${ex}`;
    return s;
  }

  // Text the model receives from get_rules.
  function getRulesText(ids, maxChars = 14000) {
    const parts = [];
    const found = [];
    for (const raw of ids.slice(0, 8)) {
      const id = String(raw).trim().replace(/^(rule|cr)\s*/i, '').replace(/\.$/, '');
      if (RULE_ID.test(id) && id.length === 3) {
        const title = data.sections[id];
        if (!title) { parts.push(`Section ${id} does not exist.`); continue; }
        const kids = children(id);
        const lines = kids.slice(0, 140).map((k) => {
          const t = byId.get(k).text;
          return `${k} ${t.length > 110 ? t.slice(0, 110) + '...' : t}`;
        });
        parts.push(`Section ${id}: ${title}\n${lines.join('\n')}${kids.length > 140 ? `\n(${kids.length - 140} more rules not shown)` : ''}`);
        found.push(id);
      } else if (byId.has(id)) {
        const r = byId.get(id);
        const head = heading(id);
        let block = `[${sectionOf(id)}. ${data.sections[sectionOf(id)] || ''}${head && head !== data.sections[sectionOf(id)] ? ' > ' + head : ''}]\n`;
        if (/[a-z]$/.test(id)) {
          const parent = byId.get(parentOf(id));
          if (parent && parent.text.length >= 60) block += `${parent.id} ${parent.text.slice(0, 300)}${parent.text.length > 300 ? '...' : ''}\n`;
          block += formatRule(r);
        } else {
          block += [r, ...children(id).map((k) => byId.get(k))].map((x) => formatRule(x)).join('\n');
        }
        parts.push(block);
        found.push(id);
      } else {
        const g = lookupGlossary(id);
        if (g) { parts.push(`Glossary: ${g.term}\n${g.def}`); found.push(g.term); }
        else parts.push(`Rule ${id} was not found in the current Comprehensive Rules. Rule numbers shift between editions, so use search_rules to find the right one.`);
      }
    }
    let text = parts.join('\n\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n(Truncated. Ask for a narrower rule number.)';
    return { text, found };
  }

  function searchText(query, limit = 8) {
    const hits = search(query, limit);
    if (!hits.length) return { text: `No rules matched "${query}". Try different words, a keyword name, or a glossary term.`, hits };
    const lines = hits.map((h) => {
      if (h.kind === 'glossary') {
        const g = lookupGlossary(h.id);
        return `Glossary "${g.term}": ${g.def.replace(/\n/g, ' ')}`;
      }
      const r = byId.get(h.id);
      const head = heading(h.id);
      const t = r.text.length > 420 ? r.text.slice(0, 420) + '...' : r.text;
      return `${h.id} [${head}] ${t}`;
    });
    return {
      text: `Top matches in the Comprehensive Rules (effective ${data.effective}) for "${query}":\n${lines.join('\n')}\nCall get_rules with a number to read the full rule and its subrules.`,
      hits,
    };
  }

  return {
    effective: data.effective,
    sections: data.sections,
    has: (id) => byId.has(id) || (id.length === 3 && !!data.sections[id]),
    get: (id) => byId.get(id) || null,
    heading,
    children,
    parentOf,
    sectionOf,
    search,
    searchText,
    getRulesText,
    lookupGlossary,
    glossary,
    order,
  };
}
