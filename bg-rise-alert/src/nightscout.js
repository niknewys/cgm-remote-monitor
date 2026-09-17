'use strict';

const crypto = require('crypto');

function init (cfg) {
  const ns = {};

  function headers () {
    const head = { accept: 'application/json' };
    if (cfg.apiSecret) {
      // Nightscout expects the SHA1 of the secret, never the secret itself.
      head['api-secret'] = crypto.createHash('sha1').update(cfg.apiSecret).digest('hex');
    }
    return head;
  }

  function url (path, params) {
    const target = new URL(cfg.nightscoutUrl + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    if (cfg.token) target.searchParams.set('token', cfg.token);
    return target;
  }

  async function getJson (path, params) {
    const target = url(path, params);
    const response = await fetch(target, {
      headers: headers()
      , signal: AbortSignal.timeout(cfg.requestTimeoutMs)
    });

    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error('Nightscout ' + path + ' returned ' + response.status + ' ' + response.statusText
        + (body ? ': ' + body : ''));
    }

    return response.json();
  }

  /** Retry transient failures; a flaky dyno should not skip a whole cycle. */
  async function withRetry (label, fn, attempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < attempts) {
          const wait = 1000 * Math.pow(2, attempt - 1);
          console.warn('[nightscout] ' + label + ' failed (' + err.message + '), retrying in ' + wait + 'ms');
          await new Promise(resolve => setTimeout(resolve, wait));
        }
      }
    }
    throw lastErr;
  }

  /** Display units the site itself uses, so alerts read like the Nightscout UI. */
  ns.fetchUnits = async function fetchUnits () {
    const status = await withRetry('status', () => getJson('/api/v1/status.json'));
    const units = status && status.settings && status.settings.units;
    return String(units || '').toLowerCase().includes('mmol') ? 'mmol' : 'mgdl';
  };

  ns.fetchEntries = async function fetchEntries (count) {
    return withRetry('entries', () => getJson('/api/v1/entries/sgv.json', { count: count || 24 }));
  };

  ns.fetchTreatments = async function fetchTreatments (count) {
    // Nightscout returns treatments newest-first; a small count covers the lookback.
    return withRetry('treatments', () => getJson('/api/v1/treatments.json', { count: count || 20 }))
      .catch(err => {
        // Treatments may be locked down even when entries are public. A missing
        // insulin log must not stop the reminder that insulin is needed.
        console.warn('[nightscout] could not read treatments (' + err.message + '); '
          + 'continuing without the recent-insulin check');
        return [];
      });
  };

  return ns;
}

module.exports = init;
