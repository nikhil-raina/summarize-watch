#!/usr/bin/env node
// Silence Node's "SQLite is an experimental feature" warning on Node 22 before
// anything imports node:sqlite. Every other warning passes through untouched.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, ...rest) {
  const first = rest[0];
  const type = typeof first === 'string' ? first : first?.type ?? warning?.name;
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

await import('../dist/cli.js');
