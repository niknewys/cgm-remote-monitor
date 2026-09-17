'use strict';

const API = 'https://api.pushover.net/1/messages.json';

function create (cfg) {
  const { token, user, sound } = cfg.pushover;

  return {
    name: 'pushover'

    , validate () {
      const missing = [];
      if (!token) missing.push('PUSHOVER_TOKEN');
      if (!user) missing.push('PUSHOVER_USER');
      return missing.length ? 'pushover notifier needs ' + missing.join(', ') : null;
    }

    , async send (alert) {
      const body = new URLSearchParams({
        token
        , user
        , title: alert.title
        , message: alert.body
        , sound: sound || 'climb'
        // High priority for a rapid rise so it cuts through a quiet phone.
        , priority: alert.level === 'rapid' ? '1' : '0'
      });
      if (alert.url) {
        body.set('url', alert.url);
        body.set('url_title', 'Open Nightscout');
      }

      const response = await fetch(API, {
        method: 'POST'
        , headers: { 'content-type': 'application/x-www-form-urlencoded' }
        , body
        , signal: AbortSignal.timeout(cfg.requestTimeoutMs)
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error('Pushover responded ' + response.status + ': ' + text.slice(0, 200));
      }

      return { delivered: true };
    }
  };
}

module.exports = create;
