'use strict';

const units = require('./units');

// Characters outside GSM-7 force an SMS into UCS-2, which cuts a segment from
// 160 characters to 70 - so an emoji can double what every alert costs.
const GSM7_SUBSTITUTIONS = [
  [/[\u2010-\u2015]/g, '-']      // hyphens and dashes
  , [/[\u2018\u2019]/g, "'"]      // curly single quotes
  , [/[\u201c\u201d]/g, '"']      // curly double quotes
  , [/\u2026/g, '...']            // ellipsis
  , [/[\u2b06\u2b07\u2191\u2193]\ufe0f?/g, '']  // arrows, with any variation selector
  , [/\ufe0f/g, '']               // stray variation selectors
];

/** Rewrite text so it fits the GSM-7 alphabet, dropping anything still exotic. */
function toGsm7 (text) {
  let out = String(text);
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  // Anything left outside plain printable ASCII would still trigger UCS-2.
  out = out.replace(/[^\x20-\x7e\n]/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

/** What this text will actually cost to send. */
function smsSegments (text) {
  const unicode = /[^\x20-\x7e\n]/.test(text);
  const chars = [...text].length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;

  return {
    encoding: unicode ? 'UCS-2' : 'GSM-7'
    , chars
    , segments: chars <= single ? 1 : Math.ceil(chars / multi)
  };
}

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

  const detail = [bg, per5 + ' per 5 min', 'up ' + change + ' over ' + span + ' min'].join(', ') + '.';
  const body = (rapid ? '⬆️⬆️ ' : '⬆️ ') + detail;

  // SMS gets plain-ASCII wording so it bills as a single segment. Push
  // channels have no such limit, so they keep the arrows and the em dash.
  const sms = toGsm7((rapid ? 'BG rising FAST - take insulin?' : 'BG rising - take insulin?')
    + ' ' + detail);

  return {
    level: result.level
    , title
    , body
    , sms
    , smsRich: title + ' ' + body
    , segments: smsSegments(sms)
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

module.exports = { formatAlert, formatStatus, toGsm7, smsSegments };
