import { createRequire } from 'node:module';
import { Command, Option } from 'commander';
import { CliError, type GlobalOptions } from './cli-types.js';
import { ConfigError } from './config.js';
import { log, setLogLevel, suppressSqliteExperimentalWarning, trustSystemCertificates } from './util.js';

export { CliError, type GlobalOptions } from './cli-types.js';

// Must run before any module that imports node:sqlite is evaluated. Command handlers import
// ./state.js lazily for exactly this reason.
suppressSqliteExperimentalWarning();
// Trust the OS keychain too (corporate TLS inspection); harmless elsewhere.
trustSystemCertificates();

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; description: string };

function globals(cmd: Command): GlobalOptions {
  const o = cmd.optsWithGlobals() as GlobalOptions;
  return { config: o.config, verbose: o.verbose, quiet: o.quiet };
}

const program = new Command();
program
  .name('summarize-watch')
  .description(pkg.description)
  .version(pkg.version, '-V, --version')
  .option('-c, --config <path>', 'path to watch.yaml (default: ./watch.yaml, then ~/.config/summarize-watch/watch.yaml)')
  .option('-v, --verbose', 'more progress output on stderr')
  .option('-q, --quiet', 'only warnings and errors on stderr')
  .hook('preAction', (thisCommand) => {
    const o = thisCommand.optsWithGlobals() as GlobalOptions;
    setLogLevel(o.quiet ? 'quiet' : o.verbose ? 'verbose' : 'normal');
  });

program
  .command('init')
  .description('write a starter watch.yaml and create the output and state folders')
  .option('--output <dir>', 'where notes go (default: ./notes next to watch.yaml)')
  .option('--force', 'overwrite an existing watch.yaml')
  .action(async (opts: { output?: string; force?: boolean }, cmd: Command) => {
    const { init } = await import('./commands/manage.js');
    await init({ ...globals(cmd), ...opts });
  });

program
  .command('add')
  .description('add a source: a YouTube channel/handle/video URL, a podcast feed or Apple Podcasts link, or a blog URL')
  .argument('<url>')
  .option('--name <name>', 'source name (default: derived from the feed title)')
  .option('--tags <tags>', 'comma-separated tags', (v: string) => v.split(',').map((t) => t.trim()).filter(Boolean))
  .addOption(new Option('--type <type>', 'force the source type').choices(['youtube', 'podcast', 'rss']))
  .addOption(new Option('--prefer <what>', 'podcasts: summarize the enclosure (.mp3) or the episode page').choices(['link', 'enclosure']))
  .option('--no-verify', 'skip fetching the feed once to validate it')
  .action(async (url: string, opts: Record<string, unknown>, cmd: Command) => {
    const { add } = await import('./commands/add.js');
    await add(url, { ...globals(cmd), ...opts });
  });

program
  .command('run')
  .description('poll every source, summarize new items, write notes and a digest')
  .option('--dry-run', 'show what would be processed without calling summarize')
  .option('--source <name>', 'only this source')
  .option('--limit <n>', 'process at most n items this run', (v: string) => parsePositiveInt(v, '--limit'))
  .action(async (opts: { dryRun?: boolean; source?: string; limit?: number }, cmd: Command) => {
    const { run } = await import('./commands/run.js');
    await run({ ...globals(cmd), ...opts });
  });

program
  .command('retry')
  .description('reset failed items so the next run tries them again')
  .option('--all', 'every failed item')
  .option('--id <ids...>', 'specific item ids (also un-skips skipped items)', (v: string, prev: number[] = []) => [...prev, parsePositiveInt(v, '--id')])
  .option('--source <name>', 'every failed item of one source')
  .action(async (opts: { all?: boolean; id?: number[]; source?: string }, cmd: Command) => {
    const { retry } = await import('./commands/manage.js');
    await retry({ ...globals(cmd), ...opts });
  });

program
  .command('list')
  .description('show tracked items')
  .option('--failed', 'only failed items')
  .addOption(new Option('--status <status>', 'filter by status').choices(['pending', 'done', 'failed', 'skipped']))
  .option('--source <name>', 'only this source')
  .option('--limit <n>', 'max rows (default 50)', (v: string) => parsePositiveInt(v, '--limit'))
  .option('--json', 'machine-readable output')
  .action(async (opts: { failed?: boolean; status?: string; source?: string; limit?: number; json?: boolean }, cmd: Command) => {
    const { list } = await import('./commands/manage.js');
    await list({ ...globals(cmd), ...opts });
  });

program
  .command('doctor')
  .description('check summarize, Node, folders, feeds and (for ollama/ models) the Ollama server')
  .action(async (_opts: Record<string, never>, cmd: Command) => {
    const { doctor } = await import('./commands/doctor.js');
    await doctor(globals(cmd));
  });

function parsePositiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`${flag} expects a positive integer, got "${v}"`, 2);
  return n;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(e.message);
      process.exitCode = 1;
      return;
    }
    if (e instanceof CliError) {
      log.error(`error: ${e.message}`);
      process.exitCode = e.exitCode;
      return;
    }
    const err = e as Error;
    log.error(`error: ${err.message}`);
    if ((program.opts() as GlobalOptions).verbose && err.stack) log.error(err.stack);
    process.exitCode = 1;
  }
}

await main();
