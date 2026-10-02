// Scryfall client. Scryfall asks for gentle request pacing, so calls are queued about
// 100 ms apart, and every response is cached for the session.

const cfg = () => window.HJA_CONFIG || {};
const base = () => (cfg().scryfallBase || 'https://api.scryfall.com').replace(/\/$/, '');
export const symbolBase = () => (cfg().symbolBase || 'https://svgs.scryfall.io/card-symbols').replace(/\/$/, '');

let chain = Promise.resolve();
let last = 0;
function paced(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, last + 100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

const cache = new Map();
async function getJson(url, { pace = true } = {}) {
  if (cache.has(url)) return cache.get(url);
  const p = (pace ? paced : (f) => f())(async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.details || `Scryfall answered ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

export async function namedCard(name) {
  return getJson(`${base()}/cards/named?fuzzy=${encodeURIComponent(name)}`);
}

export async function rulings(card) {
  if (!card.rulings_uri) return [];
  const res = await getJson(card.rulings_uri);
  return res.data || [];
}

export async function autocomplete(q) {
  if (q.trim().length < 2) return [];
  const res = await getJson(`${base()}/cards/autocomplete?q=${encodeURIComponent(q.trim())}`, { pace: false });
  return res.data || [];
}

export async function searchCards(q) {
  try {
    const res = await getJson(`${base()}/cards/search?order=edhrec&q=${encodeURIComponent(q)}`);
    return { total: res.total_cards || 0, cards: res.data || [] };
  } catch (err) {
    if (err.status === 404) return { total: 0, cards: [] };
    throw err;
  }
}

export function imageUrl(card, face = 0, size = 'normal') {
  if (!card) return '';
  if (card.image_uris) return card.image_uris[size] || card.image_uris.normal;
  const f = card.card_faces && card.card_faces[face];
  return (f && f.image_uris && (f.image_uris[size] || f.image_uris.normal)) || '';
}

export function hasBackFace(card) {
  return !!(card && !card.image_uris && card.card_faces && card.card_faces.length > 1 && card.card_faces[1].image_uris);
}

export function namedImageUrl(name) {
  return `${base()}/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`;
}

function faceText(f) {
  const lines = [`${f.name}${f.mana_cost ? ' ' + f.mana_cost : ''}`, f.type_line || ''];
  if (f.oracle_text) lines.push(f.oracle_text);
  if (f.power !== undefined) lines.push(`${f.power}/${f.toughness}`);
  if (f.loyalty !== undefined) lines.push(`Starting loyalty: ${f.loyalty}`);
  if (f.defense !== undefined) lines.push(`Defense: ${f.defense}`);
  return lines.filter(Boolean).join('\n');
}

// The text the judge model receives for a card.
export function cardForModel(card, rulingList) {
  const parts = [];
  if (card.card_faces && card.card_faces.length && !card.oracle_text) {
    parts.push(`${card.name} (${card.layout} card with ${card.card_faces.length} faces)`);
    card.card_faces.forEach((f, i) => parts.push(`Face ${i + 1}:\n${faceText(f)}`));
  } else {
    parts.push(faceText(card));
  }
  if (card.keywords && card.keywords.length) parts.push(`Keywords: ${card.keywords.join(', ')}`);
  const legal = Object.entries(card.legalities || {}).filter(([, v]) => v === 'legal' || v === 'restricted').map(([k, v]) => (v === 'restricted' ? `${k} (restricted)` : k));
  if (legal.length) parts.push(`Legal in: ${legal.join(', ')}`);
  if (rulingList && rulingList.length) {
    parts.push('Official rulings:\n' + rulingList.slice(0, 25).map((r) => `- ${r.published_at}: ${r.comment}`).join('\n'));
  } else {
    parts.push('Official rulings: none published.');
  }
  return parts.join('\n\n');
}
