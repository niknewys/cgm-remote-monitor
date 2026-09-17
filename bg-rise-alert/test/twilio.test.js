'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const config = require('../src/config');
const format = require('../src/format');
const twilio = require('../src/notify/twilio');

const SID = 'AC' + 'a'.repeat(32);

/** A stand-in for the Twilio REST API that records what it was sent. */
function stubTwilio (handler) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const record = {
        method: req.method
        , path: req.url
        , auth: req.headers.authorization
        , contentType: req.headers['content-type']
        , params: Object.fromEntries(new URLSearchParams(body))
      };
      requests.push(record);

      const reply = handler ? handler(record, requests.length) : null;
      const status = (reply && reply.status) || 201;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify((reply && reply.body) || { sid: 'SM123', status: 'queued' }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        requests
        , base: 'http://127.0.0.1:' + server.address().port
        , close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function makeAlert (level = 'rapid', units = 'mmol') {
  return format.formatAlert({
    level, alert: true, reason: 'test'
    , stats: {
      latestMgdl: 218, latestMills: Date.UTC(2026, 0, 15, 12), ageMins: 1
      , ratePerMin: 3.4, changeMgdl: 61, r2: 0.93, n: 6, spanMins: 18, windowMins: 20
    }
  }, { units, nightscoutUrl: 'https://ns.example.com' });
}

function makeNotifier (stub, extra = {}) {
  return twilio(config.load(Object.assign({
    NOTIFIER: 'twilio'
    , TWILIO_ACCOUNT_SID: SID
    , TWILIO_AUTH_TOKEN: 'secret-token'
    , TWILIO_FROM: '+61212345678'
    , TWILIO_TO: '+61412345678'
    , TWILIO_API_BASE: stub.base
  }, extra)));
}

test('sends a correctly shaped request to the Messages endpoint', async () => {
  const stub = await stubTwilio();
  try {
    const result = await makeNotifier(stub).send(makeAlert());
    const sent = stub.requests[0];

    assert.strictEqual(stub.requests.length, 1);
    assert.strictEqual(sent.method, 'POST');
    assert.strictEqual(sent.path, '/2010-04-01/Accounts/' + SID + '/Messages.json');
    assert.strictEqual(sent.contentType, 'application/x-www-form-urlencoded');
    assert.strictEqual(sent.params.From, '+61212345678');
    assert.strictEqual(sent.params.To, '+61412345678');
    assert.strictEqual(result.results[0].sid, 'SM123');
  } finally {
    await stub.close();
  }
});

test('authenticates with HTTP basic auth over sid:token', async () => {
  const stub = await stubTwilio();
  try {
    await makeNotifier(stub).send(makeAlert());

    const [scheme, encoded] = stub.requests[0].auth.split(' ');
    assert.strictEqual(scheme, 'Basic');
    assert.strictEqual(Buffer.from(encoded, 'base64').toString(), SID + ':secret-token');
  } finally {
    await stub.close();
  }
});

test('the body is GSM-7, so it bills as one segment', async () => {
  const stub = await stubTwilio();
  try {
    await makeNotifier(stub).send(makeAlert());
    const body = stub.requests[0].params.Body;

    assert.doesNotMatch(body, /[^\x20-\x7e]/, 'no character should force UCS-2');
    assert.ok(body.length <= 160, 'should fit a single GSM-7 segment');
    assert.match(body, /BG rising FAST - take insulin\?/);
    assert.match(body, /12\.1 mmol\/L/);
  } finally {
    await stub.close();
  }
});

test('SMS_UNICODE opts back into the emoji wording', async () => {
  const stub = await stubTwilio();
  try {
    await makeNotifier(stub, { SMS_UNICODE: 'true' }).send(makeAlert());

    assert.match(stub.requests[0].params.Body, /⬆/);
  } finally {
    await stub.close();
  }
});

test('texts every recipient', async () => {
  const stub = await stubTwilio();
  try {
    await makeNotifier(stub, { TWILIO_TO: '+61412345678, +61498765432' }).send(makeAlert());

    assert.deepStrictEqual(stub.requests.map(r => r.params.To), ['+61412345678', '+61498765432']);
  } finally {
    await stub.close();
  }
});

test('a failing recipient does not stop the others', async () => {
  const stub = await stubTwilio((record, n) => n === 1
    ? { status: 400, body: { code: 21610, message: 'Unsubscribed recipient' } }
    : null);
  try {
    const result = await makeNotifier(stub, { TWILIO_TO: '+61412345678, +61498765432' })
      .send(makeAlert());

    assert.strictEqual(result.delivered, true);
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.failures.length, 1);
  } finally {
    await stub.close();
  }
});

test('a trial-account rejection explains how to fix it', async () => {
  const stub = await stubTwilio(() => ({
    status: 400
    , body: { code: 21608, message: 'The number is unverified.' }
  }));
  try {
    await assert.rejects(makeNotifier(stub).send(makeAlert()), err => {
      assert.match(err.message, /21608/);
      assert.match(err.message, /verified numbers/);
      return true;
    });
  } finally {
    await stub.close();
  }
});

test('a geo-permission rejection names the setting to change', async () => {
  const stub = await stubTwilio(() => ({
    status: 400
    , body: { code: 21408, message: 'Permission to send an SMS has not been enabled.' }
  }));
  try {
    await assert.rejects(makeNotifier(stub).send(makeAlert()), /Geo permissions/);
  } finally {
    await stub.close();
  }
});

test('bad credentials surface as an auth hint', async () => {
  const stub = await stubTwilio(() => ({
    status: 401, body: { code: 20003, message: 'Authenticate' }
  }));
  try {
    await assert.rejects(makeNotifier(stub).send(makeAlert()), /TWILIO_AUTH_TOKEN/);
  } finally {
    await stub.close();
  }
});

test('a non-JSON error response still produces a usable message', async () => {
  const stub = await stubTwilio(() => ({ status: 502, body: null }));
  try {
    // The stub serialises null, which parses fine; assert we still report status.
    await assert.rejects(makeNotifier(stub).send(makeAlert()), /Twilio 502/);
  } finally {
    await stub.close();
  }
});

test('mg/dL alerts are also single-segment', async () => {
  const stub = await stubTwilio();
  try {
    await makeNotifier(stub).send(makeAlert('rising', 'mgdl'));
    const body = stub.requests[0].params.Body;

    assert.doesNotMatch(body, /[^\x20-\x7e]/);
    assert.match(body, /218 mg\/dL/);
  } finally {
    await stub.close();
  }
});

test('GSM-7 transliteration strips what would force UCS-2', () => {
  assert.strictEqual(format.toGsm7('a — b'), 'a - b');
  assert.strictEqual(format.toGsm7('⬆️ up'), 'up');
  assert.strictEqual(format.toGsm7('it’s “fine”'), "it's \"fine\"");
  assert.doesNotMatch(format.toGsm7('BG ↑↑ rising …'), /[^\x20-\x7e]/);
});

test('segment counting reflects the encoding', () => {
  assert.deepStrictEqual(format.smsSegments('hello'), { encoding: 'GSM-7', chars: 5, segments: 1 });
  assert.strictEqual(format.smsSegments('a'.repeat(161)).segments, 2);
  assert.strictEqual(format.smsSegments('⬆').encoding, 'UCS-2');
  assert.strictEqual(format.smsSegments('⬆'.repeat(71)).segments, 2);
});
