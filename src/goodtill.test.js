const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatDateTime } = require('./goodtill');

test('formatDateTime emits 00 at midnight Cyprus local (never 24)', () => {
  // 2026-04-23T21:00:00Z is 2026-04-24T00:00:00 in Europe/Nicosia (UTC+3 DST).
  const midnight = new Date('2026-04-23T21:00:00Z');
  assert.equal(formatDateTime(midnight), '2026-04-24 00:00:00');
});

test('formatDateTime hour component is always 00-23', () => {
  for (let h = 0; h < 24; h += 1) {
    const d = new Date(Date.UTC(2026, 3, 23, h, 0, 0));
    const out = formatDateTime(d);
    const hour = out.slice(11, 13);
    assert.match(hour, /^(0\d|1\d|2[0-3])$/, `hour "${hour}" from ${d.toISOString()} must be 00-23, got "${out}"`);
  }
});

test('formatDateTime returns Cyprus wall-clock, not UTC', () => {
  // Mid-afternoon UTC maps to +3h local during DST.
  const noonUtc = new Date('2026-04-23T12:00:00Z');
  assert.equal(formatDateTime(noonUtc), '2026-04-23 15:00:00');
});
