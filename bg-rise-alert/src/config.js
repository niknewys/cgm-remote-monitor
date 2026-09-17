'use strict';

const units = require('./units');

// Rise thresholds are expressed the way Nightscout shows delta: display units
// per 5 minutes. Defaults differ per unit so the numbers stay readable.
const DEFAULT_RISE_PER_5MIN = { mgdl: 12, mmol: 0.7 };
const DEFAULT_RAPID_PER_5MIN = { mgdl: 21, mmol: 1.2 };

function num (raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim().replace(',', '.'));
  return Number.isFinite(value) ? value : fallback;
}

function bool (raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'on', 'yes'].includes(String(raw).trim().toLowerCase());
}

function list (raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw).split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Parse "23:00-06:00" into minutes-from-midnight, or null when unset. */
function parseQuietHours (raw) {
  if (!raw || !String(raw).trim()) return null;
  const match = String(raw).trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('QUIET_HOURS must look like "23:00-06:00", got: ' + raw);
  const from = Number(match[1]) * 60 + Number(match[2]);
  const to = Number(match[3]) * 60 + Number(match[4]);
  if (from > 1439 || to > 1439) throw new Error('QUIET_HOURS contains an invalid time: ' + raw);
  return { from, to };
}

function normalizeUnits (raw) {
  const value = String(raw || 'auto').trim().toLowerCase();
  if (value === 'auto') return 'auto';
  return value.includes('mmol') ? 'mmol' : 'mgdl';
}

function load (env) {
  env = env || process.env;

  const cfg = {
    nightscoutUrl: String(env.NIGHTSCOUT_URL || 'https://nightscout-niknewys.herokuapp.com').replace(/\/+$/, '')
    , token: env.NIGHTSCOUT_TOKEN || ''
    , apiSecret: env.API_SECRET || ''
    , units: normalizeUnits(env.UNITS)

    // polling / freshness
    , pollMins: num(env.POLL_MINS, 5)
    , maxStaleMins: num(env.MAX_STALE_MINS, 12)
    , requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 15000)

    // rise detection
    , windowMins: num(env.WINDOW_MINS, 20)
    , fastWindowMins: num(env.FAST_WINDOW_MINS, 10)
    , minReadings: num(env.MIN_READINGS, 3)
    , minR2: num(env.MIN_R2, 0.5)
    , risePer5Min: num(env.RISE_PER_5MIN, null)
    , rapidPer5Min: num(env.RAPID_PER_5MIN, null)

    // guards
    , minBgDisplay: num(env.MIN_BG, null)
    , alertAboveDisplay: num(env.ALERT_ABOVE, 0)
    , projectMins: num(env.PROJECT_MINS, 30)
    , insulinLookbackMins: num(env.INSULIN_LOOKBACK_MINS, 90)
    , minBolusUnits: num(env.MIN_BOLUS_UNITS, 0.5)
    , quietHours: parseQuietHours(env.QUIET_HOURS)

    // repeat suppression
    , cooldownMins: num(env.COOLDOWN_MINS, 45)
    , escalateToRapid: bool(env.ESCALATE_TO_RAPID, true)
    , escalateAfterMins: num(env.ESCALATE_AFTER_MINS, 20)
    , repeatAfterMins: num(env.REPEAT_AFTER_MINS, 120)
    , resetMins: num(env.RESET_MINS, 30)
    , stateFile: env.STATE_FILE || null

    // delivery
    , notifiers: list(env.NOTIFIER, ['console'])
    // Emoji force an SMS into UCS-2, halving the characters per billed
    // segment. Opt in only if you want the arrows in your texts.
    , smsUnicode: bool(env.SMS_UNICODE, false)
    , twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || ''
      , authToken: env.TWILIO_AUTH_TOKEN || ''
      , from: env.TWILIO_FROM || ''
      , to: env.TWILIO_TO || ''
      // Overridable so the notifier can be tested against a local stub.
      , apiBase: env.TWILIO_API_BASE || ''
    }
    , pushover: {
      token: env.PUSHOVER_TOKEN || ''
      , user: env.PUSHOVER_USER || ''
      , sound: env.PUSHOVER_SOUND || 'climb'
    }
    , webhook: {
      url: env.WEBHOOK_URL || ''
      , method: String(env.WEBHOOK_METHOD || 'POST').toUpperCase()
    }
  };

  if (!/^https?:\/\//.test(cfg.nightscoutUrl)) {
    throw new Error('NIGHTSCOUT_URL must start with http:// or https://, got: ' + cfg.nightscoutUrl);
  }
  if (cfg.windowMins < 5) throw new Error('WINDOW_MINS must be at least 5');
  if (cfg.minReadings < 2) throw new Error('MIN_READINGS must be at least 2 to fit a trend');
  if (cfg.fastWindowMins > cfg.windowMins) {
    throw new Error('FAST_WINDOW_MINS must not exceed WINDOW_MINS');
  }

  return cfg;
}

/**
 * Resolve the rise thresholds once the display units are known.
 * Returns mg/dL per minute, which is what the detector works in.
 */
function thresholds (cfg, resolvedUnits) {
  const perFive = cfg.risePer5Min !== null ? cfg.risePer5Min : DEFAULT_RISE_PER_5MIN[resolvedUnits];
  const rapidPerFive = cfg.rapidPer5Min !== null ? cfg.rapidPer5Min : DEFAULT_RAPID_PER_5MIN[resolvedUnits];

  return {
    risePer5Min: perFive
    , rapidPer5Min: rapidPerFive
    , riseMgdlPerMin: units.toMgdl(perFive, resolvedUnits) / 5
    , rapidMgdlPerMin: units.toMgdl(rapidPerFive, resolvedUnits) / 5
    // MIN_BG / ALERT_ABOVE are given in display units; the detector uses mg/dL.
    , minBgMgdl: cfg.minBgDisplay !== null ? units.toMgdl(cfg.minBgDisplay, resolvedUnits) : 80
    , alertAboveMgdl: cfg.alertAboveDisplay > 0 ? units.toMgdl(cfg.alertAboveDisplay, resolvedUnits) : 0
  };
}

module.exports = { load, thresholds, parseQuietHours, DEFAULT_RISE_PER_5MIN, DEFAULT_RAPID_PER_5MIN };
