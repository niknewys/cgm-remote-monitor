'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  lastAlert: null
  , lastRun: null
  , nonRisingSince: null   // start of the current not-rising streak
  , lastBreakEndedAt: null // when the previous streak ended
  , lastBreakMins: 0       // how long that streak lasted
};

function defaultStateFile () {
  return path.join(__dirname, '..', '.state.json');
}

function load (stateFile) {
  const file = stateFile || defaultStateFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign({}, DEFAULT_STATE, parsed);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[state] ignoring unreadable state file ' + file + ' (' + err.message + ')');
    }
    return Object.assign({}, DEFAULT_STATE);
  }
}

function save (state, stateFile) {
  const file = stateFile || defaultStateFile();
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    // A read-only or ephemeral filesystem must not take the watcher down; the
    // cost is only that a restart may repeat one alert.
    console.warn('[state] could not persist state to ' + file + ' (' + err.message + ')');
  }
}

/**
 * Apply repeat suppression. Pure, so the cooldown rules are testable.
 *
 * The goal is one reminder per rise *episode*, not a running commentary on a
 * rise you already know about. So a fresh alert needs the cooldown to have
 * elapsed AND BG to have stopped rising at some point since the last alert.
 * Two exceptions break through: a rise that escalates to rapid, and a rise
 * still going after REPEAT_AFTER_MINS with no insulin logged.
 */
function shouldSend (result, state, cfg, now) {
  if (!result.alert) return { send: false, reason: result.reason };

  const last = state && state.lastAlert;
  if (!last || !Number.isFinite(last.at)) return { send: true, reason: 'first alert' };

  const elapsedMins = (now - last.at) / 60000;

  // A new episode requires BG to have stopped rising for a sustained stretch
  // since the last alert. A momentary pause inside one long climb is not a
  // new meal, and re-alerting on it is how a reminder becomes noise.
  const brokeSinceLast = Number.isFinite(state.lastBreakEndedAt)
    && state.lastBreakEndedAt > last.at
    && state.lastBreakMins >= cfg.resetMins;

  if (cfg.escalateToRapid && result.level === 'rapid' && last.level === 'rising'
      && elapsedMins >= cfg.escalateAfterMins) {
    return { send: true, reason: 'escalated from rising to rapid' };
  }

  if (elapsedMins < cfg.cooldownMins) {
    return {
      send: false
      , reason: 'in cooldown, ' + Math.ceil(cfg.cooldownMins - elapsedMins) + ' min left'
    };
  }

  if (brokeSinceLast) {
    return { send: true, reason: 'new rise episode' };
  }

  if (cfg.repeatAfterMins > 0 && elapsedMins >= cfg.repeatAfterMins) {
    return { send: true, reason: 'still rising after ' + Math.round(elapsedMins) + ' min' };
  }

  return { send: false, reason: 'same rise episode, already reminded' };
}

/**
 * Track how long BG has been not-rising. A completed streak of at least
 * RESET_MINS is what lets the next rise count as a new episode.
 */
function recordCycle (state, result, now) {
  if (!result.level) {
    if (!Number.isFinite(state.nonRisingSince)) state.nonRisingSince = now;
    return state;
  }

  if (Number.isFinite(state.nonRisingSince)) {
    state.lastBreakMins = (now - state.nonRisingSince) / 60000;
    state.lastBreakEndedAt = now;
    state.nonRisingSince = null;
  }

  return state;
}

function recordAlert (state, result, now) {
  state.lastAlert = { at: now, level: result.level, mgdl: result.stats.latestMgdl };
  return state;
}

module.exports = { load, save, shouldSend, recordAlert, recordCycle, defaultStateFile, DEFAULT_STATE };
