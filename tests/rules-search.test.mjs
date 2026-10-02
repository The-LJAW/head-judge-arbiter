// Checks that rules search surfaces the right rules for common table questions.
import { readFile } from 'node:fs/promises';
import { createRulesIndex } from '../js/rules.js';

const data = JSON.parse(await readFile(new URL('../data/rules.json', import.meta.url), 'utf8'));
const t0 = performance.now();
const idx = createRulesIndex(data);
const buildMs = performance.now() - t0;

const cases = [
  ['deathtouch trample damage assignment', ['702.2c', '702.19b']],
  ['respond to a spell priority after casting', ['117.3c', '117.3b', '601.2i', '117.3d', '405.5']],
  ['planeswalker loyalty ability activate once per turn', ['606.3']],
  ['two replacement effects enters the battlefield order', ['616.1', '616.1a', '616.1b', '616.1c', '616.1d', '616.1e', '616.1f']],
  ['commander tax cast from command zone', ['903.8']],
  ['state-based actions zero toughness', ['704.5f']],
  ['copy of a spell on the stack', ['707.10']],
  ['summoning sickness haste', ['302.6']],
  ['legend rule', ['704.5j']],
  ['ward', ['702.21a', '702.21b']],
];
let pass = 0;
for (const [q, want] of cases) {
  const hits = idx.search(q, 8).map((h) => h.id);
  const ok = want.some((w) => hits.includes(w));
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'MISS'}  ${q}\n      top: ${hits.join(', ')}`);
}
console.log(`\nIndex built in ${buildMs.toFixed(0)} ms. ${pass}/${cases.length} queries found an expected rule in the top 8.`);
console.log('\n--- get_rules sample ---\n' + idx.getRulesText(['702.19c']).text.slice(0, 600));
console.log('\n--- get_rules section ---\n' + idx.getRulesText(['702']).text.slice(0, 300));
console.log('\n--- glossary ---\n' + idx.getRulesText(['Deathtouch', '999.9']).text);
