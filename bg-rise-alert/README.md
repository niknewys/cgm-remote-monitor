# bg-rise-alert

A small standalone watcher that reads your Nightscout site and sends a phone
reminder when your blood glucose starts climbing — the nudge to take insulin
when you've forgotten it before a meal.

It does **not** touch the Nightscout app in this repository. It only reads the
public API over HTTPS, so you can run it anywhere and your Nightscout install
stays exactly as it came from upstream.

- Zero npm dependencies. Node 18+ only.
- Works with SMS (Twilio), Pushover, or any webhook (IFTTT included).
- Tuned against real data from your own site, not guessed thresholds.

## Quick start

```bash
cd bg-rise-alert
cp .env.example .env          # then edit it

# See what it would do right now, without notifying anyone:
node src/index.js --once --dry-run

# Once notifications are configured, check they actually arrive:
node src/index.js --test-alert

# Run it for real:
node src/index.js
```

`--dry-run` prints a verdict like:

```
[2026-09-17 00:12:42] using mmol — alerting at 0.7/5min (rising), 1.2/5min (rapid)
[2026-09-17 00:12:42] quiet — 10.8 mmol/L | -0.4/5min | R2 0.77 | 8 readings/20min | 0.7 min old — not rising fast enough to alert
```

A reminder reads:

> **BG rising fast — take insulin?** ⬆️⬆️ 12.1 mmol/L, +1.0 per 5 min, up 3.4 over 18 min.

## Getting it to your phone

Set `NOTIFIER` to one or more of `twilio`, `pushover`, `webhook`, `console`
(comma separated — several at once is fine).

**Real SMS — Twilio.** Sign up, buy a number, then set `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `TWILIO_TO`. Costs roughly a cent per
message. This is the only option that is genuinely an SMS.

**Push — Pushover.** A one-off app purchase and no per-message cost. Set
`PUSHOVER_TOKEN` and `PUSHOVER_USER`. A rapid rise is sent at high priority so
it cuts through a silent phone. Usually the better choice than SMS.

**Free SMS-ish — IFTTT.** Create a Webhooks applet, trigger event name of your
choosing, action "send me an SMS" or a notification. Point `WEBHOOK_URL` at
`https://maker.ifttt.com/trigger/<event>/with/key/<key>`. The payload carries
IFTTT's `value1`/`value2`/`value3` fields, so the applet needs no extra setup.

## How it decides you are rising

CGM data is noisy and irregularly spaced — your xDrip uploads every 2–5 minutes
and readings zig-zag by 5–10 mg/dL between them. A simple "last reading minus
previous" delta false-alarms constantly on that. So instead:

1. Readings in the last `WINDOW_MINS` (and again in a shorter
   `FAST_WINDOW_MINS`, so a sharp onset is caught early) are fitted with a
   **least-squares line**. The slope is the rise rate.
2. The fit is only trusted if **R² ≥ `MIN_R2`** — scatter that isn't really a
   trend is rejected rather than alerted on.
3. The rate is compared against `RISE_PER_5MIN` and `RAPID_PER_5MIN`, expressed
   in your display units per 5 minutes — the same number Nightscout shows.

A reminder is then held back if any of these apply:

| Guard | Why |
| --- | --- |
| `MIN_BG` | You're climbing out of a low. That rise is wanted. |
| recent bolus | Insulin was already logged within `INSULIN_LOOKBACK_MINS`. |
| `QUIET_HOURS` | You asked not to be woken. |
| `ALERT_ABOVE` | The rise isn't heading anywhere that needs insulin. |
| cooldown | You were already reminded about *this* rise. |

## One reminder per rise, not a running commentary

The repeat rules matter more than the thresholds. A four-hour climb should
produce one reminder, not forty.

- After a reminder, nothing else is sent for `COOLDOWN_MINS`.
- After that, a new reminder still needs BG to have **stopped rising for a
  sustained `RESET_MINS`** first. A momentary pause inside one long climb is
  not a new meal.
- Two things break through anyway: a rise that escalates to *rapid*
  (`ESCALATE_TO_RAPID`, no sooner than `ESCALATE_AFTER_MINS`), and a rise still
  going after `REPEAT_AFTER_MINS` with no insulin logged.
- The cooldown only starts once a notifier actually accepted the message, so a
  failed send doesn't silently swallow the reminder.

## Tuning it against your own data

Guessing thresholds is how you end up ignoring the alerts. Replay them over
your real history instead:

```bash
node tools/backtest.js 7 --verbose
```

```
replaying 2477 readings over 4.0 days
thresholds: rising 0.7, rapid 1.2 mmol/L/5min | cooldown 45 min | min R2 0.5

alerts: 30 (7.5 per day)
  rising: 23 | rapid: 7
  busiest hours (local): 3:00 x4, 21:00 x3, 8:00 x3
```

Override any setting on the command line to compare:

```bash
RISE_PER_5MIN=0.9 QUIET_HOURS=23:00-07:00 node tools/backtest.js 7
```

On the current data from `nightscout-niknewys`, the shipped defaults fire about
**7–8 times a day**, roughly 1–2 of those overnight. That is a real reflection
of how often BG climbs uncovered rather than a noisy detector — but it is more
than most people will keep paying attention to. The most effective single knob
is `QUIET_HOURS` (drops it to ~6/day); after that, raise `RISE_PER_5MIN`
towards `0.9`–`1.0` until the rate feels like something you'll act on.

## Running it continuously

**Locally / on a server**, keep it running with systemd:

```ini
[Unit]
Description=bg-rise-alert
After=network-online.target

[Service]
WorkingDirectory=/opt/bg-rise-alert
EnvironmentFile=/opt/bg-rise-alert/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

**From cron**, use one-shot mode (set `STATE_FILE` to somewhere persistent so
the cooldown survives between runs):

```cron
*/5 * * * * cd /opt/bg-rise-alert && STATE_FILE=/var/lib/bg-rise-alert/state.json /usr/bin/node src/index.js --once >> /var/log/bg-rise-alert.log 2>&1
```

**On a free host** (Railway, Fly, Render, a spare Heroku dyno), deploy this
directory, set the environment variables, and run `npm start`. There is nothing
to build and nothing to install.

## Tests

```bash
npm test
```

48 tests covering the trend fitting, every guard, the repeat-suppression rules,
unit conversion in both mmol and mg/dL, and notifier configuration.

## A caveat worth stating

This is a convenience reminder built on data that can be late, wrong, or
missing — a dead phone, an expired Heroku dyno or a sensor warmup all mean no
alert arrives. Don't let it replace how you already decide on insulin, and
don't use it as a safety alarm for hypos; it deliberately stays quiet below
`MIN_BG`. Dose changes are between you and your diabetes team.
