/* Statement Check — monthly "load your statement" reminder.
 * Pure date logic, shared by the page and the service worker.
 * Settings: { day: 1–28 | 'last', hour: 0–23, lastImport: ms|0, snoozeUntil: ms|0, notified: 'YYYY-MM'|'' }
 * Times are the phone's local time. */
(function (root) {
  'use strict';

  // A statement loaded up to this many days before the reminder date counts
  // as that month's, so loading it early doesn't still nag you.
  const EARLY_DAYS = 10;
  const DAY_MS = 86400000;

  function daysIn(year, month) { return new Date(year, month + 1, 0).getDate(); }

  // When the reminder falls in a given month (month is 0-based).
  function dueIn(r, year, month) {
    const last = daysIn(year, month);
    const day = r.day === 'last' ? last : Math.min(Math.max(1, +r.day || 1), last);
    return new Date(year, month, day, +r.hour || 0, 0, 0, 0);
  }

  // The latest reminder time at or before now.
  function lastDue(r, now) {
    const d = new Date(now);
    const here = dueIn(r, d.getFullYear(), d.getMonth());
    return here <= d ? here : dueIn(r, d.getFullYear(), d.getMonth() - 1);
  }

  // The next reminder time after now.
  function nextDue(r, now) {
    const d = new Date(now);
    const here = dueIn(r, d.getFullYear(), d.getMonth());
    return here > d ? here : dueIn(r, d.getFullYear(), d.getMonth() + 1);
  }

  function monthKey(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  }

  // Has a statement been loaded for the reminder that last came due?
  function covered(r, now) {
    return (r.lastImport || 0) >= lastDue(r, now).getTime() - EARLY_DAYS * DAY_MS;
  }

  // Should the in-app banner show right now?
  function isDue(r, now) {
    if (!r || r.day == null) return false;
    if ((r.snoozeUntil || 0) > now) return false;
    return !covered(r, now);
  }

  // Should the phone notification fire (at most once per reminder month)?
  function shouldNotify(r, now) {
    if (!isDue(r, now)) return false;
    return r.notified !== monthKey(lastDue(r, now));
  }

  // 'Tomorrow at the same hour', for the snooze button.
  function snoozeTime(r, now) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, +r.hour || 0).getTime();
  }

  function ordinal(n) {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return n + s;
  }

  function hourLabel(h) {
    h = +h;
    if (h === 0) return 'midnight';
    if (h === 12) return 'midday';
    return (h % 12) + (h < 12 ? 'am' : 'pm');
  }

  function describe(r) {
    return (r.day === 'last' ? 'the last day' : 'the ' + ordinal(+r.day)) + ' of each month at ' + hourLabel(r.hour);
  }

  // A repeating calendar event with an alarm, for phones that won't show
  // the notification. Built locally; nothing is sent anywhere.
  function icsEvent(r, now) {
    const start = nextDue(r, now);
    const p = (n) => String(n).padStart(2, '0');
    const local = (d) => d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + 'T' + p(d.getHours()) + p(d.getMinutes()) + '00';
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const end = new Date(start.getTime() + 15 * 60000);
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Statement Check//Reminder//EN', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:statement-check-reminder-' + stamp + '@statement-check',
      'DTSTAMP:' + stamp,
      'DTSTART:' + local(start),
      'DTEND:' + local(end),
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (r.day === 'last' ? -1 : start.getDate()),
      'SUMMARY:Load your bank statement into Statement Check',
      'DESCRIPTION:Download this month\'s statement from your bank and load it into Statement Check.',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Load your bank statement', 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
  }

  const api = { EARLY_DAYS, dueIn, lastDue, nextDue, monthKey, covered, isDue, shouldNotify, snoozeTime, ordinal, hourLabel, describe, icsEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.REMIND = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
