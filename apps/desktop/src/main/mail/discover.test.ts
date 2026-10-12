import { describe, expect, it } from 'vitest';
import type { MailServerSettings } from '../../shared/mail';
import { discover, parseAutoconfig, probeCandidates, providerByDomain, providerByMx, resolveLogin, sortSrv, type DiscoverNet, type SrvRecord } from './discover';

function net(over: Partial<DiscoverNet> = {}): DiscoverNet & { probed: string[]; fetched: string[] } {
  const probed: string[] = [];
  const fetched: string[] = [];
  return {
    probed,
    fetched,
    resolveMx: () => Promise.resolve([]),
    resolveSrv: () => Promise.reject(new Error('ENOTFOUND')),
    fetchText: (u) => {
      fetched.push(u);
      return Promise.resolve(null);
    },
    probe: (kind, s: MailServerSettings) => {
      probed.push(`${kind} ${s.host}:${s.port}`);
      return Promise.resolve(false);
    },
    ...over,
  };
}

const AUTOCONFIG = `<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="example.org">
  <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <incomingServer type="imap"><hostname>plain.%EMAILDOMAIN%</hostname><port>143</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></outgoingServer>
</emailProvider></clientConfig>`;

describe('provider table', () => {
  it('maps address domains', () => {
    expect(providerByDomain('gmail.com')?.id).toBe('gmail');
    expect(providerByDomain('googlemail.com')?.id).toBe('gmail');
    expect(providerByDomain('yandex.ru')?.id).toBe('yandex');
    expect(providerByDomain('yandex.com.tr')?.id).toBe('yandex');
    expect(providerByDomain('ya.ru')?.id).toBe('yandex');
    for (const d of ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru']) expect(providerByDomain(d)?.id).toBe('mailru');
    for (const d of ['icloud.com', 'me.com', 'mac.com']) expect(providerByDomain(d)?.id).toBe('icloud');
    for (const d of ['outlook.com', 'hotmail.co.uk', 'live.ru']) expect(providerByDomain(d)?.id).toBe('microsoft');
    expect(providerByDomain('example.com')).toBeNull();
  });
  it('maps MX hosts by suffix only', () => {
    expect(providerByMx('aspmx.l.google.com.')?.id).toBe('gmail');
    expect(providerByMx('mx.yandex.net')?.id).toBe('yandex');
    expect(providerByMx('emx.mail.ru')?.id).toBe('mailru');
    expect(providerByMx('example-com.mail.protection.outlook.com')?.id).toBe('microsoft');
    expect(providerByMx('mx01.mail.icloud.com')?.id).toBe('icloud');
    expect(providerByMx('notgoogle.com')).toBeNull();
  });
});

describe('autoconfig XML', () => {
  it('takes the first TLS / STARTTLS imap + smtp, substitutes the domain, keeps login templates', () => {
    const r = parseAutoconfig(AUTOCONFIG, 'example.org');
    expect(r.imap).toEqual({ host: 'imap.example.org', port: 993, security: 'tls', login: '%EMAILLOCALPART%' });
    expect(r.smtp).toEqual({ host: 'smtp.example.org', port: 587, security: 'starttls', login: '%EMAILADDRESS%' });
  });
  it('ignores plain-only documents and garbage', () => {
    expect(parseAutoconfig('<incomingServer type="imap"><hostname>x</hostname><port>143</port><socketType>plain</socketType></incomingServer>', 'd')).toEqual({ imap: null, smtp: null });
    expect(parseAutoconfig('not xml', 'd')).toEqual({ imap: null, smtp: null });
  });
  it('resolves login templates', () => {
    expect(resolveLogin('%EMAILLOCALPART%', 'Ivan@Example.org')).toBe('ivan');
    expect(resolveLogin('%EMAILADDRESS%', 'ivan@example.org')).toBe('ivan@example.org');
    expect(resolveLogin('box+%EMAILDOMAIN%', 'ivan@example.org')).toBe('box+example.org');
  });
});

describe('SRV and candidates', () => {
  it('orders SRV by priority, then weight, dropping "."', () => {
    const recs: SrvRecord[] = [
      { name: 'b.example.org', port: 993, priority: 10, weight: 5 },
      { name: '.', port: 0, priority: 0, weight: 0 },
      { name: 'a.example.org', port: 993, priority: 10, weight: 50 },
      { name: 'c.example.org', port: 993, priority: 20, weight: 100 },
    ];
    expect(sortSrv(recs).map((r) => r.name)).toEqual(['a.example.org', 'b.example.org', 'c.example.org']);
  });
  it('builds probe candidates: implicit TLS first, MX hosts included, no duplicates', () => {
    const c = probeCandidates('example.org', ['mail.example.org', 'mx.host.net']);
    expect(c.imap.map((s) => `${s.host}:${s.port}`)).toEqual([
      'imap.example.org:993',
      'mail.example.org:993',
      'example.org:993',
      'mx.host.net:993',
      'imap.example.org:143',
      'mail.example.org:143',
      'example.org:143',
      'mx.host.net:143',
    ]);
    expect(c.smtp[0]).toEqual({ host: 'smtp.example.org', port: 465, security: 'tls' });
    expect(c.smtp.at(-1)).toEqual({ host: 'mx.host.net', port: 587, security: 'starttls' });
    expect(c.imap.every((s) => s.security === (s.port === 993 ? 'tls' : 'starttls'))).toBe(true);
  });
});

describe('discover chain', () => {
  it('known provider without any network', async () => {
    const n = net();
    const d = await discover('Ivan@Gmail.com', n);
    expect(d).toMatchObject({ provider: 'gmail', source: 'known', imap: { host: 'imap.gmail.com', port: 993 } });
    expect(d.appPasswordUrl).toMatch(/^https:/);
    expect(n.fetched).toEqual([]);
  });
  it('Microsoft → UNSUPPORTED_PROVIDER, also via MX', async () => {
    await expect(discover('a@outlook.com', net())).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    const n = net({ resolveMx: () => Promise.resolve([{ exchange: 'corp-com.mail.protection.outlook.com', priority: 0 }]) });
    await expect(discover('a@corp.com', n)).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
  });
  it('MX of a known hosting (Google Workspace, Yandex 360)', async () => {
    const n = net({ resolveMx: () => Promise.resolve([{ exchange: 'alt1.aspmx.l.google.com', priority: 5 }, { exchange: 'aspmx.l.google.com', priority: 1 }]) });
    await expect(discover('a@corp.com', n)).resolves.toMatchObject({ provider: 'gmail', source: 'mx' });
    const y = net({ resolveMx: () => Promise.resolve([{ exchange: 'mx.yandex.net', priority: 10 }]) });
    await expect(discover('a@corp.ru', y)).resolves.toMatchObject({ provider: 'yandex', source: 'mx', imap: { host: 'imap.yandex.ru' } });
  });
  it('autoconfig before SRV, with the login template', async () => {
    const n = net({
      fetchText: (u) => Promise.resolve(u.startsWith('https://autoconfig.thunderbird.net/') ? AUTOCONFIG : null),
      resolveSrv: () => Promise.resolve([{ name: 'srv.example.org', port: 993, priority: 0, weight: 0 }]),
    });
    const d = await discover('ivan@example.org', n);
    expect(d).toMatchObject({ source: 'autoconfig', provider: 'other', loginTemplate: '%EMAILLOCALPART%', imap: { host: 'imap.example.org' }, smtp: { port: 587 } });
    expect(n.probed).toEqual([]);
  });
  it('SRV prefers _imaps over _imap and _submissions over _submission', async () => {
    const srv: Record<string, SrvRecord[]> = {
      '_imap._tcp.example.org': [{ name: 'imap-plain.example.org', port: 143, priority: 0, weight: 0 }],
      '_imaps._tcp.example.org': [{ name: 'imaps.example.org.', port: 993, priority: 0, weight: 0 }],
      '_submission._tcp.example.org': [{ name: 'sub.example.org', port: 587, priority: 0, weight: 0 }],
    };
    const n = net({ resolveSrv: (name) => (srv[name] ? Promise.resolve(srv[name]) : Promise.reject(new Error('ENODATA'))) });
    const d = await discover('ivan@example.org', n);
    expect(d.source).toBe('srv');
    expect(d.imap).toEqual({ host: 'imaps.example.org', port: 993, security: 'tls' });
    expect(d.smtp).toEqual({ host: 'sub.example.org', port: 587, security: 'starttls' });
  });
  it('probes MX candidates and picks by preference, not by speed', async () => {
    const ok = new Set(['imap mail.example.org:993', 'imap mx.hoster.net:993', 'smtp mail.example.org:587']);
    const n = net({
      resolveMx: () => Promise.resolve([{ exchange: 'mx.hoster.net', priority: 10 }]),
      probe: (kind, s) => Promise.resolve(ok.has(`${kind} ${s.host}:${s.port}`)),
    });
    const d = await discover('ivan@example.org', n);
    expect(d).toMatchObject({ source: 'probe', imap: { host: 'mail.example.org', port: 993, security: 'tls' }, smtp: { host: 'mail.example.org', port: 587, security: 'starttls' } });
  });
  it('nothing found → DISCOVERY_FAILED with guesses (partial hits kept)', async () => {
    const n = net({ probe: (kind, s) => Promise.resolve(kind === 'imap' && s.host === 'mail.example.org' && s.port === 993) });
    const err = await discover('ivan@example.org', n).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DISCOVERY_FAILED', discovery: { source: 'manual', imap: { host: 'mail.example.org' }, smtp: { host: 'smtp.example.org', port: 465 } } });
  });
  it('rejects malformed addresses', async () => {
    await expect(discover('nope', net())).rejects.toMatchObject({ code: 'INVALID' });
  });
});
