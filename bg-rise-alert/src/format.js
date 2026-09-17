'use strict';

const units = require('./units');

/** Build the human-facing alert. Kept short — it has to read well as an SMS. */
function formatAlert (result, opts) {
  const { units: u, nightscoutUrl } = opts;
  const stats = result.stats;

  const bg = units.format(stats.latestMgdl, u) + ' ' + units.label(u);
  const per5 = units.format(stats.ratePerMin * 5, u, true);
  const change = units.format(Math.abs(stats.changeMgdl), u);
  const span = Math.max(1, Math.round(stats.spanMins));

  const rapid = result.level === 'rapid';
  const title = rapid ? 'BG rising fast — take insulin?' : 'BG rising — take insulin?';

  const body = [
    (rapid ? '⬆️⬆️ ' : '⬆️ ') + bg
    , per5 + ' per 5 min'
    , 'up ' + change + ' over ' + span + ' min'
  ].join(', ') + '.';

  return {
    level: result.level
    , title
    , body
    , sms: title + ' ' + body
    , url: nightscoutUrl
    , stats
  };
}

/** One-line summary for the log / --dry-run output. */
function formatStatus (result, opts) {
  const u = opts.units;
  const stats = result.stats;

  if (!stats) return 'no data — ' + result.reason;

  const parts = [
    units.format(stats.latestMgdl, u) + ' ' + units.label(u)
    , units.format(stats.ratePerMin * 5, u, true) + '/5min'
    , 'R2 ' + stats.r2.toFixed(2)
    , stats.n + ' readings/' + stats.windowMins + 'min'
    , stats.ageMins.toFixed(1) + ' min old'
  ];

  const verdict = result.alert
    ? 'ALERT (' + result.level + ')'
    : (result.guard ? 'held [' + result.guard + ']' : 'quiet');

  return verdict + ' — ' + parts.join(' | ') + ' — ' + result.reason;
}

module.exports = { formatAlert, formatStatus };
