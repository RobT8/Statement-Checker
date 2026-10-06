const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./remind.js');

const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();

test('the reminder comes due on the chosen day and hour', () => {
  const r = { day: 5, hour: 9, lastImport: 0 };
  assert.equal(R.isDue(r, at(2026, 10, 5, 8)), true, 'still due from September');
  const loadedInSept = { ...r, lastImport: at(2026, 9, 6) };
  assert.equal(R.isDue(loadedInSept, at(2026, 10, 5, 8)), false, 'before 9am on the 5th');
  assert.equal(R.isDue(loadedInSept, at(2026, 10, 5, 9)), true, 'from 9am on the 5th');
});

test('loading a statement clears it, and loading a few days early counts', () => {
  const r = { day: 28, hour: 9 };
  assert.equal(R.isDue({ ...r, lastImport: at(2026, 10, 28, 12) }, at(2026, 10, 29)), false, 'loaded after');
  assert.equal(R.isDue({ ...r, lastImport: at(2026, 10, 24) }, at(2026, 10, 29)), false, 'loaded 4 days early');
  assert.equal(R.isDue({ ...r, lastImport: at(2026, 9, 29) }, at(2026, 10, 29)), true, "last month's load doesn't count");
});

test('"last day" follows the length of the month', () => {
  const r = { day: 'last', hour: 18 };
  assert.equal(R.dueIn(r, 2026, 1).getDate(), 28, 'February');
  assert.equal(R.dueIn(r, 2028, 1).getDate(), 29, 'leap February');
  assert.equal(R.dueIn(r, 2026, 3).getDate(), 30, 'April');
  assert.equal(R.nextDue(r, at(2026, 12, 31, 19)).getMonth(), 0, 'rolls into January');
});

test('snoozing hides the banner until tomorrow', () => {
  const now = at(2026, 10, 5, 10);
  const r = { day: 5, hour: 9, lastImport: 0 };
  const snoozed = { ...r, snoozeUntil: R.snoozeTime(r, now) };
  assert.equal(R.isDue(snoozed, now), false);
  assert.equal(R.isDue(snoozed, at(2026, 10, 6, 9)), true);
});

test('the phone notification fires once per month', () => {
  const now = at(2026, 10, 5, 10);
  const r = { day: 5, hour: 9, lastImport: at(2026, 9, 6) };
  assert.equal(R.shouldNotify(r, now), true);
  assert.equal(R.shouldNotify({ ...r, notified: '2026-10' }, now), false);
  assert.equal(R.shouldNotify({ ...r, notified: '2026-09' }, now), true);
});

test('calendar file repeats monthly with an alarm', () => {
  const ics = R.icsEvent({ day: 'last', hour: 18 }, at(2026, 10, 6));
  assert.match(ics, /DTSTART:20261031T180000/);
  assert.match(ics, /RRULE:FREQ=MONTHLY;BYMONTHDAY=-1/);
  assert.match(ics, /BEGIN:VALARM/);
  assert.match(R.icsEvent({ day: 3, hour: 9 }, at(2026, 10, 6)), /DTSTART:20261103T090000[\s\S]*BYMONTHDAY=3/);
  assert.equal(R.describe({ day: 1, hour: 9 }), 'the 1st of each month at 9am');
  assert.equal(R.describe({ day: 'last', hour: 12 }), 'the last day of each month at midday');
});
