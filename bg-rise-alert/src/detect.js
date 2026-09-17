'use strict';

const MIN_VALID_MGDL = 40; // Nightscout uses values below this for sensor error codes.

/**
 * Normalize raw Nightscout entries into ascending {mills, mgdl} points,
 * dropping error codes and duplicate timestamps.
 */
function cleanEntries (raw) {
  const seen = new Set();
  const points = [];

  for (const entry of raw || []) {
    if (!entry) continue;
    const mills = Number(entry.mills !== undefined ? entry.mills : entry.date);
    const mgdl = Number(entry.sgv !== undefined ? entry.sgv : entry.mgdl);
    if (!Number.isFinite(mills) || !Number.isFinite(mgdl)) continue;
    if (mgdl < MIN_VALID_MGDL) continue;
    if (seen.has(mills)) continue;
    seen.add(mills);
    points.push({ mills, mgdl });
  }

  return points.sort((a, b) => a.mills - b.mills);
}

/**
 * Least-squares fit of mgdl against minutes. Handles the irregular spacing
 * xDrip produces far better than a two-point delta does.
 * Returns null when the points cannot define a line.
 */
function linearRegression (points) {
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0, sumY = 0;
  for (const p of points) { sumX += p.x; sumY += p.y; }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0, sxy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    sxx += dx * dx;
    sxy += dx * (p.y - meanY);
  }
  if (sxx === 0) return null; // every reading shares a timestamp

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const predicted = slope * p.x + intercept;
    ssRes += Math.pow(p.y - predicted, 2);
    ssTot += Math.pow(p.y - meanY, 2);
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, r2, n };
}

/** Fit the readings falling inside `windowMins` before `now`. */
function fitWindow (entries, now, windowMins) {
  const from = now - windowMins * 60000;
  const inWindow = entries.filter(e => e.mills >= from && e.mills <= now);
  if (inWindow.length < 2) return { n: inWindow.length, fit: null };

  const latestMills = inWindow[inWindow.length - 1].mills;
  const points = inWindow.map(e => ({ x: (e.mills - latestMills) / 60000, y: e.mgdl }));
  const fit = linearRegression(points);
  if (!fit) return { n: inWindow.length, fit: null };

  const spanMins = (latestMills - inWindow[0].mills) / 60000;

  return {
    n: inWindow.length
    , fit
    , windowMins
    , spanMins
    , ratePerMin: fit.slope
    , r2: fit.r2
    , changeMgdl: fit.slope * spanMins
  };
}

/**
 * Decide whether BG is rising, and whether that deserves a reminder.
 *
 * Pure: everything it needs is passed in, so the whole decision is testable
 * without touching the network or the clock.
 */
function analyze (opts) {
  const { entries, treatments, now, cfg, thresholds, units } = opts;
  const clean = cleanEntries(entries);

  const base = { level: null, alert: false, guard: null, stats: null };

  if (clean.length === 0) {
    return Object.assign(base, { reason: 'no usable CGM readings' });
  }

  const latest = clean[clean.length - 1];
  const ageMins = (now - latest.mills) / 60000;

  const stats = {
    latestMgdl: latest.mgdl
    , latestMills: latest.mills
    , ageMins
    , ratePerMin: 0
    , changeMgdl: 0
    , r2: 0
    , n: 0
    , spanMins: 0
    , windowMins: cfg.windowMins
  };

  if (ageMins > cfg.maxStaleMins) {
    return Object.assign(base, {
      stats
      , reason: 'latest reading is ' + ageMins.toFixed(0) + ' min old (stale)'
    });
  }

  // Try the long window first, then the fast one, so a sharp onset is caught
  // early without letting short-window noise drive the decision.
  const candidates = [cfg.windowMins, cfg.fastWindowMins]
    .filter(w => w > 0)
    .map(w => fitWindow(clean, now, w))
    .filter(w => w.fit && w.n >= cfg.minReadings);

  if (candidates.length === 0) {
    return Object.assign(base, {
      stats
      , reason: 'not enough readings in the last ' + cfg.windowMins + ' min to fit a trend'
    });
  }

  // Trust only fits that actually look like a trend, then take the fastest.
  const trusted = candidates.filter(c => c.r2 >= cfg.minR2);
  const pool = trusted.length > 0 ? trusted : candidates;
  const best = pool.reduce((a, b) => (b.ratePerMin > a.ratePerMin ? b : a));

  Object.assign(stats, {
    ratePerMin: best.ratePerMin
    , changeMgdl: best.changeMgdl
    , r2: best.r2
    , n: best.n
    , spanMins: best.spanMins
    , windowMins: best.windowMins
  });

  if (trusted.length === 0) {
    return Object.assign(base, {
      stats
      , reason: 'readings too scattered to call a trend (R2 ' + best.r2.toFixed(2) + ' < ' + cfg.minR2 + ')'
    });
  }

  let level = null;
  if (best.ratePerMin >= thresholds.rapidMgdlPerMin) level = 'rapid';
  else if (best.ratePerMin >= thresholds.riseMgdlPerMin) level = 'rising';

  if (!level) {
    return Object.assign(base, { stats, reason: 'not rising fast enough to alert' });
  }

  // --- guards: BG is rising, but a reminder would be wrong or unwanted ---

  if (latest.mgdl < thresholds.minBgMgdl) {
    return Object.assign(base, {
      level
      , stats
      , guard: 'below-min-bg'
      , reason: 'rising, but below the MIN_BG floor (likely recovering from a low)'
    });
  }

  // Optional: ignore rises that are not heading anywhere needing insulin.
  if (thresholds.alertAboveMgdl > 0) {
    const projected = latest.mgdl + best.ratePerMin * cfg.projectMins;
    stats.projectedMgdl = projected;
    if (Math.max(latest.mgdl, projected) < thresholds.alertAboveMgdl) {
      return Object.assign(base, {
        level
        , stats
        , guard: 'below-alert-above'
        , reason: 'rising, but not projected to reach the ALERT_ABOVE level'
      });
    }
  }

  const bolus = recentBolus(treatments, now, cfg);
  if (bolus) {
    return Object.assign(base, {
      level
      , stats
      , guard: 'recent-insulin'
      , bolus
      , reason: 'rising, but ' + bolus.insulin + 'U was logged '
        + Math.round((now - bolus.mills) / 60000) + ' min ago'
    });
  }

  if (inQuietHours(cfg.quietHours, now)) {
    return Object.assign(base, {
      level
      , stats
      , guard: 'quiet-hours'
      , reason: 'rising, but inside QUIET_HOURS'
    });
  }

  return {
    level
    , alert: true
    , guard: null
    , stats
    , reason: level === 'rapid' ? 'rising rapidly' : 'rising'
  };
}

/** Most recent bolus at or above the configured size, within the lookback. */
function recentBolus (treatments, now, cfg) {
  if (!cfg.insulinLookbackMins || cfg.insulinLookbackMins <= 0) return null;
  const from = now - cfg.insulinLookbackMins * 60000;

  let best = null;
  for (const t of treatments || []) {
    if (!t) continue;
    const insulin = Number(t.insulin);
    if (!Number.isFinite(insulin) || insulin < cfg.minBolusUnits) continue;
    const mills = Number(t.mills !== undefined ? t.mills : Date.parse(t.created_at));
    if (!Number.isFinite(mills) || mills < from || mills > now) continue;
    if (!best || mills > best.mills) best = { mills, insulin, eventType: t.eventType };
  }

  return best;
}

/** Quiet hours may wrap past midnight, e.g. 23:00-06:00. */
function inQuietHours (quietHours, now) {
  if (!quietHours) return false;
  const date = new Date(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const { from, to } = quietHours;
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

module.exports = { analyze, cleanEntries, linearRegression, fitWindow, recentBolus, inQuietHours, MIN_VALID_MGDL };
