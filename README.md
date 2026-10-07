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

## App lock

Statements → **App lock** sets a 6-digit code that's asked for every time the
app opens. The code is more than a gate: it's stretched into an AES-256 key
(PBKDF2-SHA256, 600,000 rounds, random salt, via the browser's Web Crypto) and
everything the app saves is encrypted with it (`lock.js`). Only the encrypted
copy is stored, and a wrong code is detected because decryption fails.

- Obvious codes (000000, 123456…) are refused.
- After 5 wrong codes there's a 30-second wait, doubling each time up to 15
  minutes. The wait survives closing and reopening the app.
- The app locks when you leave it (immediately, or after 1, 5 or 15 minutes),
  and the header's **Lock** button locks it at once. Its contents are hidden
  from the recent-apps preview.
- A forgotten code can't be recovered, since it's the key. "Forgot your
  code?" deletes everything so you can start again. Backups are *not*
  encrypted, so keep them somewhere private.

What it protects against: someone picking up your unlocked phone, or reading
the app's storage. A 6-digit code has a million combinations, so a determined
attacker who copied the encrypted data off the phone could eventually try
them all. The phone's own screen lock and encryption remain the first line.

## Accounts and credit cards

Each statement belongs to an account: current, savings or credit card. A PDF
says which: a sort code and account number mean a bank account, a credit
limit and minimum payment (or a masked card number) mean a card, and the
last 4 digits match it to one you've loaded before. A CSV or OFX gets the
account you used last; the import screen has an **Account** picker either way.

- **Card spending** is always stored as money out (positive card exports are
  turned round), and dated by the **transaction date**, not the posting date.
- **Paying the card off** stays a real payment from the current account and a
  payment in on the card. It isn't netted off.
- Chips at the top of Alerts, Transactions and Insights show **All** or one
  account. The All view of Alerts lists each account's balance and two totals,
  **In accounts** and **Owed on cards**, then alerts grouped by account, with
  category alerts under "Across all accounts".
- Each account is checked on its own, so balance checks, missing income and
  "large for you" compare like with like.
- A card's balance comes from its statement summary ("New balance"); a bank
  account's from the last running balance.

## Monthly reminder

Statements → **Monthly reminder**: pick a day (1st–28th or the last day) and a
time. On that day a banner at the top of the app says it's time to load your
statement, with **Load statement** and **Remind me tomorrow**. It clears
itself once a statement is loaded (loading up to 10 days early counts).

- **Phone notification:** when the app is installed to the home screen, Chrome
  wakes it now and then (Periodic Background Sync, roughly twice a day at most)
  and it shows one notification for the month. Chrome picks the timing, so it
  can arrive some hours after the set time. No server or push service is used.
- **Add to my calendar** downloads a repeating `.ics` event with an alarm, for
  phones that won't show the notification.
- The reminder settings (day, hour, when a statement was last loaded) are kept
  outside the encrypted data so the service worker can read them; they hold no
  statement contents.

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

Load one statement or many at once (long-press a file in the phone's picker
to select several). A batch gets one review screen: each file shows ✅ when
its running balances all add up, ℹ️ when it can't be verified, ⚠️ when some
don't add up and ❌ when it can't be read. Files can be left out or checked
individually, and transactions already loaded, or repeated across
overlapping statements, are skipped.


CSV (column layout is auto-detected and shown for checking before import,
including split *paid in / paid out* columns, preambles, UK/US dates and
`1.234,56` amounts), OFX/QFX, QIF and PDF.

**PDF statements** are read on the device with a bundled copy of pdf.js
(`vendor/pdfjs`, Apache-2.0). A PDF holds only words and their positions, so
`pdfstatement.js` rebuilds the table:

1. Words are grouped into lines by height on the page, and into cells by the gaps between them.
2. The column headings ("Paid out", "Paid in", "Balance"…) are located, and each amount is assigned to the column it sits under.
3. A date starts a new day. Wrapped description lines join whichever amount line they sit closest to, which handles both banks that print the amount on the first line and banks that print it on the last.
4. Year-less dates ("05 Mar") take their year from the statement, counting back across New Year.
5. Where there's a running balance, it settles whether an amount was money in or out, and every line is checked against it. The import screen shows the result ("All 56 running balances add up").

**NatWest** (and RBS, which shares its layout) is specifically handled: the
*Paid In* column comes before *Withdrawn*, narrow headings that wrap ("Paid" /
"In(£)") are stitched back together, the summary box above the table is
ignored, descriptions are a type line plus a detail line ("Card Transaction" /
"4637 03MAR26 C , TESCO STORES 3021 , LONDON GB"), overdrawn balances end in
"OD", and type labels like "Automated Credit" are never treated as the payee.
NatWest's CSV export (Value column, apostrophe-prefixed descriptions) works too.

Scanned or photographed statements have no text and can't be read.
Password-protected PDFs ask for the password, which never leaves the device.
`test-fixtures/` holds generated fake statements in four layouts (one NatWest-style), used by
`pdfstatement.test.js`.

## Putting it on your phone

**Live app: https://robt8.github.io/Statement-Checker/**

It's hosted on GitHub Pages from the `main` branch, so every push to `main`
updates it within a minute or two.

1. Open the link on your phone.
   - **Android (Chrome):** ⋮ menu → *Install app* (or *Add to Home screen*)
   - **iPhone (Safari):** Share → *Add to Home Screen*
2. Open it from the home screen. After the first load it works with no connection.

Hosting only serves the app's code. Statements you load are read on the phone
and stored there. When an update is published, the app picks it up the next
time it's opened online.

## Development

```bash
python3 -m http.server 8000   # then open http://localhost:8000
node --test                   # engine tests (run from this folder)
```

`analyse.js` is the pure parsing and detection engine, `categorise.js` the category learning, `pdfstatement.js` the PDF reader `lock.js` the app lock's encryption, `remind.js` the reminder dates and `accounts.js` accounts and totals, shared by the page and
the tests. `app.js` is the UI. `sw.js` caches the app's own files for offline use.
Bump `CACHE` in `sw.js` when you change any file.
