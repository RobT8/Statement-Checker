# Statement Check

A phone app that reads your bank statements and flags anything unusual.
It's an installable web app (PWA): no app store, no build step, no server.
**Statements never leave the device.** A Content-Security-Policy blocks the
page from making any network request, and data is kept in the browser's
local storage.

## What it checks

| Check | Flags when… |
|---|---|
| Duplicate charge | same amount, same merchant, within 2 days (ignores habits like a daily coffee) |
| Bigger than usual here | a payment is 3×+ what you normally spend at that merchant |
| One of your largest payments | far above your normal spending, and not a regular bill |
| New payee, large amount | first payment to someone, and a big one; round sums score higher (common in scams) |
| Regular payment went up | a fixed-price subscription changes price |
| New regular payment | a subscription started recently (free trials that rolled over) |
| Missed income / stopped payment | a regular payment's next due date passed with nothing |
| Bank fee | overdraft, foreign-transaction and other charges |
| Tiny unfamiliar charge | ≤ £2 from an unknown merchant (card testing) |
| Money in from someone new | unexpected credits (mistakes, money-mule scams) |
| Balance doesn't add up | running balance breaks, so a line may be missing or edited |
| Spending spike | a month's spending far above your typical month |

Each alert can be marked "It's fine", and stays hidden after that.

## Formats

CSV (column layout is auto-detected and shown for checking before import,
including split *paid in / paid out* columns, preambles, UK/US dates and
`1.234,56` amounts), OFX/QFX and QIF. PDF isn't supported.

## Putting it on your phone

It has to be served over HTTPS once, so it can install and then work offline:

1. Host this folder anywhere static, e.g. GitHub Pages, Netlify Drop or Cloudflare Pages.
2. Open the URL on your phone.
   - **Android (Chrome):** ⋮ menu → *Add to Home screen* / *Install app*
   - **iPhone (Safari):** Share → *Add to Home Screen*
3. Open it from the home screen. After the first load it works with no connection.

Hosting only serves the app's code. Statements you load are read on the phone and stored there.

## Development

```bash
python3 -m http.server 8000   # then open http://localhost:8000
node --test                   # engine tests (run from this folder)
```

`analyse.js` is the pure parsing and detection engine, shared by the page and
the tests. `app.js` is the UI. `sw.js` caches the app's own files for offline use.
Bump `CACHE` in `sw.js` when you change any file.
