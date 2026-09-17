'use strict';

const units = require('../units');

/**
 * Generic HTTP notifier. The JSON body carries IFTTT's value1/value2/value3
 * alongside named fields, so an IFTTT Webhooks URL works unmodified and so
 * does any endpoint of your own.
 */
function create (cfg, opts) {
  const { url, method } = cfg.webhook;

  return {
    name: 'webhook'

    , validate () {
      return url ? null : 'webhook notifier needs WEBHOOK_URL';
    }

    , async send (alert) {
      const displayUnits = (opts && opts.units) || 'mgdl';
      const payload = {
        value1: alert.title
        , value2: alert.body
        , value3: alert.url
        , level: alert.level
        , title: alert.title
        , message: alert.body
        , sms: alert.sms
        , bg: units.toDisplay(alert.stats.latestMgdl, displayUnits)
        , perFiveMin: units.toDisplay(alert.stats.ratePerMin * 5, displayUnits)
        , units: units.label(displayUnits)
        , at: new Date(alert.stats.latestMills).toISOString()
      };

      const target = new URL(url);
      const init = {
        method
        , signal: AbortSignal.timeout(cfg.requestTimeoutMs)
      };

      if (method === 'GET') {
        for (const [key, value] of Object.entries(payload)) {
          if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
        }
      } else {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(payload);
      }

      const response = await fetch(target, init);
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error('Webhook responded ' + response.status + ': ' + text.slice(0, 200));
      }

      return { delivered: true };
    }
  };
}

module.exports = create;
