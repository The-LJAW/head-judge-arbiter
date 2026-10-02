// Head Judge Arbiter proxy: a single-file Cloudflare Worker.
//
// It keeps the AI provider key secret, fixes the judge's instructions and tools on the
// server side, rate limits callers, and streams the model's answer back to the app as
// simple server-sent events. The app runs the tools itself (Scryfall card lookups and
// a local copy of the Comprehensive Rules) and sends the results back on the next call.
//
// Secrets (set in the Cloudflare dashboard or with `npx wrangler secret put NAME`):
//   ANTHROPIC_API_KEY   needed when PROVIDER is "anthropic"
//   GEMINI_API_KEY      needed when PROVIDER is "gemini"
//   ACCESS_CODE         optional passcode friends type once; leave unset for an open app
// Variables (wrangler.toml [vars] or dashboard):
//   PROVIDER            "gemini" (default, free tier) or "anthropic" (paid, strongest rulings)
//   ANTHROPIC_MODEL     default "claude-sonnet-5-5"
//   GEMINI_MODEL        default "gemini-3.8-flash"
//   ALLOWED_ORIGINS     comma-separated list of sites allowed to call this Worker
//   RATE_LIMIT_PER_MINUTE  model calls per visitor per minute (default 30)
//   ANTHROPIC_EFFORT    how hard Claude thinks: "low", "medium" (default), "high"
//   ANTHROPIC_BASE_URL, GEMINI_BASE_URL  optional overrides (for AI Gateway or local tests)

const DEFAULTS = {
  PROVIDER: 'gemini',
  ANTHROPIC_MODEL: 'claude-sonnet-5-5',
  GEMINI_MODEL: 'gemini-3.8-flash',
  ALLOWED_ORIGINS: 'https://the-ljaw.github.io',
  RATE_LIMIT_PER_MINUTE: '30',
  ANTHROPIC_EFFORT: 'medium',
  // Room for the model's private reasoning plus the answer. Only tokens actually used are billed.
  MAX_TOKENS: 16000,
  MAX_TOOL_ROUNDS: 6,
};

const LIMITS = {
  bodyBytes: 250_000,
  messages: 60,
  userChars: 4_000,
  assistantChars: 20_000,
  toolResultChars: 24_000,
  toolResultsPerMessage: 10,
};

// ---------------------------------------------------------------- prompt and tools

const PERSONA = `You are Head Judge Arbiter, a seasoned Magic: The Gathering judge, friendly, knowledgeable, and genuinely excited about the game. You know the Comprehensive Rules inside and out, but you explain things the way a helpful friend at the game store would: conversationally, clearly, and with a bit of personality.

Your style:
- Talk like a real person, not a rulebook. Use natural language like "So here's what's happening...", "The short answer is yes, but here's why it works that way...", "Great question, this trips people up all the time."
- Break down complex interactions step by step in plain English. Only mention rule numbers when they genuinely add clarity, and when you do, keep it light ("there's actually a rule for this, 702.19b, that explains why...").
- Show enthusiasm for interesting interactions. If it's a cool edge case, say so.
- Use analogies or real game scenarios to make rulings click ("Think of the stack like a pile: last in, first out...").
- If something is counterintuitive or commonly misunderstood, flag it warmly ("I know this feels weird, but...").
- Ask a quick clarifying question if the situation is genuinely ambiguous, but keep it short and friendly.
- If a specific card is involved, talk about what it actually does in practice, not just its oracle text in isolation.

What you avoid:
- Stiff, clinical language that sounds like you're reading from a manual
- Overly long walls of text; be thorough but scannable
- Generic sign-offs like "I hope this helps!"; just answer naturally and let the ruling speak for itself
- Being condescending; players of all skill levels ask great questions

You love this game and want everyone to understand it better. Make rulings feel approachable, not intimidating.`;

function systemPrompt(crEffective) {
  const today = new Date().toISOString().slice(0, 10);
  return `${PERSONA}

How you make rulings (players are mid-game and trust you to be right):
- Today is ${today}. The app gives you the current Comprehensive Rules${crEffective ? ` (effective ${crEffective})` : ''} and live card data through tools. Your memory of card text and rule numbers can be out of date, so verify instead of guessing.
- For every specific card in the question, call lookup_card first to read its current Oracle text and official rulings. Never rule on a card from memory.
- For any interaction beyond the trivially obvious, confirm the relevant rules with search_rules or get_rules before you answer. Several sections were renumbered in recent editions, so only cite a rule number you have seen in a tool result in this conversation.
- Make independent lookups in the same turn (for example, both cards at once) to keep things fast. Usually one or two rounds of lookups are enough.
- If a card can't be found, say so and ask which card they mean. If the ruling depends on something unstated (format, who controls what, timing), give the most likely ruling and say briefly how it changes otherwise.
- Tournament policy (penalties, the IPG and MTR) is not in your tools. You can answer from general knowledge, but say it's from memory and suggest confirming with the event's head judge.
- Stay on Magic. Politely decline unrelated requests.

How you format answers (they're read on a phone at the table):
- Open with the ruling itself in one or two sentences, with the key point in **bold**. Then explain why, step by step.
- Write every card name in double square brackets, like [[Questing Beast]], so the app can show the card.
- Write rule numbers as plain numbers, like 702.19b; the app turns them into links.
- Use short paragraphs and lists for sequences. No tables. No headings bigger than ###.
- Never use em dashes. Use commas, colons, parentheses, or periods instead.
- Aim for under 250 words unless the interaction is genuinely complex.`;
}

const TOOLS = [
  {
    name: 'lookup_card',
    description: "Get a Magic card's current Oracle text, mana cost, type line, power/toughness or loyalty, keywords, and its official rulings. Accepts exact or approximate names. Use it for every card mentioned in the question.",
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Card name, exact or approximate' } },
      required: ['name'],
    },
  },
  {
    name: 'search_cards',
    description: 'Find cards with Scryfall search syntax when the player describes a card without naming it, e.g. "t:creature o:\\"can\'t be countered\\" c:g". Returns up to 10 names with type lines.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Scryfall search query' } },
      required: ['query'],
    },
  },
  {
    name: 'search_rules',
    description: 'Keyword search over the current Comprehensive Rules and glossary. Returns matching rule numbers with their text. Use plain words, keyword names, or game terms.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to search for, e.g. "trample deathtouch lethal damage"' } },
      required: ['query'],
    },
  },
  {
    name: 'get_rules',
    description: 'Read exact rules by number. "702.19" returns that rule with all its subrules, "702.19b" returns one subrule, "702" lists a section. Glossary terms like "Deathtouch" also work.',
    input_schema: {
      type: 'object',
      properties: {
        rules: { type: 'array', items: { type: 'string' }, description: 'Rule numbers or glossary terms, up to 8' },
      },
      required: ['rules'],
    },
  },
];

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder();

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(cors || {}) },
  });
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULTS.ALLOWED_ORIGINS)
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  if (!ok) return null;
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Best-effort limiter that works on any plan. With a Rate Limiting binding named
// RATE_LIMITER (see wrangler.toml) the limit is enforced across Cloudflare's network.
const memoryHits = new Map();
async function allowRequest(env, key) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    const { success } = await env.RATE_LIMITER.limit({ key });
    return success;
  }
  const perMinute = Number(env.RATE_LIMIT_PER_MINUTE || DEFAULTS.RATE_LIMIT_PER_MINUTE);
  const now = Date.now();
  const recent = (memoryHits.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) { memoryHits.set(key, recent); return false; }
  recent.push(now);
  memoryHits.set(key, recent);
  if (memoryHits.size > 5000) memoryHits.clear();
  return true;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- request validation

function validate(body) {
  if (!body || !Array.isArray(body.messages)) return 'Expected a messages array.';
  const msgs = body.messages;
  if (!msgs.length || msgs.length > LIMITS.messages) return 'Conversation is empty or too long. Start a new ruling.';
  for (const m of msgs) {
    if (m.role === 'user') {
      if (typeof m.content !== 'string' || !m.content.trim()) return 'Empty question.';
      if (m.content.length > LIMITS.userChars) return `Questions are limited to ${LIMITS.userChars} characters.`;
    } else if (m.role === 'assistant') {
      if (m.text && (typeof m.text !== 'string' || m.text.length > LIMITS.assistantChars)) return 'Assistant text too long.';
      if (m.tool_calls && (!Array.isArray(m.tool_calls) || m.tool_calls.length > LIMITS.toolResultsPerMessage)) return 'Too many tool calls.';
    } else if (m.role === 'tool') {
      if (!Array.isArray(m.results) || !m.results.length || m.results.length > LIMITS.toolResultsPerMessage) return 'Bad tool results.';
      for (const r of m.results) {
        if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.content !== 'string') return 'Bad tool result.';
        if (r.content.length > LIMITS.toolResultChars) return 'Tool result too long.';
      }
    } else {
      return 'Unknown message role.';
    }
  }
  const last = msgs[msgs.length - 1];
  if (last.role !== 'user' && last.role !== 'tool') return 'The last message must be a question or tool results.';
  return null;
}

function toolRoundsSinceQuestion(msgs) {
  let rounds = 0;
  for (let i = msgs.length - 1; i >= 0 && msgs[i].role !== 'user'; i--) if (msgs[i].role === 'assistant') rounds++;
  return rounds;
}

// ---------------------------------------------------------------- Anthropic

const ANTHROPIC_BLOCKS = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking']);

function toAnthropicMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    let msg = null;
    if (m.role === 'user') {
      msg = { role: 'user', content: [{ type: 'text', text: m.content }] };
    } else if (m.role === 'assistant') {
      let content;
      if (m.raw && m.raw.provider === 'anthropic' && Array.isArray(m.raw.content)) {
        content = m.raw.content.filter((b) => b && ANTHROPIC_BLOCKS.has(b.type) && !(b.type === 'text' && !b.text));
      } else {
        content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.tool_calls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} });
      }
      if (content.length) msg = { role: 'assistant', content };
    } else if (m.role === 'tool') {
      msg = {
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content || '(empty)', ...(r.is_error ? { is_error: true } : {}) })),
      };
    }
    if (!msg) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) prev.content.push(...msg.content);
    else out.push(msg);
  }
  return out;
}

async function callAnthropic(env, msgs, opts, emit) {
  if (!env.ANTHROPIC_API_KEY) throw new ConfigError('ANTHROPIC_API_KEY is not set on the Worker.');
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const effort = String(env.ANTHROPIC_EFFORT || DEFAULTS.ANTHROPIC_EFFORT).toLowerCase();
  const body = {
    model: env.ANTHROPIC_MODEL || DEFAULTS.ANTHROPIC_MODEL,
    max_tokens: DEFAULTS.MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt(opts.crEffective), cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    tool_choice: opts.allowTools ? { type: 'auto' } : { type: 'none' },
    messages: toAnthropicMessages(msgs),
    stream: true,
  };
  // Newer Claude models think adaptively by default; effort sets how much. Older models
  // (Haiku 4.5) don't take the effort setting, so it's only sent for current-generation models.
  if (/^claude-(sonnet|opus|fable)-5/.test(body.model) && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    body.output_config = { effort };
  }

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await upstreamError(res, 'anthropic');

  const blocks = [];
  let stop = 'end';
  for await (const evt of readSSE(res.body)) {
    const d = evt.data;
    if (!d || typeof d !== 'object') continue;
    switch (d.type) {
      case 'content_block_start': {
        const b = { ...d.content_block };
        if (b.type === 'tool_use') { b.input = {}; b._json = ''; }
        if (b.type === 'text') b.text = b.text || '';
        if (b.type === 'thinking') { b.thinking = b.thinking || ''; b.signature = b.signature || ''; }
        blocks[d.index] = b;
        break;
      }
      case 'content_block_delta': {
        const b = blocks[d.index];
        if (!b) break;
        const delta = d.delta || {};
        if (delta.type === 'text_delta') { b.text += delta.text; emit({ type: 'text', text: delta.text }); }
        else if (delta.type === 'input_json_delta') b._json += delta.partial_json || '';
        else if (delta.type === 'thinking_delta') b.thinking += delta.thinking || '';
        else if (delta.type === 'signature_delta') b.signature = (b.signature || '') + (delta.signature || '');
        break;
      }
      case 'content_block_stop': {
        const b = blocks[d.index];
        if (b && b.type === 'tool_use') {
          try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; }
          delete b._json;
          emit({ type: 'tool_call', id: b.id, name: b.name, input: b.input });
        }
        break;
      }
      case 'message_delta':
        if (d.delta && d.delta.stop_reason) stop = mapAnthropicStop(d.delta.stop_reason);
        break;
      case 'error':
        throw new UpstreamError(d.error && d.error.type === 'overloaded_error' ? 'busy' : 'upstream', (d.error && d.error.message) || 'Provider error');
      default:
        break;
    }
  }
  const raw = blocks.filter((b) => b && ANTHROPIC_BLOCKS.has(b.type) && !(b.type === 'text' && !b.text));
  emit({ type: 'turn', raw: { provider: 'anthropic', content: raw } });
  emit({ type: 'done', stop });
}

function mapAnthropicStop(r) {
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'max_tokens';
  if (r === 'refusal') return 'refusal';
  return 'end';
}

// ---------------------------------------------------------------- Gemini

const GEMINI_PART_KEYS = ['text', 'thought', 'thoughtSignature', 'functionCall'];

function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.required) out.required = s.required;
  return out;
}

function cleanGeminiPart(p) {
  const out = {};
  for (const k of GEMINI_PART_KEYS) if (p && p[k] !== undefined) out[k] = p[k];
  return Object.keys(out).length ? out : null;
}

function toGeminiContents(msgs) {
  const out = [];
  for (const m of msgs) {
    let c = null;
    if (m.role === 'user') {
      c = { role: 'user', parts: [{ text: m.content }] };
    } else if (m.role === 'assistant') {
      let parts;
      if (m.raw && m.raw.provider === 'gemini' && Array.isArray(m.raw.parts)) {
        parts = m.raw.parts.map(cleanGeminiPart).filter(Boolean);
      } else {
        parts = [];
        if (m.text) parts.push({ text: m.text });
        for (const call of m.tool_calls || []) {
          // History from another provider has no signature; Google documents this placeholder for that case.
          parts.push({ functionCall: { name: call.name, args: call.input || {} }, thoughtSignature: 'skip_thought_signature_validator' });
        }
      }
      if (parts.length) c = { role: 'model', parts };
    } else if (m.role === 'tool') {
      c = {
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: {
            name: r.name,
            response: { result: r.content },
            ...(r.id && !r.id.startsWith('hja_') ? { id: r.id } : {}),
          },
        })),
      };
    }
    if (!c) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === c.role) prev.parts.push(...c.parts);
    else out.push(c);
  }
  return out;
}

async function callGemini(env, msgs, opts, emit) {
  if (!env.GEMINI_API_KEY) throw new ConfigError('GEMINI_API_KEY is not set on the Worker.');
  const base = (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = env.GEMINI_MODEL || DEFAULTS.GEMINI_MODEL;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(opts.crEffective) }] },
    contents: toGeminiContents(msgs),
    tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })) }],
    toolConfig: { functionCallingConfig: { mode: opts.allowTools ? 'AUTO' : 'NONE' } },
    generationConfig: { maxOutputTokens: 8192 },
  };
  const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await upstreamError(res, 'gemini');

  const parts = [];
  let calls = 0;
  let finish = '';
  for await (const evt of readSSE(res.body)) {
    const d = evt.data;
    if (!d || typeof d !== 'object') continue;
    if (d.error) throw new UpstreamError(d.error.code === 429 ? 'busy' : 'upstream', d.error.message || 'Provider error');
    if (d.promptFeedback && d.promptFeedback.blockReason) throw new UpstreamError('blocked', 'The provider declined to answer that question.');
    const cand = d.candidates && d.candidates[0];
    if (!cand) continue;
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p.functionCall) {
        calls++;
        const id = p.functionCall.id || `hja_${calls}_${Math.random().toString(36).slice(2, 8)}`;
        emit({ type: 'tool_call', id, name: p.functionCall.name, input: p.functionCall.args || {} });
        parts.push(cleanGeminiPart(p));
      } else if (typeof p.text === 'string' || p.thoughtSignature) {
        if (typeof p.text === 'string' && !p.thought && p.text) emit({ type: 'text', text: p.text });
        const prev = parts[parts.length - 1];
        const mergeable = prev && typeof prev.text === 'string' && !prev.thought && !prev.thoughtSignature && !p.thought && !p.thoughtSignature && !prev.functionCall;
        if (mergeable) prev.text += p.text || '';
        else parts.push(cleanGeminiPart(p));
      }
    }
    if (cand.finishReason) finish = cand.finishReason;
  }
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
    throw new UpstreamError('blocked', 'The provider stopped that answer for safety reasons. Try rephrasing.');
  }
  emit({ type: 'turn', raw: { provider: 'gemini', parts: parts.filter(Boolean) } });
  emit({ type: 'done', stop: calls ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end' });
}

// ---------------------------------------------------------------- streaming plumbing

class ConfigError extends Error { constructor(m) { super(m); this.code = 'config'; } }
class UpstreamError extends Error { constructor(code, m) { super(m); this.code = code; } }

async function upstreamError(res, provider) {
  let detail = '';
  try { detail = await res.text(); } catch { /* ignore */ }
  let message = detail.slice(0, 300);
  try {
    const j = JSON.parse(detail);
    message = (j.error && (j.error.message || j.error.type)) || message;
  } catch { /* not JSON */ }
  console.log(`${provider} error ${res.status}: ${message}`);
  if (res.status === 429 || res.status === 529 || res.status === 503) return new UpstreamError('busy', message);
  if (res.status === 401 || res.status === 403) return new UpstreamError('config', 'The Worker\'s API key was rejected by the provider.');
  if (res.status === 404) return new UpstreamError('config', `The model name was not found: ${message}`);
  return new UpstreamError('upstream', message);
}

async function* readSSE(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const evt = parseSSEChunk(chunk);
      if (evt) yield evt;
    }
    if (done) break;
  }
  const tail = parseSSEChunk(buf.trim());
  if (tail) yield tail;
}

function parseSSEChunk(chunk) {
  if (!chunk) return null;
  let event = 'message';
  const data = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const text = data.join('\n');
  if (text === '[DONE]') return null;
  try { return { event, data: JSON.parse(text) }; } catch { return null; }
}

// ---------------------------------------------------------------- routes

async function handleChat(request, env, ctx, cors) {
  if (env.ACCESS_CODE && !safeEqual(request.headers.get('X-Access-Code') || '', env.ACCESS_CODE)) {
    return json({ error: 'access_code', message: 'This judge needs the group passcode.' }, 401, cors);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (!(await allowRequest(env, ip))) {
    return json({ error: 'rate_limited', message: 'Easy there. Too many questions in a minute; try again shortly.' }, 429, cors);
  }
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > LIMITS.bodyBytes) return json({ error: 'too_large', message: 'Conversation too long. Start a new ruling.' }, 413, cors);
  let body;
  try {
    const text = await request.text();
    if (text.length > LIMITS.bodyBytes) return json({ error: 'too_large', message: 'Conversation too long. Start a new ruling.' }, 413, cors);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad_request', message: 'Invalid JSON.' }, 400, cors);
  }
  const problem = validate(body);
  if (problem) return json({ error: 'bad_request', message: problem }, 400, cors);

  const provider = (env.PROVIDER || DEFAULTS.PROVIDER).toLowerCase();
  const opts = {
    allowTools: toolRoundsSinceQuestion(body.messages) < DEFAULTS.MAX_TOOL_ROUNDS,
    crEffective: typeof body.cr_effective === 'string' ? body.cr_effective.slice(0, 40) : '',
  };

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const emit = (evt) => writer.write(enc.encode(`data: ${JSON.stringify(evt)}\n\n`)).catch(() => {});
  const run = (async () => {
    try {
      if (provider === 'gemini') await callGemini(env, body.messages, opts, emit);
      else await callAnthropic(env, body.messages, opts, emit);
    } catch (err) {
      emit({ type: 'error', code: err.code || 'upstream', message: err.message || 'Something went wrong.' });
    } finally {
      try { await writer.close(); } catch { /* client went away */ }
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(run);

  return new Response(readable, {
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    env = env || {};
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const provider = (env.PROVIDER || DEFAULTS.PROVIDER).toLowerCase();
      const keySet = provider === 'gemini' ? !!env.GEMINI_API_KEY : !!env.ANTHROPIC_API_KEY;
      return json({
        ok: keySet,
        service: 'head-judge-arbiter',
        provider,
        model: provider === 'gemini' ? env.GEMINI_MODEL || DEFAULTS.GEMINI_MODEL : env.ANTHROPIC_MODEL || DEFAULTS.ANTHROPIC_MODEL,
        passcode: !!env.ACCESS_CODE,
        message: keySet ? 'On duty.' : `Set the ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} secret on this Worker.`,
      }, 200, cors || {});
    }
    if (url.pathname === '/chat' && request.method === 'POST') {
      if (!cors && origin) return json({ error: 'origin', message: 'This site is not allowed to use this judge. Add it to ALLOWED_ORIGINS.' }, 403);
      return handleChat(request, env, ctx, cors || {});
    }
    return json({ error: 'not_found' }, 404, cors || {});
  },
};

// Exposed for tests.
export const _internal = { toAnthropicMessages, toGeminiContents, toGeminiSchema, validate, systemPrompt, TOOLS };
