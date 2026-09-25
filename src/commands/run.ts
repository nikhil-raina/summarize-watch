import type { GlobalOptions } from '../cli-types.js';
import { CliError } from '../cli-types.js';
import { loadConfig } from '../config.js';
import { RunFatalError, renderReport, runOnce } from '../runner.js';
import { log } from '../util.js';

export async function run(opts: GlobalOptions & { dryRun?: boolean; source?: string; limit?: number }): Promise<void> {
  const loaded = loadConfig(opts.config);
  const { openState } = await import('../state.js');
  const state = openState(loaded.paths.dbPath);

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    interrupts++;
    if (interrupts === 1) {
      log.warn(`\n${sig} received: stopping after the current item (press again to force quit)`);
      controller.abort();
    } else {
      process.exit(sig === 'SIGINT' ? 130 : 143);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const report = await runOnce(loaded, state, { dryRun: opts.dryRun, sourceFilter: opts.source, limit: opts.limit, signal: controller.signal });
    process.stdout.write(`${renderReport(report)}\n`);
    if (report.aborted) process.exitCode = 130;
  } catch (e) {
    if (e instanceof RunFatalError) throw new CliError(e.message);
    throw e;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    state.close();
  }
}
