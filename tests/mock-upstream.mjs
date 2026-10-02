// Local stand-ins for the Anthropic API, the Gemini API, and Scryfall, used by the tests
// and the local preview. Nothing here ships to users.
import http from 'node:http';

const CARDS = {
  'questing beast': {
    id: 'e8a0e3a1-0000-4000-8000-000000000001', name: 'Questing Beast', layout: 'normal', mana_cost: '{2}{G}{G}', cmc: 4,
    type_line: 'Legendary Creature — Beast', power: '4', toughness: '4', keywords: ['Vigilance', 'Deathtouch', 'Haste'],
    oracle_text: "Vigilance, deathtouch, haste\nQuesting Beast can't be blocked by creatures with power 2 or less.\nCombat damage that would be dealt by creatures you control can't be prevented.\nWhenever Questing Beast deals combat damage to an opponent, it deals that much damage to target planeswalker that player controls.",
    set_name: 'Throne of Eldraine', colors: ['G'],
    legalities: { commander: 'legal', modern: 'legal', standard: 'not_legal', vintage: 'legal' },
  },
  'lightning bolt': {
    id: 'e8a0e3a1-0000-4000-8000-000000000002', name: 'Lightning Bolt', layout: 'normal', mana_cost: '{R}', cmc: 1,
    type_line: 'Instant', keywords: [], oracle_text: 'Lightning Bolt deals 3 damage to any target.', set_name: 'Magic 2010', colors: ['R'],
    legalities: { commander: 'legal', modern: 'legal', legacy: 'legal' },
  },
  'delver of secrets': {
    id: 'e8a0e3a1-0000-4000-8000-000000000003', name: 'Delver of Secrets // Insectile Aberration', layout: 'transform', cmc: 1,
    type_line: 'Creature — Human Wizard // Creature — Human Insect', keywords: ['Transform', 'Flying'], set_name: 'Innistrad', colors: ['U'],
    legalities: { legacy: 'legal', pauper: 'legal' },
    card_faces: [
      { name: 'Delver of Secrets', mana_cost: '{U}', type_line: 'Creature — Human Wizard', power: '1', toughness: '1',
        oracle_text: 'At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.' },
      { name: 'Insectile Aberration', mana_cost: '', type_line: 'Creature — Human Insect', power: '3', toughness: '2', oracle_text: 'Flying' },
    ],
  },
};

const RULINGS = {
  'Questing Beast': [
    { published_at: '2019-10-04', comment: "If Questing Beast's last ability triggers, its controller may choose a target planeswalker even if that planeswalker's controller has no damage dealt to them." },
    { published_at: '2019-10-04', comment: 'The damage dealt to the planeswalker is dealt by Questing Beast and has deathtouch.' },
  ],
  'Lightning Bolt': [],
  'Delver of Secrets // Insectile Aberration': [{ published_at: '2011-09-22', comment: 'You can reveal the card even if it is not an instant or sorcery.' }],
};

function placeholderSvg(name) {
  const safe = name.replace(/[<&>]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680" viewBox="0 0 488 680"><rect width="488" height="680" rx="24" fill="#171310"/><rect x="18" y="18" width="452" height="644" rx="14" fill="#2f4a2a" stroke="#c9a84c" stroke-width="4"/><rect x="40" y="96" width="408" height="300" fill="#6d8a5a"/><text x="44" y="70" font-family="Georgia" font-size="30" fill="#f2e6c4">${safe}</text><text x="44" y="450" font-family="Georgia" font-size="22" fill="#f2e6c4">Test card image</text></svg>`;
}

function withUris(card, base) {
  const c = structuredClone(card);
  const img = (n) => ({
    small: `${base}/img/${encodeURIComponent(n)}.svg`, normal: `${base}/img/${encodeURIComponent(n)}.svg`,
    large: `${base}/img/${encodeURIComponent(n)}.svg`, art_crop: `${base}/img/${encodeURIComponent(n)}.svg`,
  });
  if (c.card_faces) c.card_faces = c.card_faces.map((f) => ({ ...f, image_uris: img(f.name) }));
  else c.image_uris = img(c.name);
  c.rulings_uri = `${base}/cards/${c.id}/rulings`;
  c.scryfall_uri = `https://scryfall.com/card/test/${c.id}`;
  c.object = 'card';
  return c;
}

function sse(res, events, delay = 15) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let i = 0;
  const tick = () => {
    if (i >= events.length) return res.end();
    res.write(events[i++]);
    setTimeout(tick, delay);
  };
  tick();
}

function chunkText(text, size = 18) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const FINAL_ANSWER = `**Yes, deathtouch and trample work together beautifully.** With [[Questing Beast]] attacking, one damage to each blocker counts as lethal, so the rest tramples over to the player.

Here's what's happening:
1. You assign damage to blockers first, but "lethal" only means 1 because of deathtouch (702.2c).
2. Once every blocker has lethal assigned, the excess can go to the player (702.19b).

So a 4/4 blocked by a single 5/5 deals 1 to the blocker and 3 to the face. Great question, this one trips people up all the time.`;

function anthropicReply(body) {
  const last = body.messages[body.messages.length - 1];
  const hasToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const events = [ev({ type: 'message_start', message: { id: 'msg_test', role: 'assistant', content: [] } })];
  if (!hasToolResult && body.tool_choice?.type !== 'none') {
    events.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    events.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the card text and trample rules.' } }));
    events.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-claude-1' } }));
    events.push(ev({ type: 'content_block_stop', index: 0 }));
    events.push(ev({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }));
    events.push(ev({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Let me pull up the card and the rules.' } }));
    events.push(ev({ type: 'content_block_stop', index: 3 }));
    events.push(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'lookup_card', input: {} } }));
    events.push(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"name": "Quest' } }));
    events.push(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ing Beast"}' } }));
    events.push(ev({ type: 'content_block_stop', index: 1 }));
    events.push(ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_02', name: 'search_rules', input: {} } }));
    events.push(ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":"deathtouch trample lethal damage"}' } }));
    events.push(ev({ type: 'content_block_stop', index: 2 }));
    events.push(ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }));
  } else if (hasToolResult && !body.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use' && b.name === 'get_rules'))) {
    events.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_03', name: 'get_rules', input: {} } }));
    events.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"rules":["702.19","702.2c"]}' } }));
    events.push(ev({ type: 'content_block_stop', index: 0 }));
    events.push(ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
  } else {
    events.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    for (const t of chunkText(FINAL_ANSWER)) events.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }));
    events.push(ev({ type: 'content_block_stop', index: 0 }));
    events.push(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
  }
  events.push(ev({ type: 'message_stop' }));
  return events;
}

function geminiReply(body) {
  const last = body.contents[body.contents.length - 1];
  const hasResponse = last.parts.some((p) => p.functionResponse);
  const d = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
  if (!hasResponse && body.toolConfig?.functionCallingConfig?.mode !== 'NONE') {
    return [
      d({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'lookup_card', args: { name: 'Questing Beast' } }, thoughtSignature: 'sig-abc' }] } }] }),
      d({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_rules', args: { query: 'deathtouch trample' } } }] }, finishReason: 'STOP' }] }),
    ];
  }
  return [
    ...chunkText(FINAL_ANSWER, 60).map((t) => d({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })),
    d({ candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'sig-final' }] }, finishReason: 'STOP' }] }),
  ];
}

export function startMocks(port = 0, { slow = 15 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/v1/messages') {
      if (req.headers['x-api-key'] !== 'test-anthropic-key') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
      return sse(res, anthropicReply(body), slow);
    }
    if (url.pathname.includes(':streamGenerateContent')) {
      if (req.headers['x-goog-api-key'] !== 'test-gemini-key') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid' } })); }
      return sse(res, geminiReply(body), slow);
    }

    // Scryfall
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/cards/named') {
      const q = (url.searchParams.get('fuzzy') || url.searchParams.get('exact') || '').toLowerCase();
      const key = Object.keys(CARDS).find((k) => k.startsWith(q.slice(0, 6)) || q.includes(k));
      if (!key) return sendJson(404, { object: 'error', code: 'not_found', status: 404, details: `No cards found matching "${q}"` });
      if (url.searchParams.get('format') === 'image') { res.writeHead(302, { Location: `${base}/img/${encodeURIComponent(CARDS[key].card_faces ? CARDS[key].card_faces[0].name : CARDS[key].name)}.svg` }); return res.end(); }
      return sendJson(200, withUris(CARDS[key], base));
    }
    if (/^\/cards\/[^/]+\/rulings$/.test(url.pathname)) {
      const card = Object.values(CARDS).find((c) => url.pathname.includes(c.id));
      return sendJson(200, { object: 'list', data: (RULINGS[card?.name] || []).map((r) => ({ ...r, source: 'wotc' })) });
    }
    if (url.pathname === '/cards/autocomplete') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const names = ['Questing Beast', 'Lightning Bolt', 'Delver of Secrets', 'Lightning Helix', 'Questing Druid'].filter((n) => n.toLowerCase().includes(q));
      return sendJson(200, { object: 'catalog', data: names });
    }
    if (url.pathname === '/cards/search') {
      return sendJson(200, { object: 'list', total_cards: 2, data: [withUris(CARDS['questing beast'], base), withUris(CARDS['lightning bolt'], base)] });
    }
    if (url.pathname.startsWith('/sym/')) {
      const s = decodeURIComponent(url.pathname.slice(5).replace(/\.svg$/, ''));
      const fill = { G: '#9bd3ae', R: '#f9aa8f', U: '#aae0fa', B: '#cbc2bf', W: '#fffbd5' }[s] || '#cac5c0';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="${fill}"/><text x="16" y="21" text-anchor="middle" font-family="Georgia" font-size="15" fill="#111">${s.replace(/[<&>]/g, '')}</text></svg>`);
    }
    if (url.pathname.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(placeholderSvg(decodeURIComponent(url.pathname.slice(5).replace(/\.svg$/, ''))));
    }
    sendJson(404, { error: 'mock: unknown path ' + url.pathname });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() });
  }));
}
