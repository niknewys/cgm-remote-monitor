'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env loader, so the project keeps its zero-dependency promise.
 * Real environment variables always win, which keeps `VAR=x node ...` and
 * hosted config working over whatever is in the file.
 */
function load (file) {
  const target = file || path.join(__dirname, '..', '.env');

  let contents;
  try {
    contents = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[env] could not read ' + target + ' (' + err.message + ')');
    }
    return {};
  }

  const loaded = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();

    // Strip matching quotes; only then is an inline # part of the value.
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash > -1) value = value.slice(0, hash).trim();
    }

    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return loaded;
}

module.exports = { load };
