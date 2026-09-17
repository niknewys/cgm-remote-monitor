'use strict';

const API = 'https://api.twilio.com/2010-04-01/Accounts/';

function create (cfg) {
  const { accountSid, authToken, from } = cfg.twilio;
  const recipients = String(cfg.twilio.to || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

  return {
    name: 'twilio'

    , validate () {
      const missing = [];
      if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
      if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
      if (!from) missing.push('TWILIO_FROM');
      if (recipients.length === 0) missing.push('TWILIO_TO');
      return missing.length ? 'twilio notifier needs ' + missing.join(', ') : null;
    }

    , async send (alert) {
      const auth = Buffer.from(accountSid + ':' + authToken).toString('base64');
      const results = [];

      for (const to of recipients) {
        const body = new URLSearchParams({ From: from, To: to, Body: alert.sms });
        const response = await fetch(API + encodeURIComponent(accountSid) + '/Messages.json', {
          method: 'POST'
          , headers: {
            authorization: 'Basic ' + auth
            , 'content-type': 'application/x-www-form-urlencoded'
          }
          , body
          , signal: AbortSignal.timeout(cfg.requestTimeoutMs)
        });

        const text = await response.text();
        if (!response.ok) {
          throw new Error('Twilio responded ' + response.status + ': ' + text.slice(0, 200));
        }
        results.push({ to, sid: safeSid(text) });
      }

      return { delivered: true, results };
    }
  };
}

function safeSid (text) {
  try { return JSON.parse(text).sid; } catch (err) { return undefined; }
}

module.exports = create;
