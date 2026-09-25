import type { GlobalOptions } from '../cli-types.js';

// Implemented in a later phase.
export async function add(..._args: unknown[]): Promise<void> {
  void (null as unknown as GlobalOptions);
  throw new Error('`summarize-watch add` is not implemented yet');
}
