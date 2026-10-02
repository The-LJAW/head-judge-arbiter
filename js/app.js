// Head Judge Arbiter: app logic.
import { renderMarkdown, inline, escapeHtml as esc, toPlainText, ruleIdsIn } from './markdown.js';
import { createRulesIndex } from './rules.js';
import * as scry from './scryfall.js';
import { runTool, pendingLabel } from './tools.js';

const CFG = window.HJA_CONFIG || {};
const PROXY = String(CFG.proxyUrl || '').trim().replace(/\/$/, '');
const MAX_ROUNDS = 8;
const STORE_KEY = 'hja.threads.v1';
const CODE_KEY = 'hja.passcode';
const CURRENT_KEY = 'hja.current';

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const els = {
  app: $('#app'),
  thread: $('#thread'),
  form: $('#ask-form'),
  input: $('#question'),
  send: $('#btn-send'),
  suggest: $('#suggest'),
  status: $('#status'),
  sheet: $('#sheet'),
  sheetBody: $('#sheet-body'),
  sheetTitle: $('#sheet-title'),
  sheetBack: $('#sheet-back'),
  scrim: $('#scrim'),
  peek: $('#card-peek'),
  toast: $('#toast'),
  announcer: $('#announcer'),
  fineprint: $('#fineprint'),
};

const SUGGESTIONS = [
  'Can my opponent respond to my instant after I declare it?',
  "What happens when two 'as enters' replacement effects conflict?",
  'Does deathtouch work with trample?',
  "Can I activate a planeswalker's ability the turn it enters?",
];

// ------------------------------------------------------------------ storage

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or full */ }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

function loadThreads() { return store.get(STORE_KEY, []); }

function saveThread(thread) {
  const done = thread.turns.filter((t) => t.status === 'done' || t.status === 'stopped');
  if (!done.length) return;
  const slim = {
    id: thread.id,
    created: thread.created,
    updated: Date.now(),
    turns: done.map((t) => ({
      id: t.id, q: t.q, answer: t.answer, status: t.status, note: t.note || '',
      trace: t.trace.filter((s) => s.state !== 'pending').map((s) => ({ label: s.label, state: s.state })),
      cards: t.cards.map((c) => ({ name: c.name, image: c.image })),
      rules: t.rules,
    })),
  };
  const all = loadThreads().filter((x) => x.id !== thread.id);
  all.unshift(slim);
  store.set(STORE_KEY, all.slice(0, 40));
  store.set(CURRENT_KEY, { id: thread.id, at: Date.now() });
}

// ------------------------------------------------------------------ state

const state = {
  thread: newThread(),
  busy: false,
  abort: null,
  passcode: store.get(CODE_KEY, ''),
};

function newThread() { return { id: uid(), created: Date.now(), turns: [] }; }

// ------------------------------------------------------------------ rules data

let rulesIdx = null;
let rulesPromise = null;
function getRules() {
  if (rulesIdx) return Promise.resolve(rulesIdx);
  if (!rulesPromise) {
    rulesPromise = fetch(CFG.rulesUrl || 'data/rules.json')
      .then((r) => { if (!r.ok) throw new Error(`Rules file answered ${r.status}`); return r.json(); })
      .then((data) => {
        rulesIdx = createRulesIndex(data);
        els.fineprint.innerHTML = `Comprehensive Rules effective ${esc(rulesIdx.effective)} &bull; Card data from Scryfall &bull; Not affiliated with Wizards of the Coast`;
        // Re-render finished rulings so rule numbers become links.
        for (const t of state.thread.turns) if (t.status !== 'pending') renderJudge(t);
        return rulesIdx;
      });
    rulesPromise.catch(() => { rulesPromise = null; });
  }
  return rulesPromise;
}
const ruleExists = (id) => !rulesIdx || rulesIdx.has(id);

// ------------------------------------------------------------------ proxy status

async function checkStatus() {
  const set = (s, text, title = '') => {
    els.status.dataset.state = s;
    $('.status__text', els.status).textContent = text;
    els.status.title = title;
  };
  if (!PROXY) return set('off', 'Off duty', 'The judge is not connected yet. See the README to set up the proxy.');
  try {
    const res = await fetch(`${PROXY}/health`, { cache: 'no-store' });
    const j = await res.json();
    if (j.ok) set('on', 'On duty', `Answering with ${j.model}`);
    else set('down', 'Off duty', j.message || 'The judge is not configured.');
  } catch {
    set('down', 'Unreachable', 'Could not reach the judge. Check your connection.');
  }
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  const turns = state.thread.turns;
  els.app.classList.toggle('is-active', turns.length > 0);
  els.thread.innerHTML = '';
  if (!turns.length) {
    els.thread.append(emptyState());
    return;
  }
  for (const t of turns) {
    els.thread.append(playerEl(t), judgeShell(t));
    renderJudge(t);
  }
}

function emptyState() {
  const sec = document.createElement('section');
  sec.className = 'empty';
  sec.innerHTML = `
    <div class="empty__seal" aria-hidden="true"><svg><use href="#i-gavel"/></svg></div>
    <h2 class="empty__title">The judge awaits your question</h2>
    <p class="empty__lede">Describe what happened at the table. Put card names in double brackets, like ${inline('[[Questing Beast]]', { rules: false })}, and the judge reads their current Oracle text and rulings before ruling.</p>
    <div class="prompts">${SUGGESTIONS.map((s) => `<button type="button" class="prompt">${esc(s)}</button>`).join('')}</div>`;
  sec.querySelectorAll('.prompt').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
  return sec;
}

function playerEl(t) {
  const div = document.createElement('div');
  div.className = 'msg msg--player';
  div.innerHTML = `<div class="bubble">${inline(t.q, { rules: false })}</div><div class="avatar avatar--player" aria-hidden="true"><svg><use href="#i-player"/></svg></div>`;
  return div;
}

function judgeShell(t) {
  const art = document.createElement('article');
  art.className = 'msg msg--judge';
  art.dataset.turn = t.id;
  art.setAttribute('aria-label', "Judge's ruling");
  art.innerHTML = `<div class="avatar avatar--judge" aria-hidden="true"><svg><use href="#i-gavel"/></svg></div><div class="ruling"></div>`;
  return art;
}

function traceHtml(t) {
  if (!t.trace.length) return '';
  const steps = t.trace.map((s) => {
    const icon = s.state === 'done' ? '<svg><use href="#i-check"/></svg>' : s.state === 'failed' ? '<svg><use href="#i-x-small"/></svg>' : '';
    return `<li class="step step--${s.state}"><span class="step__icon" aria-hidden="true">${icon}</span><span>${esc(s.label)}</span></li>`;
  }).join('');
  if (t.status === 'pending') return `<div class="trace"><ol class="steps">${steps}</ol></div>`;
  return `<details class="trace"><summary>${esc(traceSummary(t))}</summary><ol class="steps">${steps}</ol></details>`;
}

function traceSummary(t) {
  const real = t.trace.filter((s) => s.state !== 'note');
  const cards = real.filter((s) => s.kind === 'card' && s.state === 'done').length || t.cards.length;
  const rules = new Set(t.rules).size;
  const searches = real.filter((s) => s.kind === 'search').length;
  const parts = [];
  if (cards) parts.push(plural(cards, 'card'));
  if (rules) parts.push(plural(rules, 'rule'));
  if (!rules && searches) parts.push(plural(searches, 'rules search'));
  return parts.length ? `Checked ${parts.join(' and ')}` : `Showed ${plural(real.length, 'step')}`;
}

function evidenceHtml(t) {
  if (t.status === 'pending') return '';
  const cards = t.cards.slice(0, 6);
  const rules = citedRules(t);
  if (!cards.length && !rules.length) return '';
  const tilt = (i, n) => (n === 1 ? 0 : -6 + (12 * i) / (n - 1));
  const hand = cards.length
    ? `<div class="hand">${cards.map((c, i) => `<button type="button" class="hand__card" data-card="${esc(c.name)}" style="--tilt:${tilt(i, cards.length).toFixed(1)}deg" title="${esc(c.name)}" aria-label="View ${esc(c.name)}">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" decoding="async">` : ''}</button>`).join('')}</div>`
    : '';
  const cited = rules.length
    ? `<div class="cited">${rules.map((id) => {
        const head = rulesIdx ? (id.length === 3 ? rulesIdx.sections[id] : rulesIdx.heading(id)) : '';
        return `<button type="button" class="cite" data-rule="${id}"><b>${id}</b>${head ? `<span>${esc(head)}</span>` : ''}</button>`;
      }).join('')}</div>`
    : '';
  return `<div class="evidence">${hand}${cited}</div>`;
}

function citedRules(t) {
  const fromAnswer = ruleIdsIn(t.answer).filter((id) => ruleExists(id));
  const all = [...new Set([...fromAnswer, ...t.rules])];
  const key = (id) => id.replace(/(\d+)/g, (d) => d.padStart(4, '0'));
  return all.sort((a, b) => key(a).localeCompare(key(b))).slice(0, 10);
}

// Each ruling has fixed slots that are patched in place, so streaming text and new
// lookup steps never redraw (or re-animate) the parts that haven't changed.
function setHtml(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

function patchSteps(ol, t) {
  t.trace.forEach((s, i) => {
    let li = ol.children[i];
    if (!li) { li = document.createElement('li'); ol.append(li); }
    const cls = `step step--${s.state}`;
    if (li.className !== cls) {
      li.className = cls;
      const icon = s.state === 'done' ? '<svg><use href="#i-check"/></svg>' : s.state === 'failed' ? '<svg><use href="#i-x-small"/></svg>' : '';
      li.innerHTML = `<span class="step__icon" aria-hidden="true">${icon}</span><span class="step__label"></span>`;
    }
    const label = li.querySelector('.step__label');
    if (label.textContent !== s.label) label.textContent = s.label;
  });
  while (ol.children.length > t.trace.length) ol.lastElementChild.remove();
}

function renderJudge(t) {
  const art = els.thread.querySelector(`[data-turn="${t.id}"]`);
  if (!art) return;
  const box = $('.ruling', art);
  box.classList.toggle('ruling--error', t.status === 'error' && !['access_code', 'bad_code'].includes(t.error?.code));

  if (t.status === 'error') {
    box.dataset.built = '';
    box.innerHTML = `<div class="ruling__label">Judge's take</div>${traceHtml({ ...t, status: 'done' })}${problemHtml(t)}`;
    wireProblem(box, t);
    return;
  }

  if (box.dataset.built !== '1') {
    box.innerHTML = `<div class="ruling__label">Judge's take</div><div class="ruling__trace"></div><div class="ruling__body prose"></div><div class="ruling__wait"></div><div class="ruling__tail"></div>`;
    box.dataset.built = '1';
  }
  const streaming = t.status === 'pending';
  const traceSlot = $('.ruling__trace', box);
  if (streaming) {
    if (t.trace.length) {
      let ol = $('ol.steps', traceSlot);
      if (!ol || traceSlot.firstElementChild?.tagName === 'DETAILS') {
        traceSlot.innerHTML = '<div class="trace"><ol class="steps"></ol></div>';
        traceSlot._html = null;
        ol = $('ol.steps', traceSlot);
      }
      patchSteps(ol, t);
    }
  } else {
    const open = traceSlot.querySelector('details.trace')?.open;
    setHtml(traceSlot, traceHtml(t));
    if (open) traceSlot.querySelector('details.trace')?.setAttribute('open', '');
  }

  setHtml($('.ruling__body', box), t.answer
    ? renderMarkdown(t.answer, { ruleExists }) + (streaming ? '<span class="caret" aria-hidden="true"></span>' : '')
    : '');
  setHtml($('.ruling__wait', box), streaming && !t.answer
    ? `<div class="thinking"><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>Thinking it through...</div>`
    : '');

  const tail = $('.ruling__tail', box);
  if (streaming) { setHtml(tail, ''); return; }
  const note = t.note ? `<p class="ruling__note">${esc(t.note)}</p>` : '';
  const actions = `<div class="ruling__actions">
      <button type="button" class="action" data-act="copy"><svg><use href="#i-copy"/></svg>Copy</button>
      ${navigator.share ? '<button type="button" class="action" data-act="share"><svg><use href="#i-share"/></svg>Share</button>' : ''}
    </div>`;
  const before = tail._html;
  setHtml(tail, `${note}${evidenceHtml(t)}${actions}`);
  if (tail._html !== before) {
    tail.querySelector('[data-act="copy"]')?.addEventListener('click', () => copyRuling(t));
    tail.querySelector('[data-act="share"]')?.addEventListener('click', () => shareRuling(t));
  }
}

let frame = 0;
const dirty = new Set();
function scheduleRender(t) {
  dirty.add(t);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const stick = nearBottom();
    for (const x of dirty) renderJudge(x);
    dirty.clear();
    if (stick) scrollToEnd();
  });
}

function nearBottom() {
  const el = els.thread;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}
function scrollToEnd(smooth = false) {
  els.thread.scrollTo({ top: els.thread.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

// ------------------------------------------------------------------ errors

const PROBLEMS = {
  not_configured: "The judge isn't connected yet. Whoever runs this site needs to deploy the proxy and add its URL to config.js (the README walks through it). The rulebook in the top bar works in the meantime.",
  access_code: 'This judge is for a private group. Enter the group passcode to continue.',
  bad_code: "That passcode didn't work. Check with whoever shared the link.",
  rate_limited: 'Easy there. Too many questions in the last minute. Give it a moment and ask again.',
  busy: 'The judge is swamped right now (the AI provider is rate limiting). Try again in a minute.',
  config: "The judge's AI key isn't set up correctly. If you run this site, check the Worker's secrets.",
  blocked: "The AI provider declined to answer that one. Try rephrasing the question.",
  network: "Can't reach the judge. Check your connection and try again.",
  cut_off: 'The connection dropped before the ruling finished. Try again.',
  stopped: 'You stopped this ruling before the judge answered.',
};

function problemHtml(t) {
  const e = t.error || {};
  const msg = PROBLEMS[e.code] || 'A magical interference disrupted the ruling. Please try again.';
  const detail = !PROBLEMS[e.code] && e.message ? `<small>${esc(e.message)}</small>` : '';
  if (e.code === 'access_code' || e.code === 'bad_code') {
    return `<div class="problem"><p>${esc(msg)}</p>
      <form class="passcode" data-form="code"><input type="password" name="code" autocomplete="current-password" placeholder="Group passcode" aria-label="Group passcode" required>
      <button class="btn btn--solid" type="submit">Unlock</button></form></div>`;
  }
  const retry = e.code === 'not_configured' ? '' : '<button type="button" class="btn" data-act="retry">Ask again</button>';
  return `<div class="problem"><p>${esc(msg)}</p>${detail}${retry}</div>`;
}

function wireProblem(box, t) {
  box.querySelector('[data-act="retry"]')?.addEventListener('click', () => retry(t));
  const form = box.querySelector('[data-form="code"]');
  if (form) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      state.passcode = form.code.value.trim();
      store.set(CODE_KEY, state.passcode);
      retry(t);
    });
    setTimeout(() => form.code.focus(), 50);
  }
}

function retry(t) {
  if (state.busy) return;
  state.thread.turns = state.thread.turns.filter((x) => x !== t);
  renderAll();
  ask(t.q);
}

class JudgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ------------------------------------------------------------------ asking the judge

function priorConversation(current) {
  const out = [];
  const done = state.thread.turns.filter((t) => t !== current && t.status === 'done' && t.answer);
  for (const t of done.slice(-6)) {
    out.push({ role: 'user', content: t.q });
    out.push({ role: 'assistant', text: t.answer });
  }
  return out;
}

async function streamTurn(messages, signal, onText, onCall) {
  let res;
  try {
    res = await fetch(`${PROXY}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(state.passcode ? { 'X-Access-Code': state.passcode } : {}) },
      body: JSON.stringify({ messages, cr_effective: rulesIdx ? rulesIdx.effective : undefined }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new JudgeError('network', err.message);
  }
  if (!res.ok) {
    let j = {};
    try { j = await res.json(); } catch { /* not JSON */ }
    let code = j.error || `http_${res.status}`;
    if (code === 'access_code' && state.passcode) code = 'bad_code';
    throw new JudgeError(code, j.message || `The judge's desk answered ${res.status}.`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  const calls = [];
  let raw = null;
  let stop = null;
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new JudgeError('cut_off', err.message);
    }
    if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!line.startsWith('data:')) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (evt.type === 'text') { text += evt.text; onText(text); }
      else if (evt.type === 'tool_call') { const c = { id: evt.id, name: evt.name, input: evt.input || {} }; calls.push(c); onCall(c, text); }
      else if (evt.type === 'turn') raw = evt.raw;
      else if (evt.type === 'done') stop = evt.stop;
      else if (evt.type === 'error') throw new JudgeError(evt.code, evt.message);
    }
    if (chunk.done) break;
  }
  if (!stop) throw new JudgeError('cut_off', 'The answer ended early.');
  return { text, calls, raw, stop };
}

function mergeSources(t, out) {
  for (const { card } of out.sources.cards || []) {
    const name = card.name;
    if (t.cards.some((c) => c.name === name)) continue;
    t.cards.push({ name, image: scry.imageUrl(card, 0, 'normal') });
  }
  for (const id of out.sources.rules || []) if (!t.rules.includes(id)) t.rules.push(id);
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q || state.busy) return;
  closeSuggest();
  const t = { id: uid(), q, answer: '', status: 'pending', trace: [], cards: [], rules: [], note: '' };
  state.thread.turns.push(t);
  renderAll();
  scrollToEnd();
  els.input.value = '';
  autosize();

  if (!PROXY) {
    t.status = 'error';
    t.error = { code: 'not_configured' };
    renderJudge(t);
    return;
  }

  setBusy(true);
  const controller = new AbortController();
  state.abort = controller;
  getRules().catch(() => {});

  try {
    const loop = [...priorConversation(t), { role: 'user', content: q }];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await streamTurn(
        loop,
        controller.signal,
        (text) => { t.answer = text; scheduleRender(t); },
        (call, preamble) => {
          // Text the judge wrote before reaching for a tool is a working note, not the ruling.
          if (preamble && preamble.trim() && !t.trace.some((s) => s.state === 'note' && s.label === preamble.trim())) {
            t.trace.push({ label: preamble.trim(), state: 'note' });
          }
          t.answer = '';
          const kind = call.name === 'lookup_card' ? 'card' : call.name === 'search_rules' ? 'search' : 'rule';
          t.trace.push({ id: call.id, kind, label: pendingLabel(call), state: 'pending' });
          scheduleRender(t);
        },
      );
      loop.push({ role: 'assistant', text: result.text, tool_calls: result.calls, raw: result.raw });

      if (result.stop !== 'tool_use' || !result.calls.length) {
        t.answer = result.text;
        if (result.stop === 'max_tokens') t.note = 'The judge ran out of room. Ask "go on" to hear the rest.';
        if (!t.answer.trim()) t.answer = "I couldn't put a ruling together for that one. Could you describe the situation a little differently?";
        break;
      }

      const results = await Promise.all(result.calls.map(async (call) => {
        const out = await runTool(call, getRules);
        const step = t.trace.find((s) => s.id === call.id);
        if (step) { step.state = out.failed ? 'failed' : 'done'; step.label = out.label; }
        mergeSources(t, out);
        scheduleRender(t);
        return { id: call.id, name: call.name, content: out.content, ...(out.is_error ? { is_error: true } : {}) };
      }));
      if (controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      loop.push({ role: 'tool', results });
    }
    t.status = 'done';
    announce('Ruling ready.');
  } catch (err) {
    if (err.name === 'AbortError') {
      if (t.answer.trim()) { t.status = 'stopped'; t.note = 'Stopped early.'; }
      else { t.status = 'error'; t.error = { code: 'stopped' }; }
    } else {
      t.status = 'error';
      t.error = { code: err.code || 'unknown', message: err.message };
    }
  } finally {
    for (const s of t.trace) if (s.state === 'pending') s.state = 'failed';
    state.busy = false;
    state.abort = null;
    setBusy(false);
    renderJudge(t);
    if (nearBottom()) scrollToEnd();
    saveThread(state.thread);
  }
}

function setBusy(busy) {
  state.busy = busy;
  els.send.classList.toggle('is-stop', busy);
  els.send.setAttribute('aria-label', busy ? 'Stop the judge' : 'Ask the judge');
  $('use', els.send).setAttribute('href', busy ? '#i-stop' : '#i-send');
  updateSendState();
}

function updateSendState() {
  els.send.disabled = !state.busy && !els.input.value.trim();
}

function announce(text) {
  els.announcer.textContent = '';
  setTimeout(() => { els.announcer.textContent = text; }, 30);
}

// ------------------------------------------------------------------ copy and share

function rulingText(t) {
  return `Q: ${toPlainText(t.q)}\n\nJudge: ${toPlainText(t.answer)}\n\n(Head Judge Arbiter)`;
}
async function copyRuling(t) {
  try {
    await navigator.clipboard.writeText(rulingText(t));
    toast('Ruling copied');
  } catch {
    toast("Couldn't copy. Select the text instead.");
  }
}
async function shareRuling(t) {
  try { await navigator.share({ title: 'Judge ruling', text: rulingText(t) }); } catch { /* cancelled */ }
}

let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 1800);
}

// ------------------------------------------------------------------ composer

function autosize() {
  const ta = els.input;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  updateSendState();
}

els.input.addEventListener('input', () => { autosize(); onSuggestInput(); });
els.input.addEventListener('keydown', (ev) => {
  if (handleSuggestKeys(ev)) return;
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    if (!state.busy) ask(els.input.value);
  }
});
els.form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (state.busy) { state.abort?.abort(); return; }
  ask(els.input.value);
});

$('#btn-card').addEventListener('click', () => {
  const ta = els.input;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const before = ta.value.slice(0, start);
  const selected = ta.value.slice(start, end);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  ta.value = `${before}${pad}[[${selected}${ta.value.slice(end)}`;
  const caret = before.length + pad.length + 2 + selected.length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  autosize();
  onSuggestInput();
});

// ---- card name suggestions after [[

const sug = { items: [], active: 0, query: '', timer: 0, token: 0 };

function openFragment() {
  const ta = els.input;
  const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
  const m = before.match(/\[\[([^\[\]\n]{0,60})$/);
  return m ? { query: m[1], start: before.length - m[1].length } : null;
}

function onSuggestInput() {
  const frag = openFragment();
  clearTimeout(sug.timer);
  if (!frag) return closeSuggest();
  if (frag.query.trim().length < 2) {
    els.suggest.hidden = false;
    els.suggest.innerHTML = '<div class="suggest__hint">Type a card name...</div>';
    sug.items = [];
    return;
  }
  sug.timer = setTimeout(async () => {
    const token = ++sug.token;
    let names = [];
    try { names = await scry.autocomplete(frag.query); } catch { names = []; }
    if (token !== sug.token || !openFragment()) return;
    sug.items = names.slice(0, 8);
    sug.active = 0;
    sug.query = frag.query;
    drawSuggest();
  }, 140);
}

function drawSuggest() {
  els.suggest.hidden = false;
  if (!sug.items.length) {
    els.suggest.innerHTML = `<div class="suggest__hint">No cards match "${esc(sug.query)}"</div>`;
    return;
  }
  const q = sug.query.trim().toLowerCase();
  els.suggest.innerHTML = sug.items.map((name, i) => {
    const at = name.toLowerCase().indexOf(q);
    const label = at >= 0 ? `${esc(name.slice(0, at))}<mark>${esc(name.slice(at, at + q.length))}</mark>${esc(name.slice(at + q.length))}` : esc(name);
    return `<button type="button" class="suggest__item" role="option" id="sug-${i}" aria-selected="${i === sug.active}" data-i="${i}"><svg aria-hidden="true"><use href="#i-cards"/></svg><span>${label}</span></button>`;
  }).join('');
  els.input.setAttribute('aria-activedescendant', `sug-${sug.active}`);
  els.suggest.querySelectorAll('.suggest__item').forEach((b) => {
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', () => pickSuggestion(Number(b.dataset.i)));
  });
}

function pickSuggestion(i) {
  const name = sug.items[i];
  const frag = openFragment();
  if (!name || !frag) return closeSuggest();
  const ta = els.input;
  const caret = ta.selectionStart ?? ta.value.length;
  let after = ta.value.slice(caret);
  if (after.startsWith(']]')) after = after.slice(2);
  const insert = `${name}]] `;
  ta.value = ta.value.slice(0, frag.start) + insert + after.replace(/^\s+/, '');
  const pos = frag.start + insert.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  closeSuggest();
  autosize();
}

function closeSuggest() {
  els.suggest.hidden = true;
  els.suggest.innerHTML = '';
  sug.items = [];
  els.input.removeAttribute('aria-activedescendant');
}

function handleSuggestKeys(ev) {
  if (els.suggest.hidden) return false;
  if (ev.key === 'Escape') { closeSuggest(); ev.preventDefault(); return true; }
  if (!sug.items.length) return false;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    sug.active = (sug.active + (ev.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
    drawSuggest();
    ev.preventDefault();
    return true;
  }
  if (ev.key === 'Enter' || ev.key === 'Tab') {
    pickSuggestion(sug.active);
    ev.preventDefault();
    return true;
  }
  return false;
}

els.input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== els.input) closeSuggest(); }, 150));

// ------------------------------------------------------------------ sheet: rulebook, cards, history

const sheet = { stack: [], lastFocus: null };

function openSheet(view, arg, { push = false } = {}) {
  if (els.sheet.hidden) {
    sheet.lastFocus = document.activeElement;
    els.sheet.hidden = false;
    els.scrim.hidden = false;
    sheet.stack = [];
  }
  if (push || !sheet.stack.length) sheet.stack.push({ view, arg });
  else sheet.stack[sheet.stack.length - 1] = { view, arg };
  drawSheet();
}

function drawSheet() {
  const top = sheet.stack[sheet.stack.length - 1];
  els.sheetBack.hidden = sheet.stack.length < 2;
  els.sheetBody.scrollTop = 0;
  if (top.view === 'rules') drawRulebook(top.arg || {});
  else if (top.view === 'card') drawCard(top.arg);
  else if (top.view === 'history') drawHistory();
}

function closeSheet() {
  els.sheet.hidden = true;
  els.scrim.hidden = true;
  sheet.stack = [];
  sheet.lastFocus?.focus?.();
}

els.scrim.addEventListener('click', closeSheet);
$('#sheet-close').addEventListener('click', closeSheet);
els.sheetBack.addEventListener('click', () => { sheet.stack.pop(); drawSheet(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !els.sheet.hidden) closeSheet(); });

$('#btn-rulebook').addEventListener('click', () => openSheet('rules', {}));
$('#btn-history').addEventListener('click', () => openSheet('history'));
$('#btn-new').addEventListener('click', () => {
  if (state.busy) state.abort?.abort();
  saveThread(state.thread);
  state.thread = newThread();
  store.remove(CURRENT_KEY);
  renderAll();
  els.input.focus();
});

// ---- rulebook

async function drawRulebook(arg) {
  els.sheetTitle.textContent = 'Rulebook';
  if (!rulesIdx) els.sheetBody.innerHTML = '<p class="loading">Opening the rulebook...</p>';
  let idx;
  try { idx = await getRules(); } catch (err) {
    els.sheetBody.innerHTML = `<p class="muted">The rulebook didn't load (${esc(err.message)}). Check your connection and try again.</p>`;
    return;
  }
  const top = sheet.stack[sheet.stack.length - 1];
  if (!top || top.view !== 'rules') return;

  if (arg.rule) return drawRule(idx, arg.rule);
  if (arg.term) return drawTerm(idx, arg.term);

  els.sheetBody.innerHTML = `
    <div class="search">
      <label class="search__field"><svg aria-hidden="true"><use href="#i-search"/></svg>
        <input type="search" id="rule-q" placeholder="Search the rules or enter a number" value="${esc(arg.q || '')}" aria-label="Search the rules"></label>
      <p class="search__meta">Comprehensive Rules effective ${esc(idx.effective)}</p>
    </div>
    <div id="rule-results"></div>
    <div class="sheet__foot">
      <p>Head Judge Arbiter is unofficial Fan Content permitted under the Fan Content Policy. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. &copy; Wizards of the Coast LLC.</p>
      <p>Card data and images courtesy of Scryfall.</p>
    </div>`;
  const input = $('#rule-q');
  const results = $('#rule-results');
  const show = () => {
    const q = input.value.trim();
    top.arg = { q };
    if (!q) { results.innerHTML = tocHtml(idx); return; }
    const direct = q.match(/^(?:rule\s*)?(\d{3}(?:\.\d+[a-z]?)?)\.?$/i);
    if (direct && idx.has(direct[1])) {
      results.innerHTML = `<button type="button" class="result" data-rule="${direct[1]}"><b>${direct[1]}</b>Open this rule</button>`;
    } else {
      const hits = idx.search(q, 30);
      results.innerHTML = hits.length ? hits.map((h) => resultHtml(idx, h)).join('') : `<p class="muted">Nothing matched "${esc(q)}". Try a keyword or game term.</p>`;
    }
  };
  input.addEventListener('input', debounce(show, 120));
  show();
  if (matchMedia('(hover: hover)').matches) input.focus();
}

function tocHtml(idx) {
  const tops = Object.keys(idx.sections).filter((k) => k.length === 1);
  return `<div class="toc">${tops.map((k) => {
    const subs = Object.keys(idx.sections).filter((s) => s.length === 3 && s[0] === k);
    return `<details><summary>${k}. ${esc(idx.sections[k])}</summary><ul>${subs.map((s) => `<li><button type="button" data-rule="${s}"><b>${s}</b>${esc(idx.sections[s])}</button></li>`).join('')}</ul></details>`;
  }).join('')}</div>`;
}

function resultHtml(idx, h) {
  if (h.kind === 'glossary') {
    const g = idx.lookupGlossary(h.id);
    return `<button type="button" class="result" data-term="${esc(g.term)}"><span class="result__gloss">Glossary</span>${esc(g.term)}<small>${esc(clip(g.def, 140))}</small></button>`;
  }
  const r = idx.get(h.id);
  return `<button type="button" class="result" data-rule="${h.id}"><b>${h.id}</b>${esc(idx.heading(h.id))}<small>${esc(clip(r.text, 150))}</small></button>`;
}

function drawRule(idx, id) {
  els.sheetTitle.textContent = `Rule ${id}`;
  const sec = idx.sectionOf(id);
  const crumb = `<button type="button" class="crumb" data-rule="${sec}">${sec}. ${esc(idx.sections[sec] || '')}</button>`;
  if (id.length === 3) {
    const kids = idx.children(id);
    els.sheetBody.innerHTML = `${crumb}<h3 class="rule-head">${id}. ${esc(idx.sections[id] || '')}</h3>${kids.map((k) => {
      const r = idx.get(k);
      return `<button type="button" class="result" data-rule="${k}"><b>${k}</b>${esc(clip(r.text, 160))}</button>`;
    }).join('')}`;
    return;
  }
  const baseId = idx.parentOf(id);
  const base = idx.get(baseId);
  if (!base) { els.sheetBody.innerHTML = `${crumb}<p class="muted">Rule ${esc(id)} isn't in the current rules.</p>`; return; }
  // "702.2 Deathtouch" is a title, already shown as the heading, so it isn't repeated as a row.
  const isTitle = base.text.length < 60 && !/[.:]$/.test(base.text) && idx.children(baseId).length > 0;
  const rows = [...(isTitle ? [] : [base]), ...idx.children(baseId).map((k) => idx.get(k))];
  const order = idx.order.filter((k) => /^\d{3}\.\d+$/.test(k));
  const at = order.indexOf(baseId);
  const prev = order[at - 1];
  const next = order[at + 1];
  const head = idx.heading(id);
  els.sheetBody.innerHTML = `${crumb}${head && head !== idx.sections[sec] ? `<h3 class="rule-head">${esc(baseId)} ${esc(head)}</h3>` : ''}
    ${rows.map((r) => `<div class="rule${r.id === id ? ' is-current' : ''}" id="r-${r.id.replace('.', '-')}"><b>${r.id}</b> ${inline(r.text, { ruleExists })}${r.examples.map((ex) => `<div class="rule__ex">Example: ${inline(ex, { ruleExists })}</div>`).join('')}</div>`).join('')}
    <div class="rule-nav">
      ${prev ? `<button type="button" class="btn" data-rule="${prev}" data-replace="1"><svg><use href="#i-back"/></svg>${prev}</button>` : '<span></span>'}
      ${next ? `<button type="button" class="btn" data-rule="${next}" data-replace="1">${next}<svg style="transform:scaleX(-1)"><use href="#i-back"/></svg></button>` : ''}
    </div>`;
  const cur = els.sheetBody.querySelector('.rule.is-current');
  if (cur && id !== baseId) requestAnimationFrame(() => cur.scrollIntoView({ block: 'center' }));
}

function drawTerm(idx, term) {
  const g = idx.lookupGlossary(term);
  els.sheetTitle.textContent = 'Glossary';
  els.sheetBody.innerHTML = g
    ? `<h3 class="rule-head">${esc(g.term)}</h3><div class="rule gloss-def">${inline(g.def, { ruleExists })}</div>`
    : `<p class="muted">No glossary entry for ${esc(term)}.</p>`;
}

// ---- card view

async function drawCard(name) {
  els.sheetTitle.textContent = name;
  els.sheetBody.innerHTML = '<p class="loading">Fetching the card...</p>';
  let card, rulings;
  try {
    card = await scry.namedCard(name);
    rulings = await scry.rulings(card).catch(() => []);
  } catch (err) {
    els.sheetBody.innerHTML = `<p class="muted">${err.status === 404 ? `No card found named ${esc(name)}.` : `Couldn't reach Scryfall (${esc(err.message)}).`}</p>`;
    return;
  }
  const top = sheet.stack[sheet.stack.length - 1];
  if (!top || top.view !== 'card' || top.arg !== name) return;
  els.sheetTitle.textContent = card.name;
  const faces = card.card_faces && !card.oracle_text ? card.card_faces : [card];
  const flip = scry.hasBackFace(card);
  els.sheetBody.innerHTML = `
    <div class="cardview">
      <div class="cardview__img"><img src="${esc(scry.imageUrl(card, 0, 'large'))}" alt="${esc(card.name)}" data-face="0">
        ${flip ? '<button type="button" class="icon-btn cardview__flip" aria-label="Flip card"><svg><use href="#i-flip"/></svg></button>' : ''}</div>
      ${faces.map((f) => `<div class="cardview__face">
        <h3 class="cardview__name" style="margin:0">${esc(f.name)} ${symbols(f.mana_cost || '')}</h3>
        <p class="cardview__type">${esc(f.type_line || '')}</p>
        <div class="cardview__oracle">${(f.oracle_text || '').split('\n').map((p) => `<p>${symbols(p)}</p>`).join('')}</div>
        ${f.power !== undefined ? `<p class="cardview__pt">${esc(f.power)}/${esc(f.toughness)}</p>` : ''}
        ${f.loyalty !== undefined ? `<p class="cardview__pt">Loyalty ${esc(f.loyalty)}</p>` : ''}
        ${f.defense !== undefined ? `<p class="cardview__pt">Defense ${esc(f.defense)}</p>` : ''}
      </div>`).join('')}
      <h3>Official rulings</h3>
      ${rulings.length ? `<ul class="rulings">${rulings.map((r) => `<li><time>${esc(r.published_at)}</time>${symbols(r.comment)}</li>`).join('')}</ul>` : '<p class="muted">No rulings published for this card.</p>'}
      ${card.scryfall_uri ? `<a class="cardview__link" href="${esc(card.scryfall_uri)}" target="_blank" rel="noopener noreferrer">View on Scryfall <svg aria-hidden="true"><use href="#i-external"/></svg></a>` : ''}
    </div>`;
  const btn = $('.cardview__flip', els.sheetBody);
  if (btn) {
    btn.addEventListener('click', () => {
      const img = $('.cardview__img img', els.sheetBody);
      const face = img.dataset.face === '0' ? 1 : 0;
      img.dataset.face = String(face);
      img.src = scry.imageUrl(card, face, 'large');
    });
  }
}

function symbols(text) {
  return esc(text).replace(/\{([^}]{1,8})\}/g, (m, s) => {
    const file = s.replace(/\//g, '').toUpperCase();
    return `<img class="sym" src="${esc(scry.symbolBase())}/${encodeURIComponent(file)}.svg" alt="${esc(m)}" title="${esc(m)}">`;
  });
}

// ---- history

function drawHistory() {
  els.sheetTitle.textContent = 'Past rulings';
  const all = loadThreads();
  if (!all.length) {
    els.sheetBody.innerHTML = '<p class="muted">Rulings you ask for are saved on this device and show up here.</p>';
    return;
  }
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  els.sheetBody.innerHTML = `${all.map((th) => `<button type="button" class="past${th.id === state.thread.id ? ' is-current' : ''}" data-thread="${th.id}">${esc(clip(toPlainText(th.turns[0]?.q || 'Ruling'), 110))}<time>${fmt.format(new Date(th.updated))}${th.turns.length > 1 ? ` &bull; ${th.turns.length} questions` : ''}</time></button>`).join('')}
    <div class="sheet__foot"><button type="button" class="btn" id="clear-history">Clear past rulings</button></div>`;
  $('#clear-history').addEventListener('click', () => {
    if (!confirm('Delete all saved rulings on this device?')) return;
    store.remove(STORE_KEY);
    store.remove(CURRENT_KEY);
    drawHistory();
  });
}

function openThread(id) {
  const th = loadThreads().find((x) => x.id === id);
  if (!th) return;
  if (state.busy) state.abort?.abort();
  state.thread = { id: th.id, created: th.created, turns: th.turns.map((t) => ({ ...t, trace: t.trace || [], cards: t.cards || [], rules: t.rules || [] })) };
  store.set(CURRENT_KEY, { id: th.id, at: Date.now() });
  closeSheet();
  renderAll();
  scrollToEnd();
}

// ------------------------------------------------------------------ global clicks and card previews

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-card], [data-rule], [data-term], [data-thread]');
  if (!el) return;
  if (el.tagName === 'A') ev.preventDefault();
  if (el.closest('.empty__lede')) return;
  const inSheet = !els.sheet.hidden && els.sheet.contains(el);
  if (el.dataset.thread) return openThread(el.dataset.thread);
  hidePeek();
  if (el.dataset.card) return openSheet('card', el.dataset.card, { push: inSheet });
  if (el.dataset.term) return openSheet('rules', { term: el.dataset.term }, { push: inSheet });
  if (el.dataset.rule) return openSheet('rules', { rule: el.dataset.rule }, { push: inSheet && !el.dataset.replace });
});

let peekTimer = 0;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
document.addEventListener('pointerover', (ev) => {
  if (!finePointer.matches) return;
  const el = ev.target.closest('.card-ref');
  if (!el || el.closest('.empty__lede')) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    const img = $('img', els.peek);
    img.src = scry.namedImageUrl(el.dataset.card);
    const r = el.getBoundingClientRect();
    const w = 220, h = (w * 680) / 488;
    let x = r.left;
    let y = r.top - h - 10;
    if (y < 8) y = r.bottom + 10;
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    els.peek.style.left = `${x}px`;
    els.peek.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
    els.peek.classList.add('is-visible');
  }, 180);
});
document.addEventListener('pointerout', (ev) => {
  if (ev.target.closest && ev.target.closest('.card-ref')) hidePeek();
});
function hidePeek() { clearTimeout(peekTimer); els.peek.classList.remove('is-visible'); }

// ------------------------------------------------------------------ helpers

function clip(s, n) { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1).trimEnd() + '...' : s; }
function debounce(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ------------------------------------------------------------------ start

function restore() {
  const cur = store.get(CURRENT_KEY, null);
  if (!cur || Date.now() - cur.at > 6 * 60 * 60 * 1000) return;
  const th = loadThreads().find((x) => x.id === cur.id);
  if (th) state.thread = { id: th.id, created: th.created, turns: th.turns.map((t) => ({ ...t, trace: t.trace || [], cards: t.cards || [], rules: t.rules || [] })) };
}

const narrow = matchMedia('(max-width: 600px)');
const setPlaceholder = () => {
  els.input.placeholder = narrow.matches ? 'Ask a rules question' : 'Ask a rules question. Type [[ to name a card.';
  autosize();
};
narrow.addEventListener?.('change', setPlaceholder);

restore();
renderAll();
if (state.thread.turns.length) scrollToEnd();
checkStatus();
setPlaceholder();
(window.requestIdleCallback || ((f) => setTimeout(f, 400)))(() => getRules().catch(() => {}));
if (matchMedia('(hover: hover)').matches) els.input.focus();

// Exposed for local testing only.
window.__hja = { state, ask, getRules };
