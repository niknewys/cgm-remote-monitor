#!/usr/bin/env node
'use strict';

require('./dotenv').load();

const config = require('./config');
const detect = require('./detect');
const format = require('./format');
const state = require('./state');
const notify = require('./notify');
const nightscoutClient = require('./nightscout');

const HELP = `
bg-rise-alert — watch Nightscout and remind you to take insulin when BG starts rising.

Usage:
  node src/index.js [options]

Options:
  --once         run a single check and exit (for cron / scheduled runs)
  --dry-run      analyse and print the verdict, never notify
  --test-alert   send a sample alert through the configured notifiers
  --help         show this help

Configuration is read from the environment; see .env.example.
`;

function parseArgs (argv) {
  const args = new Set(argv.slice(2));
  return {
    once: args.has('--once')
    , dryRun: args.has('--dry-run')
    , testAlert: args.has('--test-alert')
    , help: args.has('--help') || args.has('-h')
  };
}

function timestamp () {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log (message) {
  console.log('[' + timestamp() + '] ' + message);
}

/** Enough readings to fill the window even at a fast upload cadence. */
function entryCount (cfg) {
  return Math.max(12, Math.ceil(cfg.windowMins / 2) + 6);
}

async function runCycle (runtime) {
  const { cfg, ns, args } = runtime;

  if (!runtime.units) {
    runtime.units = cfg.units === 'auto' ? await ns.fetchUnits() : cfg.units;
    runtime.thresholds = config.thresholds(cfg, runtime.units);
    log('using ' + runtime.units + ' — alerting at '
      + runtime.thresholds.risePer5Min + '/5min (rising), '
      + runtime.thresholds.rapidPer5Min + '/5min (rapid)');
  }

  const [entries, treatments] = await Promise.all([
    ns.fetchEntries(entryCount(cfg))
    , cfg.insulinLookbackMins > 0 ? ns.fetchTreatments() : Promise.resolve([])
  ]);

  const now = Date.now();
  const result = detect.analyze({
    entries, treatments, now, cfg, thresholds: runtime.thresholds, units: runtime.units
  });

  log(format.formatStatus(result, { units: runtime.units }));

  const current = state.load(cfg.stateFile);
  const decision = state.shouldSend(result, current, cfg, now);

  if (!decision.send) {
    if (result.alert) log('holding alert: ' + decision.reason);
    current.lastRun = now;
    state.save(current, cfg.stateFile);
    return result;
  }

  const alert = format.formatAlert(result, { units: runtime.units, nightscoutUrl: cfg.nightscoutUrl });

  if (args.dryRun) {
    log('DRY RUN — would send (' + decision.reason + '): ' + alert.sms);
    return result;
  }

  const outcomes = await notify.sendAll(runtime.notifiers, alert);
  const delivered = outcomes.filter(o => o.ok);

  for (const failure of outcomes.filter(o => !o.ok)) {
    console.error('[' + timestamp() + '] notifier ' + failure.name + ' failed: ' + failure.error);
  }

  if (delivered.length > 0) {
    log('sent via ' + delivered.map(o => o.name).join(', ') + ' (' + decision.reason + ')');
    // Only start the cooldown once something actually went out, so a failed
    // send does not silently swallow the reminder for the next 45 minutes.
    state.recordAlert(current, result, now);
  } else {
    console.error('[' + timestamp() + '] no notifier accepted the alert — will retry next cycle');
  }

  current.lastRun = now;
  state.save(current, cfg.stateFile);

  return result;
}

async function sendTestAlert (runtime) {
  const { cfg } = runtime;
  runtime.units = cfg.units === 'auto' ? await runtime.ns.fetchUnits() : cfg.units;

  const alert = format.formatAlert({
    level: 'rapid'
    , alert: true
    , reason: 'test'
    , stats: {
      latestMgdl: 200, latestMills: Date.now(), ageMins: 0
      , ratePerMin: 3.2, changeMgdl: 64, r2: 0.95, n: 6, spanMins: 20, windowMins: 20
    }
  }, { units: runtime.units, nightscoutUrl: cfg.nightscoutUrl });

  alert.title = '[TEST] ' + alert.title;
  alert.sms = '[TEST] ' + alert.sms;

  const outcomes = await notify.sendAll(runtime.notifiers, alert);
  for (const outcome of outcomes) {
    log('  ' + outcome.name + ': ' + (outcome.ok ? 'delivered' : 'FAILED — ' + outcome.error));
  }
  return outcomes.every(o => o.ok);
}

async function main () {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP.trim());
    return 0;
  }

  const cfg = config.load(process.env);
  const built = notify.build(cfg, { units: cfg.units === 'auto' ? 'mgdl' : cfg.units });

  for (const problem of built.problems) {
    console.error('[config] ' + problem);
  }
  if (built.notifiers.length === 0 && !args.dryRun) {
    console.error('[config] no usable notifier configured — set NOTIFIER and its credentials, '
      + 'or use --dry-run to test the detection only');
    return 1;
  }

  const runtime = {
    cfg
    , args
    , notifiers: built.notifiers
    , ns: nightscoutClient(cfg)
    , units: cfg.units === 'auto' ? null : cfg.units
    , thresholds: cfg.units === 'auto' ? null : config.thresholds(cfg, cfg.units)
  };

  log('watching ' + cfg.nightscoutUrl + ' via ' + (built.notifiers.map(n => n.name).join(', ') || 'none'));

  if (args.testAlert) {
    return (await sendTestAlert(runtime)) ? 0 : 1;
  }

  if (args.once || args.dryRun) {
    await runCycle(runtime);
    return 0;
  }

  await runCycle(runtime).catch(err => console.error('[' + timestamp() + '] cycle failed: ' + err.message));

  const interval = setInterval(() => {
    runCycle(runtime).catch(err => console.error('[' + timestamp() + '] cycle failed: ' + err.message));
  }, cfg.pollMins * 60000);

  const shutdown = signal => {
    log('got ' + signal + ', stopping');
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log('polling every ' + cfg.pollMins + ' min — press Ctrl+C to stop');
  return new Promise(() => {}); // run until signalled
}

if (require.main === module) {
  main()
    .then(code => { if (typeof code === 'number' && code !== 0) process.exit(code); })
    .catch(err => { console.error('fatal: ' + (err && err.stack || err)); process.exit(1); });
}

module.exports = { main, runCycle, parseArgs, entryCount };
