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

| Category up this month | a spending category is at least 50% and £50 above its usual month (needs 3+ months) |

Each alert can be marked **It's fine** (this one alert) or **Never for <payee>**
(stop that check for that payee, e.g. your daily coffee isn't a duplicate).
Both can be undone from the bottom of the Alerts screen.

## Fixing mistakes

Tap any transaction, then **Edit details** to correct its date, description,
amount or direction, or delete it. Edits and deletions stick when the same
statement is loaded again, because the transaction keeps its original identity.

Renaming the **payee** fixes grouping: give "AMZN MKTP" the name "Amazon
Marketplace" to merge it with your other Amazon payments, or rename one payment
to split it out. Renaming all of a payee's payments carries its category rules
and "never flag" choices over, and remembers the alias for future imports.

**Check guessed payees** walks through every payee whose category is only a
learned guess: one tap to confirm, or pick the right one. Every correction
retrains the guesses.

## Categories that learn

Tap any transaction to give it a category, or use **Sort payees** to work
through every uncategorised payee, biggest first. The app learns in three layers:

1. **This payment.** Set the category for one transaction only.
2. **This payee.** "Use for all payments to Tesco, and future ones" (the default).
   Money in and money out are separate, so an Amazon refund isn't counted as Shopping.
3. **Learned guesses.** A small naive Bayes model trains on everything you've
   categorised and suggests categories for payees it hasn't seen, from shared
   words ("TESCO EXPRESS" after you've taught it "TESCO STORES"), bank codes
   ("DD" for direct debits) and payment size. A guess shows with a dashed
   outline and a "?" until you confirm it. If two categories are equally
   likely it makes no guess, rather than a wrong one.

Insights shows spending and income by category, with a monthly average.
Transfers and savings aren't counted as spending. You can add or delete
categories and export everything, with categories, to a CSV spreadsheet.

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

`analyse.js` is the pure parsing and detection engine and `categorise.js` the category learning, shared by the page and
the tests. `app.js` is the UI. `sw.js` caches the app's own files for offline use.
Bump `CACHE` in `sw.js` when you change any file.
