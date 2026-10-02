// Runs the judge's tool calls in the browser: card lookups go to Scryfall, rules come
// from the local copy of the Comprehensive Rules.
import * as scry from './scryfall.js';

const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '...' : s);

// Label shown while a tool runs.
export function pendingLabel(call) {
  const i = call.input || {};
  switch (call.name) {
    case 'lookup_card': return `Reading Oracle text for ${i.name || 'a card'}`;
    case 'search_cards': return `Searching cards: ${trim(String(i.query || ''), 60)}`;
    case 'search_rules': return `Searching the rules for "${trim(String(i.query || ''), 60)}"`;
    case 'get_rules': return `Opening rule ${(i.rules || []).slice(0, 4).join(', ')}`;
    default: return `Running ${call.name}`;
  }
}

export async function runTool(call, getRules) {
  const input = call.input || {};
  try {
    switch (call.name) {
      case 'lookup_card': {
        const name = String(input.name || '').trim();
        if (!name) return fail('No card name given.', 'Skipped a card lookup with no name');
        let card;
        try {
          card = await scry.namedCard(name);
        } catch (err) {
          if (err.status === 404) {
            const guesses = await scry.autocomplete(name).catch(() => []);
            const hint = guesses.length ? ` Close matches: ${guesses.slice(0, 6).join(', ')}.` : '';
            return fail(`No card found for "${name}".${err.body && err.body.type === 'ambiguous' ? ' The name matches several cards.' : ''}${hint}`, `Couldn't find a card named ${name}`);
          }
          throw err;
        }
        const r = await scry.rulings(card).catch(() => []);
        return {
          content: scry.cardForModel(card, r),
          label: `Read Oracle text: ${card.name}`,
          sources: { cards: [{ card, rulings: r }], rules: [] },
        };
      }
      case 'search_cards': {
        const q = String(input.query || '').trim();
        if (!q) return fail('Empty search.', 'Skipped an empty card search');
        const { total, cards } = await scry.searchCards(q);
        if (!cards.length) return { content: `No cards matched ${q}.`, label: `Card search found nothing for ${trim(q, 40)}`, sources: { cards: [], rules: [] } };
        const lines = cards.slice(0, 10).map((c) => `${c.name} (${c.type_line})`);
        return {
          content: `${total} cards match ${q}. Top results:\n${lines.join('\n')}\nCall lookup_card for full text.`,
          label: `Searched cards: ${total} match${total === 1 ? '' : 'es'}`,
          sources: { cards: [], rules: [] },
        };
      }
      case 'search_rules': {
        const q = String(input.query || '').trim();
        const idx = await getRules();
        const { text, hits } = idx.searchText(q, 8);
        return {
          content: text,
          label: `Searched the rules: ${trim(q, 48)}`,
          sources: { cards: [], rules: [], searched: hits.filter((h) => h.kind === 'rule').map((h) => h.id) },
        };
      }
      case 'get_rules': {
        const list = Array.isArray(input.rules) ? input.rules.map(String) : [String(input.rules || '')];
        const idx = await getRules();
        const { text, found } = idx.getRulesText(list);
        const numbered = found.filter((f) => /^\d{3}/.test(f));
        const named = numbered.slice(0, 3).map((id) => {
          const h = id.length > 3 ? idx.heading(id) : idx.sections[id];
          return h ? `${id} (${h})` : id;
        });
        return {
          content: text,
          label: found.length ? `Read rule ${named.join(', ')}${numbered.length > 3 ? ` and ${numbered.length - 3} more` : ''}` : 'Looked for a rule that does not exist',
          sources: { cards: [], rules: numbered },
        };
      }
      default:
        return fail(`Unknown tool ${call.name}.`, `Skipped unknown tool ${call.name}`);
    }
  } catch (err) {
    return fail(`The lookup failed: ${err.message}. Answer from what you have and mention the lookup failed.`, `${pendingLabel(call)} failed`);
  }
}

function fail(content, label) {
  return { content, label, is_error: true, failed: true, sources: { cards: [], rules: [] } };
}
