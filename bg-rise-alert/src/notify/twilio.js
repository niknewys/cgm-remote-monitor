'use strict';

const DEFAULT_API_BASE = 'https://api.twilio.com';

// Twilio failures are mostly setup mistakes. Say what to actually do about
// them, because the raw message alone rarely makes the fix obvious.
const ERROR_HINTS = {
  20003: 'authentication failed — check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN'
  , 21211: 'TWILIO_TO is not a valid number — it must be E.164, e.g. +61412345678'
  , 21212: 'TWILIO_FROM is not a valid number — it must be E.164, e.g. +61212345678'
  , 21408: 'your Twilio account cannot send to that country yet — enable it under '
    + 'Messaging > Settings > Geo permissions'
  , 21606: 'TWILIO_FROM is not an SMS-capable number on your account'
  , 21608: 'trial accounts can only text verified numbers — verify TWILIO_TO in the '
    + 'Twilio console, or upgrade the account'
  , 21610: 'that number replied STOP and is unsubscribed — reply START from the handset'
  , 21614: 'TWILIO_TO is not a mobile number'
};

const E164 = /^\+[1-9]\d{6,14}$/;

function create (cfg) {
  const { accountSid, authToken, from, apiBase } = cfg.twilio;
  const recipients = String(cfg.twilio.to || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');

  return {
    name: 'twilio'

    , validate () {
      const problems = [];
      if (!accountSid) problems.push('TWILIO_ACCOUNT_SID');
      if (!authToken) problems.push('TWILIO_AUTH_TOKEN');
      if (!from) problems.push('TWILIO_FROM');
      if (recipients.length === 0) problems.push('TWILIO_TO');
      if (problems.length) return 'twilio notifier needs ' + problems.join(', ');

      // Catch a malformed number now, not the first time BG actually rises.
      if (!E164.test(from)) {
        return 'TWILIO_FROM must be in E.164 format (e.g. +61212345678), got: ' + from;
      }
      const badTo = recipients.filter(to => !E164.test(to));
      if (badTo.length) {
        return 'TWILIO_TO must be in E.164 format (e.g. +61412345678), got: ' + badTo.join(', ');
      }
      if (accountSid && !/^AC[0-9a-f]{32}$/i.test(accountSid)) {
        return 'TWILIO_ACCOUNT_SID should start with "AC" followed by 32 hex characters';
      }

      return null;
    }

    , async send (alert) {
      const auth = Buffer.from(accountSid + ':' + authToken).toString('base64');
      const text = cfg.smsUnicode ? (alert.smsRich || alert.sms) : alert.sms;
      const results = [];
      const failures = [];

      for (const to of recipients) {
        try {
          results.push(await sendOne(to, text, auth));
        } catch (err) {
          // One bad recipient must not stop the rest from being told.
          failures.push(to + ': ' + err.message);
        }
      }

      if (results.length === 0) {
        throw new Error(failures.join('; ') || 'no recipients configured');
      }
      if (failures.length) {
        console.warn('[twilio] some recipients failed — ' + failures.join('; '));
      }

      return { delivered: true, results, failures };
    }
  };

  async function sendOne (to, text, auth) {
    const body = new URLSearchParams({ From: from, To: to, Body: text });

    const response = await fetch(base + '/2010-04-01/Accounts/' + encodeURIComponent(accountSid) + '/Messages.json', {
      method: 'POST'
      , headers: {
        authorization: 'Basic ' + auth
        , 'content-type': 'application/x-www-form-urlencoded'
      }
      , body
      , signal: AbortSignal.timeout(cfg.requestTimeoutMs)
    });

    const raw = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { /* Twilio always sends JSON, but never assume */ }

    if (!response.ok) {
      const code = parsed && parsed.code;
      const detail = (parsed && parsed.message) || raw.slice(0, 200);
      const hint = ERROR_HINTS[code];
      throw new Error('Twilio ' + response.status
        + (code ? ' (code ' + code + ')' : '') + ': ' + detail
        + (hint ? ' — ' + hint : ''));
    }

    return { to, sid: parsed && parsed.sid, status: parsed && parsed.status };
  }
}

module.exports = create;
module.exports.DEFAULT_API_BASE = DEFAULT_API_BASE;
module.exports.ERROR_HINTS = ERROR_HINTS;
