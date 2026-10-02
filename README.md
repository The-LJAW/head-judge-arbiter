# Head Judge Arbiter

A friendly Magic: The Gathering rules judge for the table. Ask a question mid-game and the judge looks up the current Oracle text and official rulings for every card you mention, checks the Comprehensive Rules, and then gives a plain-English ruling with the rule numbers it relied on.

**Live app:** https://the-ljaw.github.io/head-judge-arbiter/

## What it does

- **Rulings grounded in real data.** Before answering, the judge reads each card's current Oracle text and rulings from Scryfall and searches a built-in copy of the Comprehensive Rules (currently effective September 25, 2026). It only cites rule numbers it actually looked up, so it doesn't quote numbers that were renumbered years ago.
- **You can watch it work.** While it thinks you see each lookup ("Reading Oracle text for Questing Beast", "Read rule 702.19 (Trample)"). Afterward it shows the cards it read as a small fanned hand and the rules it cited as chips.
- **Tap anything.** Card names open the full card with rulings (and flip double-faced cards). Rule numbers open the exact rule in the built-in rulebook.
- **Card name autocomplete.** Type `[[` and start a card name.
- **Rulebook.** Browse or search the full Comprehensive Rules and glossary. Works even before the AI is connected.
- **Past rulings** are saved on your device. Copy or share any ruling to Discord or a text thread.
- Built for phones at the table: big tap targets, one-handed composer, installable to the home screen.

## How it's put together

```
Phone / browser (GitHub Pages, free)
  ├─ Rulebook search runs locally (data/rules.json)
  ├─ Card lookups go straight to Scryfall (free, no key)
  └─ Questions go to ──> Cloudflare Worker (free) ──> Gemini or Claude
                          holds the API key, the judge's instructions,
                          rate limits, and the passcode
```

The AI key lives only in the Worker as an encrypted secret. It never appears in this repo or in the browser. The Worker also fixes the judge's instructions on the server, so nobody can repurpose your key as a general chatbot.

## Setup (about 15 minutes, no command line needed)

### 1. Turn on GitHub Pages

In this repo: **Settings > Pages > Build and deployment**, set **Source** to "Deploy from a branch", branch **main**, folder **/ (root)**, and save. The site appears at `https://the-ljaw.github.io/head-judge-arbiter/` a minute later.

### 2. Get a free Gemini API key

Go to [Google AI Studio](https://aistudio.google.com/apikey), sign in, and click **Create API key**. Copy it.

### 3. Create the Cloudflare Worker

1. Sign up or log in at [dash.cloudflare.com](https://dash.cloudflare.com) (the free plan is fine).
2. Go to **Workers & Pages > Create > Create Worker**. Name it `head-judge-arbiter` and click **Deploy**.
3. Click **Edit code**, delete the sample code, paste in the full contents of [`worker/worker.js`](worker/worker.js), and click **Deploy**.
4. Open the Worker's **Settings > Variables and Secrets** and add:

   | Type | Name | Value |
   |---|---|---|
   | Secret | `GEMINI_API_KEY` | the key from step 2 |
   | Text | `ALLOWED_ORIGINS` | `https://the-ljaw.github.io` |
   | Secret (optional) | `ACCESS_CODE` | a passcode for your group, e.g. `cubecommonwealth` |

5. Copy the Worker's URL (it looks like `https://head-judge-arbiter.<your-name>.workers.dev`). Open it in a browser and add `/health` to the end. You should see `"ok": true` and "On duty."

### 4. Connect the app to the Worker

Edit [`config.js`](config.js) right on GitHub (pencil icon) and paste the Worker URL into `proxyUrl`:

```js
proxyUrl: 'https://head-judge-arbiter.your-name.workers.dev',
```

Commit. In a minute the badge at the top of the app turns green and says **On duty**.

### 5. Share it

Post the link in the Cube Commonwealth Discord. If you set an `ACCESS_CODE`, share it in a channel only members can see; people enter it once and their phone remembers it.

## Choosing the AI

| | Gemini 3.8 Flash (default) | Claude Sonnet 5.5 |
|---|---|---|
| Cost | Free tier | About 3 to 8 cents per question |
| Ruling quality | Good | Best on tricky multi-card interactions |
| Limits | Google sets per-project limits (roughly 10 requests a minute on Flash; each question uses 2 to 4) | Effectively none for a friend group |
| Privacy | Google may use free-tier prompts to improve its products | Not used for training |

The free tier is plenty for casual use. On a busy draft night with many people asking at once you may see "The judge is swamped," which means Google's per-minute limit was hit; waiting a minute fixes it. Turning on billing for the same Gemini key removes that limit and costs very little (Gemini 3.8 Flash is $0.75 per million input tokens through 2026).

**To switch to Claude:** create a key at [platform.claude.com](https://platform.claude.com), set a monthly spend limit there (Settings > Limits) as your cost guardrail, then in the Worker add a secret `ANTHROPIC_API_KEY` and a text variable `PROVIDER` = `anthropic`. Optional variables: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) and `ANTHROPIC_EFFORT` (`low`, `medium` default, or `high`; higher is more careful but slower and costs more).

## Guardrails built in

- Only your site can call the Worker (`ALLOWED_ORIGINS`).
- Optional group passcode (`ACCESS_CODE`).
- Per-visitor rate limit, 30 model calls a minute by default (`RATE_LIMIT_PER_MINUTE`).
- Question length, conversation length, and lookup rounds are capped so one person can't run up a bill.
- The judge's instructions and tools are fixed on the server; the browser can't change them.

## Keeping the rules current

Wizards updates the Comprehensive Rules a few times a year. A GitHub Action ([`refresh-rules.yml`](.github/workflows/refresh-rules.yml)) checks every Monday, downloads the newest official rules file, and commits an updated `data/rules.json` only if the rules changed. It refuses to replace the rules with an older edition or a file that doesn't parse correctly. You can also run it by hand from the **Actions** tab ("Refresh Comprehensive Rules" > **Run workflow**).

Card text and rulings are always live from Scryfall, so new sets work the day Scryfall adds them.

## Working on it locally

Requires Node 20 or newer. No packages to install.

```bash
npm test        # rules search quality, rendering, and Worker tests against fake AI servers
npm run dev     # full local preview at http://127.0.0.1:8080 with a fake judge (no keys needed)
npm run rules   # rebuild data/rules.json from the newest official rules
```

Prefer the command line for the Worker? `cd worker`, then `npx wrangler secret put GEMINI_API_KEY` and `npx wrangler deploy`. Settings live in [`worker/wrangler.toml`](worker/wrangler.toml).

## Files

```
index.html, styles.css, config.js   the app shell, look, and settings
js/app.js         chat, streaming, rulebook, card views, history
js/tools.js       runs the judge's lookups (cards and rules)
js/rules.js       Comprehensive Rules search index
js/scryfall.js    Scryfall client (paced to Scryfall's request guidelines)
js/markdown.js    safe formatting for answers, card and rule links
worker/worker.js  the key-holding proxy (Cloudflare Worker, single file)
data/rules.json   parsed Comprehensive Rules and glossary
scripts/          rules builder and share-image source
tests/            automated tests and the local preview server
```

## Fine print

Head Judge Arbiter is unofficial Fan Content permitted under the Fan Content Policy. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. &copy; Wizards of the Coast LLC. Card data and images are provided by [Scryfall](https://scryfall.com). For competitive events, the event's head judge always has the final word.

Fonts: Cinzel and Crimson Pro, both under the SIL Open Font License (see `assets/fonts`).
