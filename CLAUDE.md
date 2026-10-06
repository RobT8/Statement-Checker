# Handover — Statement Check

Read this first. It's the context a new session needs to carry on the work.
`README.md` has the full feature and design write-up.

## What it is

A phone app (an installable PWA) that loads bank statements and flags
anomalies, learns spending categories, and keeps everything on the device.
The owner (RobT8) uses it on an **Android phone in Chrome**, installed to the
home screen, with **NatWest** as their bank. They're in the UK (GBP, DD/MM
dates) and like visual explanations and analogies.

- **Live:** https://robt8.github.io/Statement-Checker/ (GitHub Pages, served
  from `main` at the root; `.nojekyll` is present). A push to `main`
  redeploys in 1–2 minutes, and the installed app updates the next time it's
  opened online.
- **Repo:** `RobT8/Statement-Checker`. Work on `main` unless told otherwise.
  It started inside `robt8/kidrota` and was moved out at the owner's request.
  **Don't add anything to kidrota.**

## Hard rules

1. **Nothing leaves the device.** No servers, accounts, analytics, CDNs or
   network calls. The CSP in `index.html` (`connect-src 'none'`,
   `script-src 'self'`) enforces this, so keep it. Third-party code is
   vendored (pdf.js lives in `vendor/pdfjs`).
2. **No build step.** Plain HTML/CSS/JS files served as-is. Pure logic files
   use a UMD-style footer: `module.exports` under Node, a global in the
   browser (`SC`, `CAT`, `PDFS`, `LOCK`).
3. **Bump `CACHE` in `sw.js`** (currently `statement-check-v7`) whenever any
   file changes, and add new files to its `FILES` list, or installed copies
   keep the old version and break offline.
4. **Escape everything from statements** with `esc()` before it goes into
   HTML. Statement text is untrusted.
5. **Don't use real bank branding** in fixtures or the UI. Test statements
   use "Example Bank" with fake data.

## Files

| File | Role |
|---|---|
| `index.html` | Page shell, all CSS (light/dark tokens on `:root`), CSP, script tags |
| `app.js` | All UI: screens, sheets, import flows, events, storage, app lock UI |
| `analyse.js` (`SC`) | CSV/OFX/QIF parsing, column guessing, `merchantKey` payee grouping, the 11 anomaly rules, `sampleCSV()` |
| `categorise.js` (`CAT`) | Categories: per-transaction > payee rule > naive Bayes guess; `categorySpikes`, `payeesToSort`, `guessesToReview` |
| `pdfstatement.js` (`PDFS`) | Rebuilds statement tables from pdf.js text positions |
| `lock.js` (`LOCK`) | PBKDF2 (600k) → AES-256-GCM encryption for the app lock, weak-code check, lockout timing |
| `sw.js` | Network-first service worker, cache for offline |
| `*.test.js` | `node --test` suites (34 tests, all passing) |
| `test-fixtures/` | Four generated fake PDF statements + expected JSON. `make-fixtures.js` rebuilds them (needs Playwright). |

## Commands

```bash
node --test                                    # all tests (run in repo root)
npx --yes oxlint@1 .                           # lint; one known warning in analyse.js (endsWith)
python3 -m http.server 8000                    # serve locally → http://localhost:8000
NODE_PATH=$(npm root -g) node test-fixtures/make-fixtures.js   # regenerate PDF fixtures
```

Playwright with Chromium is preinstalled in cloud sessions
(`NODE_PATH=$(npm root -g)`). Drive the real app at a 390×844 viewport for UI
checks. Cloud sessions **can't reach `github.io`**, so the live site can't
be checked from here; check the Pages build via GitHub Actions instead.

Gotcha: `pkill -f "http.server 8000"` kills your own shell if that text
appears in the same command. Use a bracket pattern like `"http.server 800[0]"`.

## Data model (browser storage)

- `statement-check.v1`: everything, as plaintext JSON, **only when the app
  lock is off**: `{ imports, txns, dismissed, mutes, aliases, deleted,
  settings, cats: { list, txnCats, payeeCats } }`.
- `statement-check.v1.enc`: `{ v, iv, ct }`, the same object AES-GCM
  encrypted, **when the lock is on**. The plaintext key is then removed.
- `statement-check.v1.lock`: lock metadata `{ salt, iter, timeout, fails, until }` (not secret).
- `statement-check.v1.tab`: the last open tab.

Transaction: `{ id, date 'YYYY-MM-DD', desc, amount (<0 = out), balance|null,
merchant, importId, seq, edited? }`. The `id` is `date|amount|desc#n` and
dedupes overlapping imports. **Never change an id when editing**: edits and
deletions survive re-imports because the id stays the same.

`save()` in `app.js` writes the encrypted copy when the lock is on (queued
through the `saving` promise). Always go through `save()`.

## Decisions already made (don't re-litigate)

- **Payee grouping** (`merchantKey`) is deliberately coarse: strip bank
  prefixes and noise, keep the first 2 words. NatWest type labels
  (*Automated Credit*, *OnLine Transaction*, *Card Transaction*…) must never
  become the payee. Changing it changes how stored transactions group, so add
  a migration if you do.
- **PDF reading:** amounts go to the nearest column heading; wrapped lines
  follow their nearest neighbouring line (the y-gap); year-less dates count
  back from the latest year mentioned; the running balance outranks a column
  guess. The import screen reports "All N balances add up" as the
  confidence signal.
- **Guesses** need ≥ 60% confidence, and conflicting evidence gives no guess.
- **Category alerts** need ≥ 3 months, ≥ 50% *and* ≥ £50 over the median month.
- **App lock:** 6 digits, encryption rather than just a gate. Honest limits
  were explained to the owner: a million combinations, so it's weak against
  offline brute force, and backups/CSV exports are **not** encrypted.

## Status and open threads

Everything requested so far is done and live: anomaly alerts; learning
categories with corrections; category spending alerts; editing, renaming
and merging payees; PDF import (tuned for NatWest); batch import; app lock.

Open / next:

- **Real NatWest PDF not yet seen.** The NatWest support is built from the
  known layout and a fake fixture (`layout-d`). If the owner reports a ⚠️
  ("balances don't add up") or a misread, ask for a screenshot of the import
  review screen with personal details blurred, then add a fixture that
  reproduces it.
- **Offered, not started:** fingerprint unlock (WebAuthn platform
  authenticator, with the code as fallback).
- Ideas not requested yet: encrypting backups with the code; a migration
  path if `merchantKey` changes.

## Working with the owner

- Explain with a small diagram or analogy; keep answers short and visual.
- They test on their phone. After pushing, tell them to **close and reopen
  the app online** to get the update.
- Ask before anything destructive or outward-facing. Force-pushes are
  blocked in these sessions.
