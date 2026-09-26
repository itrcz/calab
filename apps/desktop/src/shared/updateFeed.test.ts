import { describe, expect, it } from 'vitest';
import { downloadPage, feedUrl, httpsFeed } from './updateFeed';

describe('update feed (review M3)', () => {
  it('app.X → https://releases.X/', () => {
    expect(feedUrl('https://app.calab.ru', '')).toBe('https://releases.calab.ru/');
    expect(feedUrl('https://app.calab.ru/', '')).toBe('https://releases.calab.ru/');
    expect(feedUrl('https://app.calab.ru///', '')).toBe('https://releases.calab.ru/');
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
    expect(feedUrl('https://app.calab.ru', 'https://updates.example/')).toBe('https://updates.example/');
    // A non-https override does not fall back to the derived feed.
    expect(feedUrl('https://app.calab.ru', 'http://updates.example/')).toBeNull();
  });
  it('no server and no override → off', () => {
    expect(feedUrl('', '')).toBeNull();
    expect(feedUrl('', '  ')).toBeNull();
  });
});

describe('build-time feed (review pass 3 B1)', () => {
  it('https only, trailing slash; anything else is treated as empty', () => {
    expect(httpsFeed('https://releases.calab.ru/')).toBe('https://releases.calab.ru/');
    expect(httpsFeed(' https://releases.calab.ru ')).toBe('https://releases.calab.ru/');
    expect(httpsFeed('https://updates.example/calab')).toBe('https://updates.example/calab/');
    expect(httpsFeed('http://releases.calab.ru/')).toBeNull();
    expect(httpsFeed('file:///tmp/feed')).toBeNull();
    expect(httpsFeed('not a url')).toBeNull();
    expect(httpsFeed('')).toBeNull();
  });
});

describe('download page (review pass 3 L)', () => {
  it('https server → <server origin>/download/, never the feed root', () => {
    expect(downloadPage('https://app.calab.ru', 'https://releases.calab.ru/')).toBe('https://app.calab.ru/download/');
    expect(downloadPage('https://app.calab.ru/', null)).toBe('https://app.calab.ru/download/');
    expect(downloadPage('https://chat.example.com:8443/x', null)).toBe('https://chat.example.com:8443/download/');
  });
  it('no server / not https → the build-time feed (or none)', () => {
    expect(downloadPage('', 'https://releases.calab.ru/')).toBe('https://releases.calab.ru/');
    expect(downloadPage('http://localhost:3000', 'https://releases.calab.ru/')).toBe('https://releases.calab.ru/');
    expect(downloadPage('not a url', null)).toBeNull();
    expect(downloadPage('', null)).toBeNull();
  });
});
