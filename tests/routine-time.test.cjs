'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calendar, next, once } = require('../src/routine-time.cjs');
const daily = { time: '03:30', timeZone: 'Europe/Athens', days: [0, 1, 2, 3, 4, 5, 6] };

test('routine schedules use local weekdays and handle offset and date boundaries', () => {
  const friday = { time: '09:00', timeZone: 'Europe/Athens', days: [5] };
  assert.equal(new Date(next(Date.parse('2026-10-22T23:30Z'), friday).at).toISOString(), '2026-10-23T06:00:00.000Z');
  assert.equal(new Date(next(Date.parse('2026-10-23T06:00Z'), friday).at).toISOString(), '2026-10-30T07:00:00.000Z');
  const offset = { time: '00:15', timeZone: 'Asia/Kathmandu', days: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(new Date(next(Date.parse('2026-12-31T18:00Z'), offset).at).toISOString(), '2026-12-31T18:30:00.000Z');
});

test('routine spring times are skipped when nonexistent and autumn occurrences cannot run twice', () => {
  assert.equal(new Date(next(Date.parse('2026-03-28T23:00Z'), daily).at).toISOString(), '2026-03-30T00:30:00.000Z');
  const first = next(Date.parse('2026-10-24T22:00Z'), daily);
  assert.equal(new Date(first.at).toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(new Date(next(first.at, daily, first.key).at).toISOString(), '2026-10-26T01:30:00.000Z');
  assert.equal(new Date(next(first.at, daily).at).toISOString(), '2026-10-26T01:30:00.000Z');
});

test('routine schedules reject bad timezones, duplicate weekdays and malformed clock values', () => {
  for (const override of [{ time: '24:00' }, { time: '9:00' }, { timeZone: 'Not/A/Zone' }, { days: [] },
    { days: [1, 1] }, { days: [7] }, { days: ['1'] }]) {
    assert.throws(() => calendar({ ...daily, ...override }), /Choose/);
  }
  assert.throws(() => next(NaN, daily), /clock/);
});

test('one-time routines run at a real local date and time, at the first instant of a repeated hour', () => {
  const at = value => new Date(once({ timeZone: 'Europe/Athens', ...value }).next.at).toISOString();
  assert.equal(at({ date: '2026-10-21', time: '09:00' }), '2026-10-21T06:00:00.000Z');
  assert.equal(at({ date: '2026-10-25', time: '03:30' }), '2026-10-25T00:30:00.000Z', 'the autumn change repeats 03:30; the first one runs');
  assert.equal(once({ date: '2026-10-21', time: '09:00', timeZone: 'UTC' }).next.key, 'once:2026-10-21T09:00@UTC');
  assert.throws(() => once({ date: '2026-03-29', time: '03:30', timeZone: 'Europe/Athens' }), /does not exist on that date/);
  assert.throws(() => once({ date: '2026-02-31', time: '09:00', timeZone: 'UTC' }), /real date/);
  assert.throws(() => once({ date: 'tomorrow', time: '09:00', timeZone: 'UTC' }), /real date/);
  assert.throws(() => once({ date: '2026-10-21', time: '9am', timeZone: 'UTC' }), /HH:MM/);
  assert.throws(() => once({ date: '2026-10-21', time: '09:00', timeZone: 'Mars/Base' }), /valid timezone/);
});
