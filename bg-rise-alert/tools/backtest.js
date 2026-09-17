#!/usr/bin/env node
'use strict';

/**
 * Replay the detector over your Nightscout history to see how often it would
 * have fired, and at what BG. Use it to tune RISE_PER_5MIN / COOLDOWN_MINS
 * before letting it text you for real.
 *
 *   node tools/backtest.js [days] [--verbose]
 */

const config = require('../src/config');
const detect = require('../src/detect');
const state = require('../src/state');
const units = require('../src/units');
const nightscoutClient = require('../src/nightscout');

async function main () {
  const days = Number(process.argv[2]) || 3;
  const verbose = process.argv.includes('--verbose');

  const cfg = config.load(process.env);
  const ns = nightscoutClient(cfg);
  const displayUnits = cfg.units === 'auto' ? await ns.fetchUnits() : cfg.units;
  const thresholds = config.thresholds(cfg, displayUnits);

  // ~1 reading every 2.5 min at the fastest; overshoot so we never run short.
  const count = Math.min(20000, Math.ceil(days * 24 * 60 / 2.5) + 100);
  process.stdout.write('fetching ~' + days + ' days of entries...\n');
  const raw = await ns.fetchEntries(count);
  const entries = detect.cleanEntries(raw);
  const treatments = cfg.insulinLookbackMins > 0 ? await ns.fetchTreatments(500) : [];

  if (entries.length === 0) {
    console.error('no entries returned');
    return 1;
  }

  const first = entries[0].mills;
  const last = entries[entries.length - 1].mills;
  const spanDays = (last - first) / 86400000;

  console.log('replaying ' + entries.length + ' readings over ' + spanDays.toFixed(1) + ' days'
    + ' (' + new Date(first).toISOString().slice(0, 16) + ' -> ' + new Date(last).toISOString().slice(0, 16) + ')');
  console.log('thresholds: rising ' + thresholds.risePer5Min + ', rapid ' + thresholds.rapidPer5Min
    + ' ' + units.label(displayUnits) + '/5min | cooldown ' + cfg.cooldownMins + ' min | min R2 ' + cfg.minR2 + '\n');

  const replayState = { lastAlert: null, lastRun: null };
  const alerts = [];
  const guards = {};

  // Step through history as if the poller had run at each reading.
  for (let i = 0; i < entries.length; i++) {
    const now = entries[i].mills;
    const window = entries.slice(Math.max(0, i - 40), i + 1);

    const result = detect.analyze({
      entries: window, treatments, now, cfg, thresholds, units: displayUnits
    });

    if (result.guard) guards[result.guard] = (guards[result.guard] || 0) + 1;

    const decision = state.shouldSend(result, replayState, cfg, now);
    if (decision.send) {
      state.recordAlert(replayState, result, now);
      alerts.push({ at: now, level: result.level, mgdl: result.stats.latestMgdl, rate: result.stats.ratePerMin });
    }
  }

  const perDay = spanDays > 0 ? alerts.length / spanDays : alerts.length;
  console.log('alerts: ' + alerts.length + ' (' + perDay.toFixed(1) + ' per day)');
  console.log('  rising: ' + alerts.filter(a => a.level === 'rising').length
    + ' | rapid: ' + alerts.filter(a => a.level === 'rapid').length);
  if (Object.keys(guards).length) {
    console.log('  suppressed by guards: ' + Object.entries(guards).map(([k, v]) => k + ' x' + v).join(', '));
  }

  const byHour = {};
  for (const alert of alerts) {
    const hour = new Date(alert.at).getHours();
    byHour[hour] = (byHour[hour] || 0) + 1;
  }
  const busiest = Object.entries(byHour).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (busiest.length) {
    console.log('  busiest hours (local): ' + busiest.map(([h, c]) => h + ':00 x' + c).join(', '));
  }

  if (verbose) {
    console.log('\nalert log:');
    for (const alert of alerts) {
      console.log('  ' + new Date(alert.at).toISOString().slice(0, 16).replace('T', ' ')
        + '  ' + alert.level.padEnd(6)
        + '  ' + units.format(alert.mgdl, displayUnits) + ' ' + units.label(displayUnits)
        + '  ' + units.format(alert.rate * 5, displayUnits, true) + '/5min');
    }
  }

  return 0;
}

main().then(code => process.exit(code || 0)).catch(err => {
  console.error('backtest failed: ' + (err && err.stack || err));
  process.exit(1);
});
