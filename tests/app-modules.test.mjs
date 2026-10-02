// Unit checks for the browser modules that don't need a DOM.
import assert from 'node:assert/strict';
import { renderMarkdown, inline, ruleIdsIn, cardNamesIn, toPlainText } from '../js/markdown.js';
import { cardForModel } from '../js/scryfall.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };

test('escapes HTML from the model', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **bold** [[<b>]]');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('data-card="&lt;b&gt;"'));
});

test('links rule numbers and sections, not decimals', () => {
  const html = inline('See 702.19b and rule 704, but not 1.5 or 3.14 or 100 life.');
  assert.ok(html.includes('data-rule="702.19b"'));
  assert.ok(html.includes('data-rule="704"'));
  assert.equal((html.match(/data-rule=/g) || []).length, 2);
});

test('respects ruleExists', () => {
  const html = inline('Rules 702.2c and 999.9', { ruleExists: (id) => id !== '999.9' });
  assert.ok(html.includes('data-rule="702.2c"'));
  assert.ok(!html.includes('data-rule="999.9"'));
});

test('lists, quotes and headings render', () => {
  const html = renderMarkdown('### Step\n1. one\n2. two\n\n- a\n- b\n\n> quoted');
  assert.match(html, /<h4>Step<\/h4><ol><li>one<\/li><li>two<\/li><\/ol><ul><li>a<\/li><li>b<\/li><\/ul><blockquote>/);
});

test('helpers', () => {
  assert.deepEqual(cardNamesIn('[[A]] and [[B]] and [[A]]'), ['A', 'B']);
  assert.deepEqual(ruleIdsIn('(702.2c) 702.19b.'), ['702.2c', '702.19b']);
  assert.equal(toPlainText('Cast [[Lightning Bolt]].'), 'Cast Lightning Bolt.');
});

test('double-faced cards send both faces to the judge', () => {
  const txt = cardForModel({
    name: 'Delver of Secrets // Insectile Aberration', layout: 'transform', keywords: ['Flying'], legalities: { legacy: 'legal' },
    card_faces: [
      { name: 'Delver of Secrets', mana_cost: '{U}', type_line: 'Creature', oracle_text: 'Upkeep reveal.', power: '1', toughness: '1' },
      { name: 'Insectile Aberration', type_line: 'Creature', oracle_text: 'Flying', power: '3', toughness: '2' },
    ],
  }, [{ published_at: '2011-09-22', comment: 'A ruling.' }]);
  assert.match(txt, /Face 1:\nDelver of Secrets \{U\}/);
  assert.match(txt, /Face 2:\nInsectile Aberration/);
  assert.match(txt, /3\/2/);
  assert.match(txt, /Official rulings:\n- 2011-09-22: A ruling\./);
});

console.log(`\n${passed} module tests passed.`);
