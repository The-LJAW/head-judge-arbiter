#!/usr/bin/env node
// Builds data/rules.json from the official Magic: The Gathering Comprehensive Rules.
//
// Usage:
//   node scripts/build-rules.mjs              download the newest rules and rebuild
//   node scripts/build-rules.mjs --file X.txt rebuild from a local copy of the TXT file
//
// Where the rules come from, in order:
//   1. Wizards' rules page (https://magic.wizards.com/en/rules), which links the current TXT file
//   2. A community mirror on GitHub that tracks the official file (used only if step 1 fails)
//
// The script refuses to write the file if the parsed result looks wrong, so a bad
// download can never replace good data.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'rules.json');
const RULES_PAGE = 'https://magic.wizards.com/en/rules';
const MIRROR = 'https://raw.githubusercontent.com/nwgarne/mtg-data/main/rules/cr-raw.txt';
const UA = 'HeadJudgeArbiter/1.0 (+https://github.com/The-LJAW/head-judge-arbiter)';

function decode(buf) {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  // Older editions shipped as Windows-1252. Replacement characters mean UTF-8 was the wrong guess.
  if ((utf8.match(/\uFFFD/g) || []).length > 20) return new TextDecoder('windows-1252').decode(bytes);
  return utf8;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return { text: decode(await res.arrayBuffer()), url: res.url || url };
}

async function findOfficialTxtUrl() {
  const { text } = await fetchText(RULES_PAGE);
  const links = [...text.matchAll(/https?:\/\/media\.wizards\.com\/[^"'\s<>]+?\.txt/gi)].map((m) => m[0]);
  if (!links.length) throw new Error('No TXT link found on the Wizards rules page');
  // Prefer the link with the newest date stamp in its name (MagicCompRules 20260925.txt).
  const dated = links.map((u) => ({ u, d: (decodeURIComponent(u).match(/(\d{8})/) || [])[1] || '' }));
  dated.sort((a, b) => b.d.localeCompare(a.d));
  return dated[0].u.replace(/ /g, '%20');
}

async function download() {
  try {
    const url = await findOfficialTxtUrl();
    const { text } = await fetchText(url);
    return { raw: text, source: url };
  } catch (err) {
    console.warn(`Official download failed (${err.message}). Trying the mirror.`);
    const { text } = await fetchText(MIRROR);
    return { raw: text, source: MIRROR };
  }
}

export function parseRules(raw) {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2028/g, '\n');
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));

  const effMatch = text.match(/effective as of ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  const effective = effMatch ? effMatch[1] : 'unknown';

  // The table of contents repeats the section titles, so the real body starts at the
  // second "1. Game Concepts" line. The glossary heading also appears in the contents.
  const starts = lines.reduce((acc, l, i) => (l.trim() === '1. Game Concepts' ? [...acc, i] : acc), []);
  if (!starts.length) throw new Error('Could not find the start of the rules');
  const bodyStart = starts[starts.length - 1];
  let glossStart = -1;
  for (let i = lines.length - 1; i > bodyStart; i--) if (lines[i].trim() === 'Glossary') { glossStart = i; break; }
  let creditsStart = lines.length;
  for (let i = lines.length - 1; i > glossStart; i--) if (lines[i].trim() === 'Credits') { creditsStart = i; break; }
  if (glossStart < 0) throw new Error('Could not find the glossary');

  const sections = {};
  const rules = [];
  let last = null;
  for (let i = bodyStart; i < glossStart; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^(\d)\. (.+)$/))) { sections[m[1]] = m[2]; last = null; continue; }
    if ((m = line.match(/^(\d{3})\. (.+)$/))) { sections[m[1]] = m[2]; last = null; continue; }
    if ((m = line.match(/^(\d{3}\.\d+)\.? (.*)$/))) { last = [m[1], m[2]]; rules.push(last); continue; }
    if ((m = line.match(/^(\d{3}\.\d+[a-z]+)\.? (.*)$/))) { last = [m[1], m[2]]; rules.push(last); continue; }
    if ((m = line.match(/^Example: ?(.*)$/))) {
      if (last) { if (!last[2]) last[2] = []; last[2].push(m[1]); }
      continue;
    }
    // Continuation lines (rare): fold into the previous rule or its last example.
    if (last) {
      if (last[2] && last[2].length) last[2][last[2].length - 1] += '\n' + line;
      else last[1] += '\n' + line;
    }
  }

  const glossary = [];
  let block = [];
  const flush = () => {
    if (block.length >= 2) glossary.push([block[0], block.slice(1).join('\n')]);
    block = [];
  };
  for (let i = glossStart + 1; i < creditsStart; i++) {
    const line = lines[i].trim();
    if (!line) flush();
    else block.push(line);
  }
  flush();

  return { effective, sections, rules, glossary };
}

function validate(parsed) {
  const problems = [];
  const ids = new Set(parsed.rules.map((r) => r[0]));
  if (parsed.rules.length < 2500) problems.push(`only ${parsed.rules.length} rules parsed`);
  if (parsed.glossary.length < 400) problems.push(`only ${parsed.glossary.length} glossary entries parsed`);
  for (const must of ['100.1', '117.3a', '601.2', '704.5a', '702.2b', '702.19b']) {
    if (!ids.has(must)) problems.push(`rule ${must} missing`);
  }
  if (!parsed.sections['702']) problems.push('section 702 missing');
  if (parsed.effective === 'unknown') problems.push('effective date not found');
  if (problems.length) throw new Error('Parsed rules look wrong: ' + problems.join('; '));
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  let raw, source;
  if (fileIdx >= 0) {
    raw = decode(await readFile(args[fileIdx + 1]));
    source = 'local file';
  } else {
    ({ raw, source } = await download());
  }

  const parsed = parseRules(raw);
  validate(parsed);
  const sha256 = createHash('sha256').update(raw).digest('hex');

  try {
    const existing = JSON.parse(await readFile(OUT, 'utf8'));
    if (existing.sha256 === sha256) {
      console.log(`Rules unchanged (effective ${parsed.effective}). Nothing to write.`);
      return;
    }
    const oldDate = Date.parse(existing.effective);
    const newDate = Date.parse(parsed.effective);
    if (!args.includes('--force') && oldDate && newDate && newDate < oldDate) {
      console.log(`Downloaded rules (effective ${parsed.effective}) are older than the current ones (${existing.effective}). Keeping the current rules.`);
      return;
    }
  } catch { /* no existing file yet */ }

  const out = { v: 1, effective: parsed.effective, source, sha256, ...parsed };
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}: ${parsed.rules.length} rules, ${parsed.glossary.length} glossary terms, effective ${parsed.effective}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
