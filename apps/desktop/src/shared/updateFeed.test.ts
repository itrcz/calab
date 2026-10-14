import { describe, expect, it } from 'vitest';
import { type FeedSource, downloadPage, feedKey, feedUrl, githubSource, httpsFeed, parseUpdateChannel, pinnedSource, sourcePage } from './updateFeed';

describe('update feed (review M3)', () => {
  it('app.X → https://releases.X/', () => {
    expect(feedUrl('https://app.calab.io', '')).toBe('https://releases.calab.io/');
    expect(feedUrl('https://app.calab.io/', '')).toBe('https://releases.calab.io/');
    expect(feedUrl('https://app.calab.io///', '')).toBe('https://releases.calab.io/');
    // A server saved before 2.0.0 keeps its own family (releases.calab.ru serves the same feed).
    expect(feedUrl('https://app.calab.ru', '')).toBe('https://releases.calab.ru/');
  });
  it('nested app.a.b → releases.a.b', () => {
    expect(feedUrl('https://app.team.example.com', '')).toBe('https://releases.team.example.com/');
  });
  it('keeps the port', () => {
    expect(feedUrl('https://app.example.com:8443', '')).toBe('https://releases.example.com:8443/');
    expect(feedUrl('https://chat.example.com:8443/', '')).toBe('https://chat.example.com:8443/download/');
  });
  it('any other host → <server>/download/', () => {
    expect(feedUrl('https://colaba.gptunnel.ai', '')).toBe('https://colaba.gptunnel.ai/download/');
    expect(feedUrl('https://colaba.gptunnel.ai/', '')).toBe('https://colaba.gptunnel.ai/download/');
    // «app» only as the first label counts; «myapp.x» / «x.app.y» are other hosts.
    expect(feedUrl('https://myapp.example.com', '')).toBe('https://myapp.example.com/download/');
    expect(feedUrl('https://x.app.example.com', '')).toBe('https://x.app.example.com/download/');
  });
  it('accepts only https', () => {
    expect(feedUrl('http://localhost:3000', '')).toBeNull();
    expect(feedUrl('http://app.example.com', '')).toBeNull();
    expect(feedUrl('', 'http://evil.example/feed')).toBeNull();
    expect(feedUrl('', 'file:///tmp/x')).toBeNull();
    expect(feedUrl('', 'not a url')).toBeNull();
    expect(feedUrl('not a url', '')).toBeNull();
  });
  it('a launch/build-time override wins and gets a trailing slash', () => {
    expect(feedUrl('https://a.example', 'https://updates.example/calaba')).toBe('https://updates.example/calaba/');
    expect(feedUrl('https://app.calab.io', 'https://updates.example/')).toBe('https://updates.example/');
    // A non-https override does not fall back to the derived feed.
    expect(feedUrl('https://app.calab.io', 'http://updates.example/')).toBeNull();
  });
  it('no server and no override → off', () => {
    expect(feedUrl('', '')).toBeNull();
    expect(feedUrl('', '  ')).toBeNull();
  });
});

describe('build-time feed (review pass 3 B1)', () => {
  it('https only, trailing slash; anything else is treated as empty', () => {
    expect(httpsFeed('https://releases.calab.io/')).toBe('https://releases.calab.io/');
    expect(httpsFeed(' https://releases.calab.io ')).toBe('https://releases.calab.io/');
    expect(httpsFeed('https://updates.example/calab')).toBe('https://updates.example/calab/');
    expect(httpsFeed('http://releases.calab.io/')).toBeNull();
    expect(httpsFeed('file:///tmp/feed')).toBeNull();
    expect(httpsFeed('not a url')).toBeNull();
    expect(httpsFeed('')).toBeNull();
  });
});

describe('download page (review pass 3 L)', () => {
  it('https server → <server origin>/download/, never the feed root', () => {
    expect(downloadPage('https://app.calab.io', 'https://releases.calab.io/')).toBe('https://app.calab.io/download/');
    expect(downloadPage('https://app.calab.io/', null)).toBe('https://app.calab.io/download/');
    expect(downloadPage('https://chat.example.com:8443/x', null)).toBe('https://chat.example.com:8443/download/');
  });
  it('no server / not https → the build-time feed (or none)', () => {
    expect(downloadPage('', 'https://releases.calab.io/')).toBe('https://releases.calab.io/');
    expect(downloadPage('http://localhost:3000', 'https://releases.calab.io/')).toBe('https://releases.calab.io/');
    expect(downloadPage('not a url', null)).toBeNull();
    expect(downloadPage('', null)).toBeNull();
  });
});

describe('update channel (owner 12.10: GitHub or S3, GitHub by default)', () => {
  const S3 = 'https://releases.calab.io/';
  const GH: FeedSource = { provider: 'github', owner: 'itrcz', repo: 'calab' };
  it('stored / sent values: only github | s3, anything else → github', () => {
    expect(parseUpdateChannel('s3')).toBe('s3');
    expect(parseUpdateChannel('github')).toBe('github');
    expect(parseUpdateChannel(undefined)).toBe('github');
    expect(parseUpdateChannel('https://evil.example/')).toBe('github');
    expect(parseUpdateChannel(1)).toBe('github');
  });
  it('github repo: owner/repo only', () => {
    expect(GH).toEqual({ provider: 'github', owner: 'itrcz', repo: 'calab' });
    expect(githubSource(' itrcz/calab ')).toEqual(GH);
    expect(githubSource('')).toBeNull();
    expect(githubSource('itrcz')).toBeNull();
    expect(githubSource('itrcz/calab/releases')).toBeNull();
    expect(githubSource('https://github.com/itrcz/calab')).toBeNull();
    expect(githubSource('-x/calab')).toBeNull();
    expect(githubSource('itrcz/..')).toBeNull();
  });
  it('the chosen channel when baked in, else the other pinned one, else none', () => {
    expect(pinnedSource('github', S3, GH)).toEqual(GH);
    expect(pinnedSource('s3', S3, GH)).toEqual({ provider: 'generic', url: S3 });
    expect(pinnedSource('github', S3, null)).toEqual({ provider: 'generic', url: S3 });
    expect(pinnedSource('s3', null, GH)).toEqual(GH);
    expect(pinnedSource('github', null, null)).toBeNull();
    expect(pinnedSource('s3', null, null)).toBeNull();
  });
  it('keys and pages', () => {
    expect(feedKey(GH)).toBe('github:itrcz/calab');
    expect(feedKey({ provider: 'generic', url: S3 })).toBe(S3);
    expect(sourcePage(GH)).toBe('https://github.com/itrcz/calab/releases/latest');
    expect(sourcePage({ provider: 'generic', url: S3 })).toBe(S3);
  });
});
