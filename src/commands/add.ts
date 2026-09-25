import fs from 'node:fs';
import { parseDocument, YAMLSeq, isSeq } from 'yaml';
import { CliError, type GlobalOptions } from '../cli-types.js';
import { effectiveSources, parseConfigText, resolveConfigPath, type Prefer, type SourceType } from '../config.js';
import { ResolveError, resolveSourceInput } from '../feeds/resolve.js';
import { log } from '../util.js';

export interface AddOptions extends GlobalOptions {
  name?: string;
  tags?: string[];
  type?: SourceType;
  prefer?: Prefer;
  verify?: boolean;
}

export async function add(input: string, opts: AddOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const text = fs.readFileSync(configPath, 'utf8');
  const current = parseConfigText(text, configPath);

  let resolved;
  try {
    resolved = await resolveSourceInput(input, { forceType: opts.type, prefer: opts.prefer, verify: opts.verify !== false });
  } catch (e) {
    if (e instanceof ResolveError || e instanceof TypeError) throw new CliError(e.message);
    throw e;
  }

  const existing = effectiveSources(current);
  const dupFeed = existing.find((s) => s.feedUrl === resolved.feedUrl);
  if (dupFeed) throw new CliError(`already tracked as "${dupFeed.name}" (${resolved.feedUrl})`);
  let name = opts.name ?? resolved.suggestedName;
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    if (opts.name) throw new CliError(`a source named "${name}" already exists`);
    let n = 2;
    while (existing.some((s) => s.name.toLowerCase() === `${name}-${n}`)) n++;
    name = `${name}-${n}`;
  }

  const entry: Record<string, unknown> = { name, type: resolved.type };
  if (resolved.type === 'youtube') entry.channel_id = resolved.channelId;
  else entry.url = resolved.feedUrl;
  if (opts.tags?.length) entry.tags = opts.tags;
  if (opts.prefer && resolved.type === 'podcast') entry.prefer = opts.prefer;

  // Edit the document, not a re-serialised object, so the user's comments survive.
  const doc = parseDocument(text);
  let seq = doc.get('sources', true);
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set('sources', seq);
  }
  const list = seq as YAMLSeq;
  list.flow = false;
  list.add(doc.createNode(entry));
  const updated = doc.toString({ lineWidth: 0 });
  parseConfigText(updated, configPath); // never write a config we cannot read back
  fs.writeFileSync(configPath, updated, 'utf8');

  const bits = [`added ${name} (${resolved.type}`];
  if (resolved.itemCount !== null) bits.push(`, ${resolved.itemCount} entries`);
  if (resolved.newestPublishedAt) bits.push(`, newest ${resolved.newestPublishedAt.slice(0, 10)}`);
  bits.push(')');
  process.stdout.write(`${bits.join('')}\n  feed: ${resolved.feedUrl}\n  via:  ${resolved.via}\n`);
  if (resolved.type === 'youtube') log.info('  tip: Shorts are skipped unless include_shorts: true');
  process.stdout.write(`next: summarize-watch run --dry-run\n`);
}
