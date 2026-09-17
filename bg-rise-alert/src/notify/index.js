'use strict';

const factories = {
  console: require('./console')
  , twilio: require('./twilio')
  , pushover: require('./pushover')
  , webhook: require('./webhook')
};

/**
 * Build the configured notifiers. Anything misconfigured is reported up front
 * rather than at 2am when a rise finally happens.
 */
function build (cfg, opts) {
  const notifiers = [];
  const problems = [];

  for (const name of cfg.notifiers) {
    const factory = factories[name];
    if (!factory) {
      problems.push('unknown notifier "' + name + '" (choose from: ' + Object.keys(factories).join(', ') + ')');
      continue;
    }
    const notifier = factory(cfg, opts);
    const problem = notifier.validate();
    if (problem) problems.push(problem);
    else notifiers.push(notifier);
  }

  return { notifiers, problems };
}

/** Deliver to every notifier; one failing channel must not silence the rest. */
async function sendAll (notifiers, alert) {
  const outcomes = await Promise.allSettled(notifiers.map(n => n.send(alert)));

  return outcomes.map((outcome, index) => ({
    name: notifiers[index].name
    , ok: outcome.status === 'fulfilled'
    , error: outcome.status === 'rejected' ? outcome.reason.message : null
  }));
}

module.exports = { build, sendAll, factories };
