import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DURATION_RE, parseDuration, resolvePath } from './util.js';

export const CONFIG_FILENAME = 'watch.yaml';
export const SOURCE_TYPES = ['youtube', 'podcast', 'rss'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const CLI_PROVIDERS = ['claude', 'codex', 'gemini', 'agent', 'openclaw', 'opencode', 'copilot', 'agy', 'pi'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];
export type Prefer = 'link' | 'enclosure';
export type TranscriptMode = 'media' | 'all' | 'none' | 'inline';

// ---------- schema ----------

const Duration = z.string().regex(DURATION_RE, 'expected a duration like 30s, 2m, 10m, 1h, 3d');
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const Since = z.union([
  z.literal('first_run'),
  z.literal('all'),
  z.string().regex(ISO_DATE_RE, 'expected first_run, all, an ISO date, or a duration like 14d'),
  Duration,
]);
const SourceName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'letters, digits, dot, underscore and dash only (max 64 chars)');

const SummarizeSettings = z
  .object({
    bin: z.string().min(1).default('summarize'),
    model: z.string().min(1).nullable().default(null),
    cli: z.enum(CLI_PROVIDERS).nullable().default(null),
    language: z.string().min(1).nullable().default(null),
    length: z.string().min(1).nullable().default(null),
    prompt: z.string().min(1).nullable().default(null),
    timeout: Duration.default('15m'),
    no_cache: z.boolean().default(false),
    extra_args: z.array(z.string()).default([]),
  })
  .strict();

const SourceSchema = z
  .object({
    name: SourceName,
    type: z.enum(SOURCE_TYPES),
    url: z.string().url().optional(),
    channel_id: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/, 'channel_id must look like UCxxxxxxxxxxxxxxxxxxxxxx').optional(),
    enabled: z.boolean().default(true),
    tags: z.array(z.string().min(1)).default([]),
    include_shorts: z.boolean().optional(),
    prefer: z.enum(['link', 'enclosure']).optional(),
    max_per_source: z.number().int().positive().optional(),
    since: Since.optional(),
    backfill: z.number().int().min(0).optional(),
    // summarize overrides (same keys as `summarize:`, all optional)
    bin: z.string().min(1).optional(),
    model: z.string().min(1).nullable().optional(),
    cli: z.enum(CLI_PROVIDERS).nullable().optional(),
    language: z.string().min(1).nullable().optional(),
    length: z.string().min(1).nullable().optional(),
    prompt: z.string().min(1).nullable().optional(),
    timeout: Duration.optional(),
    no_cache: z.boolean().optional(),
    extra_args: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.type === 'youtube' && !s.channel_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channel_id'], message: 'youtube sources need channel_id (use `summarize-watch add <channel url>`)' });
    }
    if (s.type !== 'youtube' && !s.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: `${s.type} sources need url` });
    }
    if (s.model && s.cli) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cli'], message: 'set either model or cli, not both' });
    }
  });

export const ConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    output: z
      .object({
        dir: z.string().min(1),
        digests_subdir: z.string().min(1).default('digests'),
        transcripts: z
          .object({
            mode: z.enum(['media', 'all', 'none', 'inline']).default('media'),
            subdir: z.string().min(1).default('transcripts'),
          })
          .strict()
          .default({}),
      })
      .strict(),
    state_dir: z.string().min(1).default('./state'),
    summarize: SummarizeSettings.default({}),
    run: z
      .object({
        concurrency: z.number().int().min(1).max(16).default(1),
        max_per_run: z.number().int().min(1).default(20),
        max_per_source: z.number().int().min(1).default(5),
        since: Since.default('first_run'),
        backfill: z.number().int().min(0).default(3),
        feed_timeout: Duration.default('20s'),
        short_content_chars: z.number().int().min(0).default(1500),
        backoff: z.array(Duration).min(1).default(['1h', '6h', '24h', '72h']),
        max_attempts: z.number().int().min(1).default(5),
        shorts_probe: z.boolean().default(true),
      })
      .strict()
      .default({}),
    defaults: z
      .object({
        tags: z.array(z.string().min(1)).default(['summarize-watch']),
        include_shorts: z.boolean().default(false),
        prefer: z.enum(['link', 'enclosure']).default('enclosure'),
      })
      .strict()
      .default({}),
    sources: z.array(SourceSchema).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.summarize.model && cfg.summarize.cli) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['summarize', 'cli'], message: 'set either summarize.model or summarize.cli, not both' });
    }
    const names = new Map<string, number>();
    const feeds = new Map<string, number>();
    cfg.sources.forEach((s, i) => {
      const key = s.name.toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', i, 'name'], message: `duplicate source name "${s.name}" (also at sources[${names.get(key)}])` });
      names.set(key, i);
      const feed = feedUrlFor(s.type, s.url, s.channel_id);
      if (feeds.has(feed)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', i], message: `duplicate feed ${feed} (also at sources[${feeds.get(feed)}])` });
      feeds.set(feed, i);
    });
  });

export type Config = z.infer<typeof ConfigSchema>;
export type SourceConfig = Config['sources'][number];

// ---------- effective (merged) settings ----------

export interface EffectiveSummarize {
  bin: string;
  model: string | null;
  cli: CliProvider | null;
  language: string | null;
  length: string | null;
  prompt: string | null;
  /** as written in the yaml, e.g. "15m" (passed through to `summarize --timeout`) */
  timeout: string;
  timeoutMs: number;
  noCache: boolean;
  extraArgs: string[];
}

export interface EffectiveSource {
  name: string;
  type: SourceType;
  feedUrl: string;
  channelId: string | null;
  enabled: boolean;
  tags: string[];
  includeShorts: boolean;
  prefer: Prefer;
  maxPerSource: number;
  since: string;
  backfill: number;
  summarize: EffectiveSummarize;
}

export interface ConfigPaths {
  configPath: string;
  configDir: string;
  outputDir: string;
  digestsDir: string;
  transcriptsDir: string;
  stateDir: string;
  dbPath: string;
  lastInvalidPath: string;
}

export interface LoadedConfig {
  config: Config;
  sources: EffectiveSource[];
  paths: ConfigPaths;
}

export function feedUrlFor(type: SourceType, url: string | undefined, channelId: string | undefined): string {
  if (type === 'youtube') return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId ?? ''}`;
  return url ?? '';
}

export function effectiveSources(config: Config): EffectiveSource[] {
  const base = config.summarize;
  return config.sources.map((s) => {
    const timeout = s.timeout ?? base.timeout;
    const model = s.model !== undefined ? s.model : base.model;
    const cli = s.cli !== undefined ? s.cli : base.cli;
    const tags = uniq([...config.defaults.tags, s.type, ...s.tags]);
    return {
      name: s.name,
      type: s.type,
      feedUrl: feedUrlFor(s.type, s.url, s.channel_id),
      channelId: s.channel_id ?? null,
      enabled: s.enabled,
      tags,
      includeShorts: s.include_shorts ?? config.defaults.include_shorts,
      prefer: s.prefer ?? config.defaults.prefer,
      maxPerSource: s.max_per_source ?? config.run.max_per_source,
      since: s.since ?? config.run.since,
      backfill: s.backfill ?? config.run.backfill,
      summarize: {
        bin: s.bin ?? base.bin,
        model: cli ? null : model,
        cli,
        language: s.language !== undefined ? s.language : base.language,
        length: s.length !== undefined ? s.length : base.length,
        prompt: s.prompt !== undefined ? s.prompt : base.prompt,
        timeout,
        timeoutMs: parseDuration(timeout),
        noCache: s.no_cache ?? base.no_cache,
        extraArgs: s.extra_args ?? base.extra_args,
      },
    };
  });
}

export function configPaths(config: Config, configPath: string): ConfigPaths {
  const configDir = path.dirname(configPath);
  const outputDir = resolvePath(config.output.dir, configDir);
  const stateDir = resolvePath(config.state_dir, configDir);
  return {
    configPath,
    configDir,
    outputDir,
    digestsDir: path.join(outputDir, config.output.digests_subdir),
    transcriptsDir: path.join(outputDir, config.output.transcripts.subdir),
    stateDir,
    dbPath: path.join(stateDir, 'watch.sqlite'),
    lastInvalidPath: path.join(stateDir, 'last-invalid.json'),
  };
}

// ---------- loading ----------

export class ConfigError extends Error {
  constructor(message: string, public readonly configPath?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function defaultUserConfigPath(): string {
  return path.join(os.homedir(), '.config', 'summarize-watch', CONFIG_FILENAME);
}

/** --config wins; then ./watch.yaml; then ~/.config/summarize-watch/watch.yaml. */
export function resolveConfigPath(explicit?: string, cwd: string = process.cwd()): string {
  if (explicit) return resolvePath(explicit, cwd);
  const candidates = [path.join(cwd, CONFIG_FILENAME), defaultUserConfigPath()];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new ConfigError(
    `No ${CONFIG_FILENAME} found. Looked in:\n  ${candidates.join('\n  ')}\nRun \`summarize-watch init\` or pass --config <path>.`,
  );
}

export function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

export function parseConfigText(text: string, configPath: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`${configPath}: invalid YAML: ${(e as Error).message}`, configPath);
  }
  if (raw === null || raw === undefined) raw = {};
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${configPath}: invalid config\n${formatZodIssues(parsed.error)}`, configPath);
  }
  return parsed.data;
}

export function loadConfig(explicit?: string, cwd: string = process.cwd()): LoadedConfig {
  const configPath = resolveConfigPath(explicit, cwd);
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read ${configPath}: ${(e as Error).message}`, configPath);
  }
  const config = parseConfigText(text, configPath);
  return { config, sources: effectiveSources(config), paths: configPaths(config, configPath) };
}

// ---------- starter file ----------

export function renderStarterConfig(opts: { outputDir: string; model?: string | null }): string {
  const model = opts.model === undefined ? 'ollama/qwen3:14b' : opts.model;
  const modelLine = model ? `  model: ${model}` : `  model: null`;
  return `# summarize-watch configuration
# Docs: https://github.com/nikhil-raina/summarize-watch#configuration
version: 1

output:
  dir: ${yamlScalar(opts.outputDir)}      # notes land here (an Obsidian vault folder works well)
  digests_subdir: digests                 # <dir>/digests/YYYY-MM-DD.md, one section per run
  transcripts:
    mode: media                           # media = sibling transcript file for youtube/podcast only
                                          # all | none | inline (appended to the note)
    subdir: transcripts

state_dir: ./state                        # relative to this file; SQLite state + last-invalid.json

summarize:
  bin: summarize                          # name on PATH or an absolute path
${modelLine}                    # any summarize model id: ollama/<tag>, openai/gpt-5-mini, anthropic/..., auto, free
  cli: null                               # or reuse a coding-CLI login: claude | codex | gemini (mutually exclusive with model)
  language: null                          # null = summarize's own default; e.g. en, de, hindi
  length: null                            # short | medium | long | xl | xxl | 20k
  prompt: null                            # replaces summarize's built-in instructions when set
  timeout: 15m                            # per item; a local 14B model on a 2-hour podcast is slow
  no_cache: false
  extra_args: []                          # appended verbatim to every summarize call

run:
  concurrency: 1                          # keep 1 for a local Ollama model; 2-3 for API models
  max_per_run: 20                         # global cap per run (cost/time control)
  max_per_source: 5
  since: first_run                        # first_run | all | 2026-09-01 | 14d — older items are skipped, never summarized
  backfill: 3                             # on a source's first poll, its newest N items are summarized regardless of since
  feed_timeout: 20s
  short_content_chars: 1500               # pages shorter than this are filed verbatim instead of summarized
  backoff: [1h, 6h, 24h, 72h]             # retry delays after failures; failures are never permanent
  max_attempts: 5                         # after this many, an item shows as "gave up" until \`retry\`
  shorts_probe: true                      # detect YouTube Shorts via a redirect probe

defaults:                                 # per-source overridable
  tags: [summarize-watch]
  include_shorts: false
  prefer: enclosure                       # podcasts: enclosure (the .mp3) | link (the episode page)

# Add sources with:  summarize-watch add <youtube channel | podcast feed | apple podcasts link | blog url>
sources: []
#  - name: veritasium
#    type: youtube
#    channel_id: UCHnyfMqiRRG1u-2MsSQLbXA
#    tags: [science]
#  - name: acquired
#    type: podcast
#    url: https://feeds.transistor.fm/acquired
#  - name: simonw
#    type: rss
#    url: https://simonwillison.net/atom/everything/
#    max_per_source: 3
`;
}

function yamlScalar(s: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(s) ? s : JSON.stringify(s);
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
