import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError, type GlobalOptions } from '../cli-types.js';
import { loadConfig } from '../config.js';
import { fetchText } from '../feeds/fetch.js';
import { parseFeed } from '../feeds/parse.js';
import { isOllamaModel, ollamaStatus, ollamaTag } from '../ollama.js';
import { MIN_SUMMARIZE_VERSION, checkSummarizeVersion, classify, runSummarize } from '../summarizer.js';
import { parseDuration, trustSystemCertificates } from '../util.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';

const MARK: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };

export async function doctor(opts: GlobalOptions): Promise<void> {
  const lines: Array<{ level: Level; text: string }> = [];
  const say = (level: Level, text: string) => {
    lines.push({ level, text });
    process.stdout.write(`${MARK[level]} ${text}\n`);
  };

  // 1. node
  const [major, minor] = process.versions.node.split('.').map(Number);
  if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13)) {
    say((major ?? 0) >= 24 ? 'ok' : 'warn', `node ${process.versions.node}${(major ?? 0) < 24 ? ' (works; 24 recommended, and quieter about SQLite)' : ''}`);
  } else {
    say('fail', `node ${process.versions.node} is too old; need >= 22.13 (nvm install 24)`);
  }
  try {
    await import('node:sqlite');
    say('ok', 'node:sqlite available');
  } catch {
    say('fail', 'node:sqlite is not available in this Node build');
  }

  const ca = trustSystemCertificates();
  if (ca.skipped) say('info', 'system CA certificates: disabled by SUMMARIZE_WATCH_NO_SYSTEM_CA');
  else if (!ca.supported) say('info', 'system CA certificates: this Node cannot merge the OS keychain; behind a TLS-inspecting proxy use NODE_USE_SYSTEM_CA=1 or NODE_EXTRA_CA_CERTS');
  else say('ok', `system CA certificates: ${ca.added ? `${ca.added} added from the OS keychain` : 'none needed'}`);

  // 2. config
  let loaded;
  try {
    loaded = loadConfig(opts.config);
  } catch (e) {
    say('fail', (e as Error).message);
    throw new CliError('doctor found problems', 1);
  }
  const { config, sources, paths } = loaded;
  say('ok', `config ${paths.configPath} · ${sources.length} source${sources.length === 1 ? '' : 's'} (${sources.filter((s) => s.enabled).length} enabled)`);
  if (!config.summarize.model && !config.summarize.cli) {
    say('warn', 'neither summarize.model nor summarize.cli is set: summarize will use its own default from ~/.summarize/config.json');
  } else {
    say('info', `model ${config.summarize.cli ? `cli/${config.summarize.cli}` : config.summarize.model} · timeout ${config.summarize.timeout} · concurrency ${config.run.concurrency} · since ${config.run.since} · backfill ${config.run.backfill}`);
  }

  // 3. summarize binary
  const bins = new Set(sources.map((s) => s.summarize.bin));
  if (!bins.size) bins.add(config.summarize.bin);
  let anyBinOk = false;
  for (const bin of bins) {
    const v = await checkSummarizeVersion(bin);
    if (v.ok) {
      anyBinOk = true;
      say('ok', `summarize ${v.version} (${bin})`);
    } else say('fail', `summarize: ${v.error} (need >= ${MIN_SUMMARIZE_VERSION})`);
  }

  // 4. folders and db
  for (const [label, dir] of [['notes', paths.outputDir], ['digests', paths.digestsDir], ['transcripts', paths.transcriptsDir], ['state', paths.stateDir]] as const) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.summarize-watch-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      say('ok', `${label} dir writable · ${dir}`);
    } catch (e) {
      say('fail', `${label} dir not writable · ${dir}: ${(e as Error).message}`);
    }
  }
  try {
    const { openState } = await import('../state.js');
    const state = openState(paths.dbPath);
    const counts = state.countByStatus();
    const running = state.findRunningRun();
    say('ok', `state db ${paths.dbPath} · schema v${state.schemaVersion()} · ${counts.pending} pending · ${counts.done} done · ${counts.failed} failed · ${counts.skipped} skipped`);
    if (running) say('info', `a run appears to be in progress (run #${running.id}, pid ${running.pid}, started ${running.startedAt})`);
    state.close();
  } catch (e) {
    say('fail', `state db: ${(e as Error).message}`);
  }

  // 5. extraction smoke (no model call)
  if (anyBinOk) {
    const bin = [...bins][0] as string;
    const raw = await runSummarize({ bin, args: ['https://example.com', '--extract', '--json', '--format', 'md', '--timeout', '15s'], timeoutMs: 25_000 });
    const outcome = classify(raw, { shortContentChars: 1500 });
    const looksRight = outcome.kind === 'short_verbatim' && (outcome.envelope.extracted.title === 'Example Domain' || /example/i.test(outcome.envelope.extracted.content));
    if (looksRight) {
      say('ok', `summarize --extract --json works (${Math.round(raw.durationMs / 100) / 10}s, envelope validated)`);
    } else if (outcome.kind === 'short_verbatim' || outcome.kind === 'summarized' || outcome.kind === 'not_summarized') {
      say('warn', `summarize ran but example.com content looked unexpected (${outcome.kind})`);
    } else {
      say('fail', `summarize smoke test: ${outcome.kind} · ${'error' in outcome ? outcome.error : ''}`);
    }
  }

  // 6. feeds
  const feedTimeout = parseDuration(config.run.feed_timeout);
  for (const s of sources.filter((x) => x.enabled)) {
    try {
      const res = await fetchText(s.feedUrl, { timeoutMs: feedTimeout });
      const parsed = parseFeed(res.text, { type: s.type, prefer: s.prefer });
      const newest = parsed.items.map((i) => i.publishedAt).filter(Boolean).sort().at(-1);
      say('ok', `feed ${s.name} · ${parsed.items.length} entries${newest ? ` · newest ${String(newest).slice(0, 10)}` : ''}`);
    } catch (e) {
      say('fail', `feed ${s.name} · ${(e as Error).message}`);
    }
  }
  if (!sources.length) say('warn', 'no sources yet: summarize-watch add <url>');

  // 7. ollama (only when any source uses an ollama/ model)
  const ollamaModels = new Set(sources.map((s) => s.summarize.model).filter(isOllamaModel));
  if (!sources.length && isOllamaModel(config.summarize.model)) ollamaModels.add(config.summarize.model);
  if (ollamaModels.size) {
    const st = await ollamaStatus();
    if (!st.reachable) {
      say('fail', `ollama not reachable: ${st.error} (is Ollama.app running? set OLLAMA_BASE_URL for a remote server)`);
    } else {
      say('ok', `ollama ${st.version} reachable · ${st.tags.length} model${st.tags.length === 1 ? '' : 's'} pulled`);
      for (const model of ollamaModels) {
        const tag = ollamaTag(model);
        const present = st.tags.includes(tag) || st.tags.includes(`${tag}:latest`);
        if (!present) say('fail', `model ${tag} is not pulled (ollama pull ${tag})`);
        else say('ok', `model ${tag} present`);
        const loaded = st.loaded.find((m) => m.name === tag || m.name === `${tag}:latest`);
        if (loaded) {
          const ctx = loaded.contextLength;
          if (ctx !== null && ctx < 16384) say('warn', `${tag} is loaded with a ${ctx}-token context; long transcripts will be cut. Raise it (see README → Ollama).`);
          else say('ok', `${tag} loaded · context ${ctx ?? 'unknown'}`);
        } else {
          say('info', `${tag} not loaded right now; the runner warms it up before the first item (context is checked then via \`ollama ps\`)`);
        }
      }
    }
  }

  // 8. transcription path (podcasts and caption-less videos need one)
  const needsTranscription = sources.some((s) => s.enabled && s.type === 'podcast');
  const cloudKeys = ['GROQ_API_KEY', 'ASSEMBLYAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY', 'DEEPGRAM_API_KEY'].filter((k) => process.env[k]);
  const onnx = ['SUMMARIZE_ONNX_PARAKEET_CMD', 'SUMMARIZE_ONNX_CANARY_CMD'].filter((k) => process.env[k]);
  const whisperBin = process.env.SUMMARIZE_WHISPER_CPP_BINARY ?? 'whisper-cli';
  const whisperOnPath = which(whisperBin);
  const whisperModel = process.env.SUMMARIZE_WHISPER_CPP_MODEL_PATH ?? path.join(os.homedir(), '.summarize', 'cache', 'whisper-cpp', 'models', 'ggml-base.bin');
  const whisperModelPresent = fs.existsSync(whisperModel);
  const routes: string[] = [];
  if (cloudKeys.length) routes.push(`cloud (${cloudKeys.join(', ')})`);
  if (onnx.length) routes.push('local ONNX');
  if (whisperOnPath && whisperModelPresent) routes.push('local whisper.cpp');
  if (whisperOnPath && !whisperModelPresent) say('warn', `whisper-cli is installed but its model is missing: ${whisperModel} (summarize does not download it; see README → Podcasts)`);
  if (routes.length) say('ok', `transcription available via ${routes.join(', ')}`);
  else if (needsTranscription) say('warn', 'no transcription route: podcast episodes without published transcripts will fail. Local: brew install whisper-cpp + download a ggml model (README → Podcasts). Cloud: set GROQ_API_KEY or OPENAI_API_KEY (see `summarize transcriber help`).');
  else say('info', 'no transcription route configured (only needed for podcasts and videos without captions)');

  // 9. optional media tools
  for (const tool of ['ffmpeg', 'yt-dlp']) {
    say(which(tool) ? 'ok' : 'info', `${tool} ${which(tool) ? 'on PATH' : 'not on PATH (optional; summarize bundles a WebAssembly ffmpeg, yt-dlp helps with tricky videos)'}`);
  }

  const fails = lines.filter((l) => l.level === 'fail').length;
  const warns = lines.filter((l) => l.level === 'warn').length;
  process.stdout.write(`\n${fails ? `${fails} problem${fails === 1 ? '' : 's'}` : 'all good'}${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''}\n`);
  if (fails) throw new CliError('doctor found problems', 1);
}

function which(tool: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
