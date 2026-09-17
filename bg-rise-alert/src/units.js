'use strict';

// Nightscout always stores sgv in mg/dL, regardless of what the site displays.
const MMOL_TO_MGDL = 18.01559;

function mgdlToMmol (mgdl) {
  return Math.round((mgdl / MMOL_TO_MGDL) * 10) / 10;
}

function mmolToMgdl (mmol) {
  return Math.round(mmol * MMOL_TO_MGDL);
}

/** Convert a stored mg/dL value into the site's display units. */
function toDisplay (mgdl, units) {
  return units === 'mmol' ? mgdlToMmol(mgdl) : Math.round(mgdl);
}

/** Convert a value expressed in display units back into mg/dL. */
function toMgdl (value, units) {
  return units === 'mmol' ? value * MMOL_TO_MGDL : value;
}

/**
 * Format a display-units value. mmol carries one decimal, mg/dL is whole.
 * `signed` prefixes a '+' so deltas read as deltas.
 */
function format (mgdl, units, signed) {
  const value = toDisplay(mgdl, units);
  const text = units === 'mmol' ? value.toFixed(1) : String(Math.round(value));
  return signed && value >= 0 ? '+' + text : text;
}

function label (units) {
  return units === 'mmol' ? 'mmol/L' : 'mg/dL';
}

module.exports = { MMOL_TO_MGDL, mgdlToMmol, mmolToMgdl, toDisplay, toMgdl, format, label };
