'use strict';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const units = require('../src/units');
const format = require('../src/format');
const notify = require('../src/notify');

test('thresholds convert display units into mg/dL per minute', () => {
  const cfg = config.load({ RISE_PER_5MIN: '0.5', RAPID_PER_5MIN: '1.0' });
  const mmol = config.thresholds(cfg, 'mmol');

  // 0.5 mmol/L per 5 min == ~9 mg/dL per 5 min == ~1.8 mg/dL per min
  assert.ok(Math.abs(mmol.riseMgdlPerMin - 1.8) < 0.05);
  assert.ok(Math.abs(mmol.rapidMgdlPerMin - 3.6) < 0.05);
});

test('defaults differ per unit but land on the same physical rate', () => {
  const cfg = config.load({});
  const mgdl = config.thresholds(cfg, 'mgdl');
  const mmol = config.thresholds(cfg, 'mmol');

  assert.ok(Math.abs(mgdl.riseMgdlPerMin - mmol.riseMgdlPerMin) < 0.2);
  assert.ok(Math.abs(mgdl.rapidMgdlPerMin - mmol.rapidMgdlPerMin) < 0.2);
});

test('MIN_BG is interpreted in display units', () => {
  const cfg = config.load({ MIN_BG: '5' });

  assert.ok(Math.abs(config.thresholds(cfg, 'mmol').minBgMgdl - 90) < 1);
  assert.strictEqual(config.thresholds(cfg, 'mgdl').minBgMgdl, 5);
});

test('a comma decimal is accepted', () => {
  assert.strictEqual(config.load({ RISE_PER_5MIN: '0,8' }).risePer5Min, 0.8);
});

test('units are normalized from whatever the site reports', () => {
  assert.strictEqual(config.load({ UNITS: 'mmol/L' }).units, 'mmol');
  assert.strictEqual(config.load({ UNITS: 'mg/dl' }).units, 'mgdl');
  assert.strictEqual(config.load({}).units, 'auto');
});

test('quiet hours parse to minutes from midnight', () => {
  assert.deepStrictEqual(config.parseQuietHours('23:00-06:00'), { from: 1380, to: 360 });
  assert.strictEqual(config.parseQuietHours(''), null);
  assert.throws(() => config.parseQuietHours('11pm-6am'), /QUIET_HOURS/);
  assert.throws(() => config.parseQuietHours('25:00-06:00'), /invalid time/);
});

test('bad configuration is rejected at load', () => {
  assert.throws(() => config.load({ NIGHTSCOUT_URL: 'nightscout.example.com' }), /must start with http/);
  assert.throws(() => config.load({ WINDOW_MINS: '2' }), /WINDOW_MINS/);
  assert.throws(() => config.load({ MIN_READINGS: '1' }), /MIN_READINGS/);
  assert.throws(() => config.load({ FAST_WINDOW_MINS: '60' }), /FAST_WINDOW_MINS/);
});

test('a trailing slash on the Nightscout URL is trimmed', () => {
  assert.strictEqual(config.load({ NIGHTSCOUT_URL: 'https://ns.example.com/' }).nightscoutUrl,
    'https://ns.example.com');
});

test('unit conversion round-trips', () => {
  assert.strictEqual(units.format(218, 'mmol'), '12.1');
  assert.strictEqual(units.format(218, 'mgdl'), '218');
  assert.strictEqual(units.format(18, 'mmol', true), '+1.0');
  assert.ok(Math.abs(units.toMgdl(1, 'mmol') - 18.02) < 0.01);
});

test('the alert reads as a usable SMS in both units', () => {
  const result = {
    level: 'rapid', alert: true, reason: 'rising rapidly'
    , stats: {
      latestMgdl: 216, latestMills: Date.UTC(2026, 0, 15, 12), ageMins: 1
      , ratePerMin: 3.6, changeMgdl: 72, r2: 0.95, n: 6, spanMins: 20, windowMins: 20
    }
  };

  const mmol = format.formatAlert(result, { units: 'mmol', nightscoutUrl: 'https://ns.example.com' });
  assert.match(mmol.sms, /rising FAST/);
  assert.match(mmol.sms, /12\.0 mmol\/L/);
  assert.match(mmol.sms, /\+1\.0 per 5 min/);
  assert.strictEqual(mmol.segments.segments, 1, 'should bill as a single SMS segment');
  assert.strictEqual(mmol.segments.encoding, 'GSM-7');

  const mgdl = format.formatAlert(result, { units: 'mgdl', nightscoutUrl: 'https://ns.example.com' });
  assert.match(mgdl.sms, /216 mg\/dL/);
  assert.match(mgdl.sms, /\+18 per 5 min/);
});

test('a plain rise is worded less urgently than a rapid one', () => {
  const stats = {
    latestMgdl: 180, latestMills: Date.now(), ageMins: 1
    , ratePerMin: 2.6, changeMgdl: 52, r2: 0.9, n: 5, spanMins: 20, windowMins: 20
  };

  const alert = format.formatAlert({ level: 'rising', alert: true, reason: 'rising', stats }, { units: 'mgdl' });

  assert.match(alert.title, /^BG rising — take insulin\?$/);
  assert.doesNotMatch(alert.title, /fast/);
});

test('notifiers report missing credentials instead of failing silently', () => {
  const built = notify.build(config.load({ NOTIFIER: 'twilio,pushover,webhook,bogus' }), { units: 'mgdl' });

  assert.strictEqual(built.notifiers.length, 0);
  assert.strictEqual(built.problems.length, 4);
  assert.match(built.problems.join(' '), /TWILIO_ACCOUNT_SID/);
  assert.match(built.problems.join(' '), /PUSHOVER_TOKEN/);
  assert.match(built.problems.join(' '), /WEBHOOK_URL/);
  assert.match(built.problems.join(' '), /unknown notifier "bogus"/);
});

test('a fully configured twilio notifier validates', () => {
  const built = notify.build(config.load({
    NOTIFIER: 'twilio'
    , TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'secret'
    , TWILIO_FROM: '+15550001111', TWILIO_TO: '+15550002222'
  }), { units: 'mgdl' });

  assert.deepStrictEqual(built.problems, []);
  assert.deepStrictEqual(built.notifiers.map(n => n.name), ['twilio']);
});

test('one failing notifier does not stop the others', async () => {
  const outcomes = await notify.sendAll([
    { name: 'good', send: async () => ({ delivered: true }) }
    , { name: 'bad', send: async () => { throw new Error('boom'); } }
  ], { sms: 'test' });

  assert.deepStrictEqual(outcomes.map(o => o.ok), [true, false]);
  assert.strictEqual(outcomes[1].error, 'boom');
});

test('.env is parsed without a dependency, and real env vars win', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dotenv = require('../src/dotenv');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-rise-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    '# a comment'
    , ''
    , 'NOTIFIER=twilio'
    , 'export TWILIO_FROM=+61212345678'
    , 'RISE_PER_5MIN=0.9   # trailing comment'
    , 'QUIET_HOURS="23:00-07:00"'
    , "PUSHOVER_SOUND='climb'"
    , 'MALFORMED'
  ].join('\n'));

  const previous = process.env.NOTIFIER;
  process.env.NOTIFIER = 'console'; // already set, must not be overwritten

  try {
    const parsed = dotenv.load(file);

    assert.strictEqual(parsed.TWILIO_FROM, '+61212345678', 'export prefix is stripped');
    assert.strictEqual(parsed.RISE_PER_5MIN, '0.9', 'inline comment is stripped');
    assert.strictEqual(parsed.QUIET_HOURS, '23:00-07:00', 'quotes are stripped');
    assert.strictEqual(parsed.PUSHOVER_SOUND, 'climb');
    assert.ok(!('MALFORMED' in parsed), 'a line with no = is skipped');
    assert.strictEqual(process.env.NOTIFIER, 'console', 'a real env var is not overwritten');
    assert.strictEqual(process.env.TWILIO_FROM, '+61212345678', 'an unset var is filled in');
  } finally {
    if (previous === undefined) delete process.env.NOTIFIER; else process.env.NOTIFIER = previous;
    delete process.env.TWILIO_FROM;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing .env is not an error', () => {
  assert.deepStrictEqual(require('../src/dotenv').load('/nonexistent/path/.env'), {});
});
