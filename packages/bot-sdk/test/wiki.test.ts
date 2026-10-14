import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodeFrame,
  encodeSnapshot,
  encodeUpdate,
  FRAME_SNAPSHOT_POST,
  FRAME_UPDATE,
  type Frame,
} from '@calaba/wiki-doc/frames';
import { docToMarkdown, setDocMarkdown } from '@calaba/wiki-doc/ydoc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { Bot, WikiSyncError } from '../src/index.js';
import { FakeServer, TOKEN, WS_ID } from './fake-server.js';

const PAGE = '0190c3f6-0000-7000-8000-0000000000aa';

/**
 * A fake of the wiki sync socket (frames of @calaba/wiki-doc/frames) and the page's REST GET: it
 * keeps the page as a Y doc, assigns seqs, relays updates back to every socket (the sender too),
 * and records SNAPSHOT_POSTs.
 */
class FakeWiki {
  url = '';
  readonly doc = new Y.Doc();
  seq = 0;
  readonly received: Frame[] = [];
  readonly tokens: string[] = [];
  title = 'Bot notes';
  private http: Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true });

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      if (req.method === 'GET' && req.url === `/api/wiki/pages/${PAGE}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ page: { id: PAGE, workspaceId: WS_ID, title: this.title } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"code":"ERROR_CODE_NOT_FOUND"}');
    });
    this.http.on('upgrade', (req, socket, head) => {
      if (req.url !== `/api/wiki/pages/${PAGE}/sync`) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.serve(ws);
      });
    });
    await new Promise<void>((r) => this.http?.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  private serve(ws: WebSocket): void {
    let authed = false;
    ws.on('message', (data: Buffer, binary: boolean) => {
      if (!authed) {
        const tok = data.toString();
        this.tokens.push(tok);
        if (binary || tok !== TOKEN) {
          ws.close(4004, 'authentication failed');
          return;
        }
        authed = true;
        // The catch-up: the snapshot through the current seq.
        ws.send(encodeSnapshot(this.seq, Y.encodeStateAsUpdate(this.doc)));
        return;
      }
      const f = decodeFrame(new Uint8Array(data));
      if (!f) return;
      this.received.push(f);
      if (f.type === FRAME_UPDATE) {
        Y.applyUpdate(this.doc, f.update);
        this.seq++;
        for (const c of this.wss.clients) c.send(encodeUpdate(f.update, this.seq));
      } else if (f.type === FRAME_SNAPSHOT_POST) {
        Y.applyUpdate(this.doc, f.state);
        if (f.meta.title) this.title = f.meta.title;
      }
    });
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    await new Promise<void>((r) => {
      if (this.http) this.http.close(() => { r(); });
      else r();
    });
  }
}

let wiki: FakeWiki;
let bot: Bot;

beforeEach(async () => {
  wiki = new FakeWiki();
  await wiki.start();
  bot = new Bot(TOKEN, { server: wiki.url, wikiSync: { settleMs: 30, timeoutMs: 3000 } });
});
afterEach(async () => {
  await wiki.close();
});

describe('wiki page content over the sync socket', () => {
  it('reads the title and the content as Markdown', async () => {
    setDocMarkdown(wiki.doc, '## Hello\n\n- one\n- two');
    const got = await bot.wiki.page(PAGE).read();
    expect(wiki.tokens).toEqual([TOKEN]);
    expect(got.title).toBe('Bot notes');
    expect(got.markdown).toBe('## Hello\n\n- one\n- two\n');
  });

  it('writes: UPDATE relayed back, then a snapshot post through its seq with the text', async () => {
    setDocMarkdown(wiki.doc, 'old text');
    wiki.seq = 4;
    await bot.wiki.page(PAGE).write('# Report\n\nAll **green**.', { title: 'Weekly' });
    expect(docToMarkdown(wiki.doc)).toBe('# Report\n\nAll **green**.\n');
    const [u, post] = wiki.received;
    expect(u?.type).toBe(FRAME_UPDATE);
    expect(post?.type).toBe(FRAME_SNAPSHOT_POST);
    if (post?.type !== FRAME_SNAPSHOT_POST) throw new Error('no post');
    expect(post.throughSeq).toBe(5);
    expect(post.broadcast).toBe(false);
    expect(post.meta).toEqual({ plain_text: 'Report\nAll green.', title: 'Weekly', preview: 'Report All green.' });
    expect(wiki.title).toBe('Weekly');
  });

  it('appends after the existing blocks', async () => {
    setDocMarkdown(wiki.doc, 'first');
    await bot.wiki.page(PAGE).append('- [ ] follow up');
    expect(docToMarkdown(wiki.doc)).toBe('first\n\n- [ ] follow up\n');
  });

  it('sends a change above the frame limit as a broadcast snapshot', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `Line ${i} with some padding text to grow the update`).join('\n\n');
    await bot.wiki.page(PAGE).write(big);
    expect(wiki.received.map((f) => f.type)).toEqual([FRAME_SNAPSHOT_POST]);
    const post = wiki.received[0];
    if (post?.type !== FRAME_SNAPSHOT_POST) throw new Error('no post');
    expect(post.broadcast).toBe(true);
    expect(docToMarkdown(wiki.doc).startsWith('Line 0 with')).toBe(true);
  });

  it('a refused token is a WikiSyncError with the close code', async () => {
    const other = new Bot(`${TOKEN.slice(0, -1)}B`, { server: wiki.url, wikiSync: { settleMs: 30, timeoutMs: 3000 } });
    const err = await other.wiki.page(PAGE).read().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WikiSyncError);
    expect((err as WikiSyncError).code).toBe(4004);
  });
});

describe('disk over REST', () => {
  let srv: FakeServer;
  beforeEach(async () => {
    srv = new FakeServer();
    await srv.start();
  });
  afterEach(async () => {
    await srv.close();
  });

  it('creates a folder, uploads into it, shares, links and trashes', async () => {
    const item = (id: string, extra: Record<string, unknown> = {}) => ({ item: { id, workspaceId: WS_ID, name: id, ...extra } });
    srv
      .route(`POST /api/workspaces/${WS_ID}/disk/folders`, (r) => ({ status: 201, json: item('f1', { name: (r.json as { name: string }).name }) }))
      .route(`POST /api/workspaces/${WS_ID}/disk/upload`, (r) => ({ status: 201, json: item('i1', { parentId: r.query.get('parent'), file: { id: 'file1', name: 'a.txt', size: '3', mime: 'text/plain' } }) }))
      .route('PUT /api/disk/items/f1/permissions', (r) => ({ json: r.json }))
      .route('POST /api/disk/items/i1/link', { json: { link: { code: 'c'.repeat(43) }, url: 'https://x/d/ccc' } })
      .route('DELETE /api/disk/items/i1/link', { status: 204 })
      .route('POST /api/disk/items/f1/trash', { json: item('f1') })
      .route('GET /api/disk/items/i1', { json: item('i1', { file: { id: 'file1', name: 'a.txt', size: '3', mime: 'text/plain' } }) })
      .route('GET /api/files/file1', { json: 'abc' });
    const b = new Bot(TOKEN, { server: srv.url });
    const folder = await b.disk.createFolder(WS_ID, 'Reports');
    expect(folder.name).toBe('Reports');
    const file = await b.disk.upload(WS_ID, new TextEncoder().encode('abc'), 'a.txt', folder.id);
    expect(file.parentId).toBe('f1');
    const up = srv.requests.find((r) => r.path.endsWith('/disk/upload'));
    expect((up?.form?.get('file') as File).name).toBe('a.txt');
    const shared = await b.disk.share('f1', [{ targetType: 2, targetId: 'u-bob', allow: 1n << 35n }], true);
    expect(shared.restricted).toBe(true);
    expect(srv.requests.find((r) => r.method === 'PUT')?.json).toEqual({ entries: [{ targetType: 'PERMISSION_TARGET_TYPE_USER', targetId: 'u-bob', allow: String(1n << 35n) }], restricted: true });
    expect((await b.disk.link.on('i1')).url).toBe('https://x/d/ccc');
    await b.disk.link.off('i1');
    expect((await b.disk.trash('f1')).id).toBe('f1');
    const dl = await b.disk.download('i1');
    expect(dl.name).toBe('i1');
    expect(await new Response(dl.stream).text()).toBe('"abc"');
  });
});
