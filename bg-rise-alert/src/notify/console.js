'use strict';

function create () {
  return {
    name: 'console'
    , validate () { return null; }
    , async send (alert) {
      console.log('\n=== BG RISE ALERT ===\n' + alert.sms + '\n=====================\n');
      return { delivered: true };
    }
  };
}

module.exports = create;
