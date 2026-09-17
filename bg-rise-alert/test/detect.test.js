'use strict';

const test = require('node:test');
const assert = require('node:assert');

const detect = require('../src/detect');
const config = require('../src/config');

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const cfg = config.load({ QUIET_HOURS: '' });
const thresholds = config.thresholds(cfg, 'mgdl');

/** Build readings ending at `now`, one every `stepMins`, rising `perMin` mg/dL. */
function series (startMgdl, perMin, count, stepMins = 5, now = NOW) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const mills = now - i * stepMins * 60000;
    out.push({ mills, sgv: startMgdl + perMin * (count - 1 - i) * stepMins });
  }
  return out;
}

function analyze (entries, extra = {}) {
  return detect.analyze(Object.assign({
    entries, treatments: [], now: NOW, cfg, thresholds, units: 'mgdl'
  }, extra));
}

test('cleanEntries drops error codes, de-dupes and sorts ascending', () => {
  const cleaned = detect.cleanEntries([
    { mills: 300, sgv: 120 }
    , { mills: 100, sgv: 110 }
    , { mills: 200, sgv: 5 }      // sensor error code
    , { mills: 300, sgv: 120 }    // duplicate timestamp
    , { mills: 400, sgv: null }   // unusable
    , null
  ]);

  assert.deepStrictEqual(cleaned.map(e => e.mills), [100, 300]);
});

test('linearRegression recovers a known slope', () => {
  const points = [{ x: -10, y: 100 }, { x: -5, y: 110 }, { x: 0, y: 120 }];
  const fit = detect.linearRegression(points);

  assert.ok(Math.abs(fit.slope - 2) < 1e-9, 'slope should be 2 mg/dL per min');
  assert.ok(fit.r2 > 0.999, 'a perfect line should have R2 of 1');
});

test('linearRegression returns null when every reading shares a timestamp', () => {
  assert.strictEqual(detect.linearRegression([{ x: 0, y: 100 }, { x: 0, y: 120 }]), null);
});

test('flat BG does not alert', () => {
  const result = analyze(series(120, 0, 6));

  assert.strictEqual(result.alert, false);
  assert.strictEqual(result.level, null);
});

test('falling BG does not alert', () => {
  const result = analyze(series(220, -1.5, 6));

  assert.strictEqual(result.alert, false);
  assert.strictEqual(result.level, null);
});

test('a steady rise past the threshold alerts as rising', () => {
  // 2 mg/dL per min == 10 per 5 min, above the 12-per-5-min rise threshold? no:
  // use 2.6 per min == 13 per 5 min, just over the rise threshold.
  const result = analyze(series(140, 2.6, 6));

  assert.strictEqual(result.level, 'rising');
  assert.strictEqual(result.alert, true);
  assert.ok(result.stats.ratePerMin > 2.5);
});

test('a sharp rise alerts as rapid', () => {
  const result = analyze(series(140, 5, 6));

  assert.strictEqual(result.level, 'rapid');
  assert.strictEqual(result.alert, true);
});

test('stale readings never alert', () => {
  const stale = series(140, 5, 6, 5, NOW - 40 * 60000);
  const result = analyze(stale);

  assert.strictEqual(result.alert, false);
  assert.match(result.reason, /stale/);
});

test('scattered readings are not called a trend', () => {
  // Net rise, but zig-zagging enough that R2 falls below the floor.
  const entries = [
    { mills: NOW - 20 * 60000, sgv: 140 }
    , { mills: NOW - 15 * 60000, sgv: 210 }
    , { mills: NOW - 10 * 60000, sgv: 145 }
    , { mills: NOW - 5 * 60000, sgv: 215 }
    , { mills: NOW, sgv: 150 }
  ];
  const result = analyze(entries);

  assert.strictEqual(result.alert, false);
  assert.ok(result.stats.r2 < cfg.minR2);
});

test('too few readings in the window does not alert', () => {
  const result = analyze([{ mills: NOW - 5 * 60000, sgv: 140 }, { mills: NOW, sgv: 200 }]);

  assert.strictEqual(result.alert, false);
  assert.match(result.reason, /not enough readings/);
});

test('a rise while still below MIN_BG is held (recovering from a low)', () => {
  // Ends at 72 mg/dL: climbing hard, but not yet anywhere insulin belongs.
  const result = analyze(series(45, 3, 4, 3));

  assert.strictEqual(result.level, 'rising');
  assert.strictEqual(result.alert, false);
  assert.strictEqual(result.guard, 'below-min-bg');
});

test('a rise that has climbed back above MIN_BG does alert', () => {
  // Same recovery, carried on until BG is high enough to need insulin.
  const result = analyze(series(50, 5, 6));

  assert.strictEqual(result.alert, true);
  assert.ok(result.stats.latestMgdl > 80);
});

test('a recent bolus holds the reminder', () => {
  const result = analyze(series(140, 5, 6), {
    treatments: [{ mills: NOW - 20 * 60000, insulin: 4, eventType: 'Bolus' }]
  });

  assert.strictEqual(result.alert, false);
  assert.strictEqual(result.guard, 'recent-insulin');
  assert.strictEqual(result.bolus.insulin, 4);
});

test('a bolus older than the lookback does not hold the reminder', () => {
  const result = analyze(series(140, 5, 6), {
    treatments: [{ mills: NOW - 200 * 60000, insulin: 4, eventType: 'Bolus' }]
  });

  assert.strictEqual(result.alert, true);
});

test('a bolus smaller than MIN_BOLUS_UNITS does not hold the reminder', () => {
  const result = analyze(series(140, 5, 6), {
    treatments: [{ mills: NOW - 10 * 60000, insulin: 0.1, eventType: 'Correction Bolus' }]
  });

  assert.strictEqual(result.alert, true);
});

test('quiet hours hold the reminder', () => {
  const quietCfg = config.load({ QUIET_HOURS: '00:00-23:59' });
  const result = analyze(series(140, 5, 6), { cfg: quietCfg });

  assert.strictEqual(result.alert, false);
  assert.strictEqual(result.guard, 'quiet-hours');
});

test('ALERT_ABOVE holds a rise that is not heading anywhere high', () => {
  const gated = config.load({ ALERT_ABOVE: '250', PROJECT_MINS: '30' });
  const result = analyze(series(100, 2.6, 6), {
    cfg: gated, thresholds: config.thresholds(gated, 'mgdl')
  });

  assert.strictEqual(result.alert, false);
  assert.strictEqual(result.guard, 'below-alert-above');
});

test('inQuietHours handles a window wrapping past midnight', () => {
  const window = config.parseQuietHours('23:00-06:00');
  // Local-time constructor keeps this deterministic in any timezone.
  const localAt = (h, m = 0) => new Date(2026, 0, 15, h, m).getTime();

  assert.strictEqual(detect.inQuietHours(window, localAt(23, 30)), true);
  assert.strictEqual(detect.inQuietHours(window, localAt(2)), true);
  assert.strictEqual(detect.inQuietHours(window, localAt(5, 59)), true);
  assert.strictEqual(detect.inQuietHours(window, localAt(6)), false);
  assert.strictEqual(detect.inQuietHours(window, localAt(12)), false);
  assert.strictEqual(detect.inQuietHours(window, localAt(22, 59)), false);
});

test('inQuietHours handles a window inside one day', () => {
  const window = config.parseQuietHours('09:00-17:00');
  const localAt = h => new Date(2026, 0, 15, h).getTime();

  assert.strictEqual(detect.inQuietHours(window, localAt(8)), false);
  assert.strictEqual(detect.inQuietHours(window, localAt(12)), true);
  assert.strictEqual(detect.inQuietHours(window, localAt(17)), false);
});

test('no quiet hours configured is never quiet', () => {
  assert.strictEqual(detect.inQuietHours(null, Date.now()), false);
});

test('recentBolus picks the most recent qualifying dose', () => {
  const bolus = detect.recentBolus([
    { mills: NOW - 60 * 60000, insulin: 2 }
    , { mills: NOW - 10 * 60000, insulin: 6 }
    , { mills: NOW - 5 * 60000, insulin: 0.1 }
  ], NOW, cfg);

  assert.strictEqual(bolus.insulin, 6);
});
