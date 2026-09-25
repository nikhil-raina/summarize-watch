# summarize-watch

Follow YouTube channels, podcasts and blogs. Every new item is summarized by the
[`summarize`](https://github.com/steipete/summarize) CLI and filed as a markdown note in a folder
you choose (an Obsidian vault works well), with a daily digest of everything that landed.

```console
$ summarize-watch add @veritasium --tags science
added veritasium (youtube, 15 entries, newest 2026-09-24)

$ summarize-watch add https://podcasts.apple.com/us/podcast/acquired/id1050462261
added acquired (podcast, 217 entries, newest 2026-09-14)

$ summarize-watch run
[warm ] loading ollama/qwen3:14b into Ollama…
[warm ] ollama/qwen3:14b ready in 4s
[start] veritasium · The Insane Real Engineering of the Nazi Enigma Machine
[done ] veritasium · The Insane Real Engineering of the Nazi Enigma Machine · 11.4k tok · 1m 24s → 2026-09-21 the insane real engineering of the nazi enigma machine.md
summarize-watch run #1 · 2026-09-25 16:30 → 16:32 (1m 30s)
sources  2 polled
items    18 discovered (4 pending, 13 skipped:shorts, 1 skipped:before_since) · 4 processed → 4 done · 0 failed
tokens   38,120 prompt / 4,980 completion · ollama/qwen3:14b
digest   ~/Vault/Summaries/digests/2026-09-25.md
```

`summarize` does the hard part (fetching, transcripts, model calls, its own cache). summarize-watch
adds what it deliberately leaves out: sources to follow, a memory of what has been processed,
retries, notes and a digest. It runs when you tell it to (or when cron/launchd does); there is no
daemon and nothing leaves your machine that `summarize` would not already send.

## Requirements

- [`summarize`](https://summarize.sh) >= 0.23 — `brew install summarize` (brings ffmpeg and yt-dlp
  along) or `npm i -g @steipete/summarize` (needs Node 24).
- Node >= 22.13 (24 recommended; 22 prints a harmless SQLite "experimental" warning once).
- A model `summarize` can talk to: a local [Ollama](https://ollama.com) model, an API key in
  `~/.summarize/config.json`, or a coding-CLI login reused via `cli: claude|codex|gemini`.

## Install

```bash
npm i -g summarize-watch        # or: npx summarize-watch <command>
```

## Quick start

```bash
mkdir ~/watch && cd ~/watch
summarize-watch init --output ~/Vault/Summaries   # writes watch.yaml, creates folders
summarize-watch add @veritasium                    # YouTube handle, channel or video URL
summarize-watch add https://podcasts.apple.com/us/podcast/acquired/id1050462261
summarize-watch add https://simonwillison.net/     # blogs: the feed is autodiscovered
summarize-watch doctor                             # checks summarize, folders, feeds, Ollama
summarize-watch run --dry-run                      # what would happen, with the exact commands
summarize-watch run                                # do it
```

The first run of a source summarizes its newest `backfill` items (default 3) so you see results
immediately; older items are marked `before_since` and never summarized. After that, only items
newer than the source's first poll are picked up.

## Configuration

`watch.yaml` (found in the current directory, then `~/.config/summarize-watch/watch.yaml`, or pass
`--config`). Everything below is optional except `output.dir`; the values shown are the defaults.

```yaml
version: 1
output:
  dir: ~/Vault/Summaries          # notes go here
  digests_subdir: digests         # <dir>/digests/YYYY-MM-DD.md, one section per run
  transcripts:
    mode: media                   # media = transcript file for youtube/podcast only · all · none · inline
    subdir: transcripts
state_dir: ./state                # relative to watch.yaml; SQLite state + last-invalid.json

summarize:
  bin: summarize                  # name on PATH or absolute path
  model: ollama/qwen3:14b         # any summarize model id; null = summarize's own default
  cli: null                       # claude | codex | gemini … reuses that CLI's login (mutually exclusive with model)
  language: null                  # e.g. en, de, hindi; null = summarize's default (matches the source)
  length: null                    # short | medium | long | xl | xxl | 20k
  prompt: null                    # replaces summarize's built-in instructions
  timeout: 15m                    # per item, passed to summarize --timeout
  no_cache: false
  extra_args: []                  # appended verbatim to every summarize call

run:
  concurrency: 1                  # keep 1 for a local model; 2–3 for API models
  max_per_run: 20                 # cost/time cap per run
  max_per_source: 5
  since: first_run                # first_run | all | 2026-09-01 | 14d
  backfill: 3                     # newest N per source on its first poll, regardless of since
  feed_timeout: 20s
  short_content_chars: 1500       # shorter pages are filed verbatim instead of summarized
  backoff: [1h, 6h, 24h, 72h]     # retry delays; failures are never permanent
  max_attempts: 5                 # then the item shows as "gave up" until `retry`
  shorts_probe: true              # detect YouTube Shorts the feed does not flag

defaults:                         # overridable per source
  tags: [summarize-watch]
  include_shorts: false
  prefer: enclosure               # podcasts: enclosure (the audio file) | link (the episode page)

sources:
  - name: veritasium
    type: youtube
    channel_id: UCHnyfMqiRRG1u-2MsSQLbXA
    tags: [science]
    model: ollama/gemma3:12b      # any summarize.* key can be overridden per source
  - name: acquired
    type: podcast
    url: https://feeds.transistor.fm/acquired
    max_per_source: 2
  - name: simonw
    type: rss
    url: https://simonwillison.net/atom/everything/
    enabled: true
```

`summarize-watch add` edits this file for you and keeps your comments.

## What you get

One note per item, named `YYYY-MM-DD <title>.md`, with frontmatter Obsidian's Dataview/Bases
can query:

```yaml
---
title: The Insane Real Engineering of the Nazi Enigma Machine
source: veritasium
source_type: youtube
url: https://www.youtube.com/watch?v=JsBZOcqZerk
published: 2026-09-21T17:49:57.000Z
summarized_at: 2026-09-25T23:30:11.348Z
summarized: true
model: ollama/qwen3:14b
provider: ollama
tokens_prompt: 11400
tokens_completion: 1251
duration_seconds: 2861
transcript_source: captionTracks
transcript: transcripts/2026-09-21 the insane real engineering of the nazi enigma machine.md
tags: [summarize-watch, youtube, science]
summarize_watch_id: 2
---
```

The body is the summary exactly as `summarize` produced it. For YouTube and podcasts the full
transcript sits next to it in `transcripts/` (`transcripts.mode` controls this). Each run appends
a section to `digests/YYYY-MM-DD.md` with one line per note, a list of failures with the retry
time, and totals.

## Commands

| Command | What it does |
|---|---|
| `init [--output <dir>] [--force]` | write a starter `watch.yaml`, create folders |
| `add <url> [--name n] [--tags a,b] [--type youtube\|podcast\|rss] [--prefer link\|enclosure] [--no-verify]` | resolve a channel/handle/video URL, Apple Podcasts link, feed URL or blog page; verify it; append to `watch.yaml` |
| `run [--dry-run] [--source <name>] [--limit n]` | poll, summarize, write notes and digest |
| `retry [--all] [--id <n>…] [--source <name>]` | put failed items back in the queue (`--id` also un-skips) |
| `list [--failed] [--status s] [--source n] [--limit n] [--json]` | tracked items and their state |
| `doctor` | node, `summarize` version, folders, database, an extraction smoke test, every feed, Ollama |

Global: `-c/--config <path>`, `-v/--verbose`, `-q/--quiet`. Results go to stdout, progress to
stderr. Exit code 0 on success, 1 on failure, 130 when interrupted.

## Scheduling

There is no daemon by design. Pick one:

- **macOS launchd** — [`examples/launchd/sh.summarize-watch.plist`](examples/launchd/sh.summarize-watch.plist)
  runs at 03:00 with an explicit PATH (launchd does not read your shell profile, so nvm's bin and
  Homebrew are spelled out).
- **cron** — [`examples/cron.txt`](examples/cron.txt).
- **systemd user timer** — [`examples/systemd/`](examples/systemd/).

Overlapping runs are refused (a run that is still going holds a marker in the database), so a slow
night cannot pile up. Ctrl-C stops after the item in flight; nothing is marked failed, and the next
run resumes where it left off.

## Failures and retries

Anything that goes wrong with an item (no captions yet, YouTube blocking, a model timing out, a
changed `summarize` output) marks it `failed` and schedules a retry: 1h, then 6h, 24h, 72h, until
`max_attempts`. Nothing is ever dropped automatically; `summarize-watch list --failed` shows what is
waiting and why, `retry --all` clears the slate. If `summarize`'s JSON output ever changes shape,
the raw output is saved to `state/last-invalid.json` and the item retries later.

## Cost and models

- **Ollama (default in the starter config)**: free and local. `summarize`'s own guide recommends
  12B+ models for transcripts (`ollama pull qwen3:14b`). Long transcripts need a large context
  window; recent Ollama picks 32k automatically on machines with enough memory. Check with
  `ollama ps` (CONTEXT column) after a run; `doctor` warns below 16k. To force it:
  `printf 'FROM qwen3:14b\nPARAMETER num_ctx 32768\n' > Modelfile && ollama create qwen3-32k -f Modelfile`,
  then use `model: ollama/qwen3-32k`. summarize-watch warms the model up before each run so a cold
  start does not fail the first item.
- **API models**: real money per token. A one-hour podcast is roughly 15–20k prompt tokens.
  `max_per_run`, `max_per_source`, `since` and `backfill` are your caps, and `summarize`'s cache
  makes re-runs of the same URL free.
- **`cli: claude|codex|gemini`**: reuses a subscription you already pay for, adds a few seconds per
  item.

## Podcasts need a transcriber

YouTube usually has captions, so videos work with nothing but a model. Podcast audio has to be
transcribed first, and `summarize` leaves that to a provider you choose. The free, local option:

```bash
brew install whisper-cpp
mkdir -p ~/.summarize/cache/whisper-cpp/models
curl -L -o ~/.summarize/cache/whisper-cpp/models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

`summarize` looks for `whisper-cli` on PATH and that exact model file (override with
`SUMMARIZE_WHISPER_CPP_MODEL_PATH`; `ggml-small.en.bin` or `ggml-medium.en.bin` from the same repo
are better for English at the cost of speed). Cloud alternatives: set `GROQ_API_KEY`,
`OPENAI_API_KEY`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`, `FAL_KEY` or `DEEPGRAM_API_KEY` and
`summarize` picks them up. `doctor` tells you which route it can see. Until one exists, podcast
episodes without a published transcript fail with `No transcription provider` and retry later.

Budget note: a three-hour episode is roughly 45k tokens of transcript, more than a 32k local
context. `summarize` fits what it can; for very long shows prefer an API model or accept that the
summary covers the first part.

## Limitations (v1)

- Discovery is feed-based: YouTube feeds list only the latest 15 videos, so a channel is followed
  from now on, not back-catalogued.
- Shorts detection is best-effort (feed hint plus a redirect probe).
- No search, no UI, no sync, no hosted mode. Tested on macOS and Linux.
- Behind a corporate TLS-inspecting proxy, Node >= 24.5 is needed for feeds to fetch (the OS
  keychain is merged automatically); on older Nodes set `NODE_USE_SYSTEM_CA=1`.

## Is this useful? Tell me

This is a one-week experiment. If you use it, two questions in
[the pinned issue](https://github.com/nikhil-raina/summarize-watch/issues/1): would you pay for
hosted scheduling (runs while your laptop is closed) and sync across devices? What source type is
missing? A star helps me see whether to keep going.

## Development

```bash
npm install
npm run typecheck && npm test      # 76 tests; the integration test uses the real summarize if installed
npx tsx src/cli.ts doctor          # run from source
```

Related: everything about fetching, transcripts and models belongs to
[`steipete/summarize`](https://github.com/steipete/summarize); this project only orchestrates it.

MIT © Nikhil Raina
