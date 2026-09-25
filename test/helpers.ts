import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export function tmpDir(prefix = 'summarize-watch-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
  /** Override a path with custom status/body for one test. */
  set(pathname: string, res: { status?: number; body: string; contentType?: string; headers?: Record<string, string> }): void;
  hits: string[];
}

/** Serves test/fixtures over HTTP on 127.0.0.1 with an ephemeral port. */
export async function serveFixtures(): Promise<FixtureServer> {
  const overrides = new Map<string, { status?: number; body: string; contentType?: string; headers?: Record<string, string> }>();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push(url.pathname);
    const o = overrides.get(url.pathname);
    if (o) {
      res.writeHead(o.status ?? 200, { 'content-type': o.contentType ?? 'text/plain', ...(o.headers ?? {}) });
      res.end(o.body);
      return;
    }
    const file = path.join(FIXTURES, url.pathname.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json' : 'application/xml';
    res.writeHead(200, { 'content-type': type });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    set: (pathname, r) => overrides.set(pathname, r),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
