import { describe, expect, it } from 'vitest';
import { isOllamaModel, ollamaBaseUrl, ollamaStatus, ollamaTag, ollamaWarmUp } from '../src/ollama.js';

describe('ollama helpers', () => {
  it('derives the base url the way summarize does', () => {
    expect(ollamaBaseUrl({})).toBe('http://127.0.0.1:11434');
    expect(ollamaBaseUrl({ OLLAMA_BASE_URL: 'http://gpu.lan:11434/v1' })).toBe('http://gpu.lan:11434');
    expect(ollamaBaseUrl({ OLLAMA_BASE_URL: 'http://gpu.lan:11434/v1/' })).toBe('http://gpu.lan:11434');
    expect(ollamaBaseUrl({ OLLAMA_HOST: '0.0.0.0:11434' })).toBe('http://0.0.0.0:11434');
    expect(ollamaBaseUrl({ OLLAMA_HOST: 'https://o.example.com/' })).toBe('https://o.example.com');
  });

  it('recognises and strips the ollama/ prefix', () => {
    expect(isOllamaModel('ollama/qwen3:14b')).toBe(true);
    expect(isOllamaModel('openai/gpt-5-mini')).toBe(false);
    expect(isOllamaModel(null)).toBe(false);
    expect(ollamaTag('ollama/qwen3:14b')).toBe('qwen3:14b');
  });

  it('status and warm-up talk to the documented endpoints and survive an unreachable server', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.endsWith('/api/version')) return Response.json({ version: '0.34.2' });
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3:14b' }, { name: 'gemma2:9b' }] });
      if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'qwen3:14b', context_length: 32768 }] });
      if (url.endsWith('/api/generate')) return Response.json({ model: 'qwen3:14b', done: true });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;

    const st = await ollamaStatus({ baseUrl: 'http://o', fetchImpl });
    expect(st).toMatchObject({ reachable: true, version: '0.34.2', tags: ['qwen3:14b', 'gemma2:9b'], loaded: [{ name: 'qwen3:14b', contextLength: 32768 }], error: null });

    const w = await ollamaWarmUp('ollama/qwen3:14b', { baseUrl: 'http://o', fetchImpl });
    expect(w.ok).toBe(true);
    const gen = calls.find((c) => c.url.endsWith('/api/generate'));
    expect(JSON.parse(gen?.body ?? '{}')).toEqual({ model: 'qwen3:14b', prompt: '', keep_alive: '30m' });

    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect((await ollamaStatus({ baseUrl: 'http://o', fetchImpl: down })).reachable).toBe(false);
    expect((await ollamaWarmUp('ollama/x', { baseUrl: 'http://o', fetchImpl: down })).ok).toBe(false);
  });
});
