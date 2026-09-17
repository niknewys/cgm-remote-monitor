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
cp .env.example .env          # then fill in your Twilio details

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

```
BG rising FAST - take insulin? 12.1 mmol/L, +0.9 per 5 min, up 3.4 over 18 min.
```

Text messages are deliberately plain ASCII. Any emoji or em dash forces an SMS
into UCS-2 encoding, which cuts a billed segment from 160 characters to 70 — so
a decorated message costs two SMS instead of one, every time. Pushover and
webhook alerts have no such limit and keep the arrows (`⬆️⬆️ 12.1 mmol/L, ...`).
Set `SMS_UNICODE=true` if you would rather have the arrows in your texts.

## Getting it to your phone

Set `NOTIFIER` to one or more of `twilio`, `pushover`, `webhook`, `console`
(comma separated — several at once is fine).

**Real SMS — Twilio** (the configured default). Step by step:

1. Create a Twilio account, then buy an SMS-capable number under
   *Phone Numbers > Buy a number*. Buying a number in your own country is
   usually cheapest and most reliable for delivery.
2. Copy the **Account SID** and **Auth Token** from the console dashboard.
3. Put all four values in `.env`:

   ```bash
   NOTIFIER=twilio
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your-auth-token
   TWILIO_FROM=+61212345678       # the Twilio number you bought
   TWILIO_TO=+61412345678         # your mobile
   ```

   Both numbers must be **E.164**: a leading `+` and country code, no spaces
   or dashes. An Australian mobile `0412 345 678` becomes `+61412345678`. The
   format is checked at startup rather than the first time BG rises.
4. `node src/index.js --test-alert` and wait for the text.

Two things catch nearly everyone out the first time:

- **Trial accounts can only text verified numbers.** Verify your mobile under
  *Phone Numbers > Verified Caller IDs*, or upgrade the account.
- **Geo permissions.** A new account may not be allowed to send to your
  country. Enable it under *Messaging > Settings > Geo permissions*.

Both come back as a clear error naming the setting to change, rather than a
bare API code.

**Push — Pushover.** A one-off app purchase and no per-message cost. Set
`PUSHOVER_TOKEN` and `PUSHOVER_USER`. A rapid rise is sent at high priority so
it cuts through a silent phone. Cheaper than SMS if the volume bothers you.

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

## What the SMS will cost

The defaults fire about 7–8 times a day (see tuning above), and each alert is
one SMS segment. So budget on the order of **220–240 messages a month**, plus
whatever Twilio charges to rent the number. Multiply by your country's current
per-message rate from Twilio's pricing page for the real figure.

If that reads higher than you'd like, in order of effect: set `QUIET_HOURS`,
raise `RISE_PER_5MIN` toward `0.9`–`1.0`, lengthen `COOLDOWN_MINS`, or set
`ESCALATE_TO_RAPID=false` to drop the follow-up text when a rise accelerates.
Re-run `tools/backtest.js` after each change to see the new rate before you
commit to it.

## Tests

```bash
npm test
```

63 tests covering the trend fitting, every guard, the repeat-suppression rules,
unit conversion in both mmol and mg/dL, `.env` parsing, and the Twilio
integration — the last of those run against a local stub of the Twilio API that
asserts the exact request shape, auth header and message encoding, so the SMS
path is verified without needing live credentials.

## A caveat worth stating

This is a convenience reminder built on data that can be late, wrong, or
missing — a dead phone, an expired Heroku dyno or a sensor warmup all mean no
alert arrives. Don't let it replace how you already decide on insulin, and
don't use it as a safety alarm for hypos; it deliberately stays quiet below
`MIN_BG`. Dose changes are between you and your diabetes team.
