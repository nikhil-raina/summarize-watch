# summarize-watch

Watch YouTube channels, podcast feeds and RSS feeds. Every new item is run through the
[`summarize`](https://github.com/steipete/summarize) CLI and filed as an Obsidian-friendly
markdown note, with a daily digest of everything that landed.

Status: work in progress (Phase 1 of 4). Full README arrives with the first release.

## Requirements

- [`summarize`](https://summarize.sh) >= 0.23 (`brew install summarize`)
- Node >= 22.13 (24 recommended)
- A model `summarize` can use: a local Ollama model, an API key, or a coding-CLI login

## Quick start (development)

```bash
npm install
npx tsx src/cli.ts init --output ~/path/to/vault/Summaries
npx tsx src/cli.ts list
```

License: MIT
