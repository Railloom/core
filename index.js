// @railloom/core — placeholder release.
// v0.1 is in active development. Track the release at https://github.com/Railloom/core
//
// This package currently exports nothing useful. It is published to claim the
// `@railloom/core` namespace on npm; once v0.1 ships, this file is replaced by
// the real entry point. Importing this placeholder is a no-op (with a one-time
// console warning) — calls to any specific export will fail with an undefined
// reference, which is the behavior you want for an early adopter.

let warned = false;
function warnOnce() {
  if (warned || typeof process === 'undefined' || process.env?.RAILLOOM_SILENCE_PLACEHOLDER) {
    return;
  }
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[@railloom/core] Placeholder release imported. v0.1 is in development; ' +
    'see https://github.com/Railloom/core for status. Set RAILLOOM_SILENCE_PLACEHOLDER=1 to silence.',
  );
}

warnOnce();

export {};
