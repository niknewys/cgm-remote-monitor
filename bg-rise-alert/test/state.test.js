'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('../src/state');
const config = require('../src/config');

const cfg = config.load({});
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const mins = n => n * 60000;

const rising = { alert: true, level: 'rising', reason: 'rising', stats: { latestMgdl: 200 } };
const rapid = { alert: true, level: 'rapid', reason: 'rising rapidly', stats: { latestMgdl: 240 } };
const quiet = { alert: false, level: null, reason: 'not rising fast enough to alert', stats: {} };

function freshState () {
  return Object.assign({}, state.DEFAULT_STATE);
}

test('a non-alerting result never sends', () => {
  assert.strictEqual(state.shouldSend(quiet, freshState(), cfg, NOW).send, false);
});

test('the first alert always sends', () => {
  const decision = state.shouldSend(rising, freshState(), cfg, NOW);

  assert.strictEqual(decision.send, true);
  assert.strictEqual(decision.reason, 'first alert');
});

test('a second alert inside the cooldown is held', () => {
  const current = freshState();
  current.lastAlert = { at: NOW - mins(5), level: 'rising' };

  const decision = state.shouldSend(rising, current, cfg, NOW);

  assert.strictEqual(decision.send, false);
  assert.match(decision.reason, /cooldown/);
});

test('escalation to rapid breaks through the cooldown once the gap has passed', () => {
  const current = freshState();
  current.lastAlert = { at: NOW - mins(25), level: 'rising' };

  const decision = state.shouldSend(rapid, current, cfg, NOW);

  assert.strictEqual(decision.send, true);
  assert.match(decision.reason, /escalated/);
});

test('escalation does not fire before ESCALATE_AFTER_MINS', () => {
  const current = freshState();
  current.lastAlert = { at: NOW - mins(5), level: 'rising' };

  assert.strictEqual(state.shouldSend(rapid, current, cfg, NOW).send, false);
});

test('rapid does not escalate off a previous rapid alert', () => {
  const current = freshState();
  current.lastAlert = { at: NOW - mins(25), level: 'rapid' };

  assert.strictEqual(state.shouldSend(rapid, current, cfg, NOW).send, false);
});

test('one long climb does not re-alert without a sustained break', () => {
  const current = freshState();
  current.lastAlert = { at: NOW - mins(90), level: 'rising' };
  // A brief pause, far shorter than RESET_MINS.
  current.lastBreakEndedAt = NOW - mins(30);
  current.lastBreakMins = 5;

  const decision = state.shouldSend(rising, current, cfg, NOW);

  assert.strictEqual(decision.send, false);
  assert.match(decision.reason, /same rise episode/);
});

test('a genuinely new episode alerts again', () => {
  const current = freshState();
  current.lastAlert = { at: NOW - mins(90), level: 'rising' };
  current.lastBreakEndedAt = NOW - mins(2);
  current.lastBreakMins = 45;

  const decision = state.shouldSend(rising, current, cfg, NOW);

  assert.strictEqual(decision.send, true);
  assert.strictEqual(decision.reason, 'new rise episode');
});

test('a still-climbing rise re-nudges after REPEAT_AFTER_MINS', () => {
  const current = freshState();
  current.lastAlert = { at: NOW - mins(cfg.repeatAfterMins + 5), level: 'rising' };

  const decision = state.shouldSend(rising, current, cfg, NOW);

  assert.strictEqual(decision.send, true);
  assert.match(decision.reason, /still rising/);
});

test('REPEAT_AFTER_MINS=0 disables the re-nudge', () => {
  const noRepeat = config.load({ REPEAT_AFTER_MINS: '0' });
  const current = freshState();
  current.lastAlert = { at: NOW - mins(600), level: 'rising' };

  assert.strictEqual(state.shouldSend(rising, current, noRepeat, NOW).send, false);
});

test('recordCycle measures the length of a not-rising streak', () => {
  const current = freshState();

  state.recordCycle(current, quiet, NOW - mins(40));
  state.recordCycle(current, quiet, NOW - mins(20));
  assert.strictEqual(current.nonRisingSince, NOW - mins(40));

  state.recordCycle(current, rising, NOW);
  assert.strictEqual(current.lastBreakMins, 40);
  assert.strictEqual(current.lastBreakEndedAt, NOW);
  assert.strictEqual(current.nonRisingSince, null);
});

test('state round-trips through disk and tolerates a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-rise-'));
  const file = path.join(dir, 'state.json');

  assert.deepStrictEqual(state.load(file), Object.assign({}, state.DEFAULT_STATE));

  const current = freshState();
  state.recordAlert(current, rising, NOW);
  state.save(current, file);

  assert.strictEqual(state.load(file).lastAlert.at, NOW);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt state file falls back to defaults instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-rise-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{not json');

  assert.deepStrictEqual(state.load(file), Object.assign({}, state.DEFAULT_STATE));
  fs.rmSync(dir, { recursive: true, force: true });
});
