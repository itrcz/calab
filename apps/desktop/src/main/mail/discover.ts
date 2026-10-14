/**
 * Account settings discovery (ADR-0088 §4), engine side. Order, stopping at the first hit for each of
 * IMAP and SMTP: known providers → MX record → autoconfig (domain, then Thunderbird ISPDB) → DNS SRV
 * (RFC 6186) → host probes → DISCOVERY_FAILED with best guesses. Each network step ≤ 3 s, the whole
 * run ≤ 10 s. TLS / STARTTLS only; plain-text servers are never offered.
 * Network access goes through `DiscoverNet` so tests run offline.
 */
import type { MailCertInfo, MailDiscoveredServer, MailDiscovery, MailDiscoverySource, MailProvider, MailSecurity, MailServerSettings } from '../../shared/mail';
import { mailError } from './errors';

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface DiscoverNet {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveSrv(name: string): Promise<SrvRecord[]>;
  /** GET an https URL, ≤ timeoutMs; the body text or null (non-2xx, network error, timeout). */
  fetchText(url: string, timeoutMs: number): Promise<string | null>;
  /** TCP + TLS (+ STARTTLS) + greeting, ≤ timeoutMs. */
  probe(kind: 'imap' | 'smtp', server: MailServerSettings, timeoutMs: number): Promise<ProbeResult>;
}

/**
 * A probe's outcome: `ok` = a TLS mail server answered. A certificate that does not verify still
 * counts as found (self-signed servers are discovered, not sent to the manual form) and is reported
 * as `certIssue` for the trust prompt before the first login (§4).
 */
export type ProbeResult = { ok: false } | { ok: true; certIssue?: MailCertInfo };

export const STEP_TIMEOUT_MS = 3000;
export const TOTAL_TIMEOUT_MS = 10_000;

interface Provider {
  id: Exclude<MailProvider, 'other'>;
  imap: MailServerSettings;
  smtp: MailServerSettings;
  appPasswordUrl: string | null;
  /** Address domains (exact) and domain patterns. */
  domains: (d: string) => boolean;
  /** MX host suffixes (a domain on this provider's hosting). */
  mx: string[];
}

const tls = (host: string, port: number): MailServerSettings => ({ host, port, security: 'tls' });
const starttls = (host: string, port: number): MailServerSettings => ({ host, port, security: 'starttls' });

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'gmail',
    imap: tls('imap.gmail.com', 993),
    smtp: tls('smtp.gmail.com', 465),
    appPasswordUrl: 'https://support.google.com/accounts/answer/185833',
    domains: (d) => d === 'gmail.com' || d === 'googlemail.com',
    mx: ['google.com', 'googlemail.com'],
  },
  {
    id: 'yandex',
    imap: tls('imap.yandex.ru', 993),
    smtp: tls('smtp.yandex.ru', 465),
    appPasswordUrl: 'https://yandex.ru/support/id/authorization/app-passwords.html',
    domains: (d) => /^yandex\.[a-z.]+$/.test(d) || d === 'ya.ru' || d === 'narod.ru',
    mx: ['yandex.net', 'yandex.ru'],
  },
  {
    id: 'mailru',
    imap: tls('imap.mail.ru', 993),
    smtp: tls('smtp.mail.ru', 465),
    appPasswordUrl: 'https://help.mail.ru/mail/security/protection/external',
    domains: (d) => ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru', 'mail.ua', 'my.com'].includes(d),
    mx: ['mail.ru'],
  },
  {
    id: 'icloud',
    imap: tls('imap.mail.me.com', 993),
    smtp: starttls('smtp.mail.me.com', 587),
    appPasswordUrl: 'https://support.apple.com/en-us/102654',
    domains: (d) => d === 'icloud.com' || d === 'me.com' || d === 'mac.com',
    mx: ['icloud.com', 'me.com'],
  },
  {
    id: 'microsoft',
    imap: tls('outlook.office365.com', 993),
    smtp: starttls('smtp.office365.com', 587),
    appPasswordUrl: null,
    domains: (d) => /^(outlook|hotmail|live)\.[a-z.]+$/.test(d) || d === 'msn.com' || d === 'passport.com',
    mx: ['outlook.com', 'hotmail.com', 'outlook.office365.com'],
  },
];

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
}

export function providerByDomain(domain: string): Provider | null {
  return PROVIDERS.find((p) => p.domains(domain)) ?? null;
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function providerByMx(mxHost: string): Provider | null {
  const h = mxHost.toLowerCase().replace(/\.$/, '');
  return PROVIDERS.find((p) => p.mx.some((s) => hostMatches(h, s))) ?? null;
}

/** The registrable-ish parent of an MX host: `mx1.mail.example.com` → `example.com` (last two labels). */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  return parts.slice(-2).join('.');
}

export function appPasswordUrl(provider: MailProvider): string | null {
  return PROVIDERS.find((p) => p.id === provider)?.appPasswordUrl ?? null;
}

// ---------------------------------------------------------------- autoconfig

interface AutoServer {
  host: string;
  port: number;
  security: MailSecurity;
  login: string;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(xml);
  return m?.[1] ?? null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parses a Mozilla autoconfig document (config-v1.1.xml): the first `incomingServer type="imap"` and
 * `outgoingServer type="smtp"` with SSL / STARTTLS (plain entries are skipped). `%EMAILDOMAIN%` in
 * host names is substituted; login templates are kept as they are.
 */
export function parseAutoconfig(xml: string, domain: string): { imap: AutoServer | null; smtp: AutoServer | null } {
  const pick = (kind: 'incomingServer' | 'outgoingServer', type: 'imap' | 'smtp'): AutoServer | null => {
    const re = new RegExp(`<${kind}\\s+type\\s*=\\s*["']${type}["'][^>]*>([\\s\\S]*?)</${kind}>`, 'gi');
    for (const m of xml.matchAll(re)) {
      const body = m[1] ?? '';
      const host = decodeEntities(tag(body, 'hostname') ?? '').replace(/%EMAILDOMAIN%/g, domain).toLowerCase();
      const port = Number(tag(body, 'port'));
      const socket = (tag(body, 'socketType') ?? '').toUpperCase();
      const security: MailSecurity | null = socket === 'SSL' ? 'tls' : socket === 'STARTTLS' ? 'starttls' : null;
      if (!host || !/^[a-z0-9.-]+$/.test(host) || !Number.isInteger(port) || port <= 0 || port > 65535 || !security) continue;
      const login = decodeEntities(tag(body, 'username') ?? '%EMAILADDRESS%') || '%EMAILADDRESS%';
      return { host, port, security, login };
    }
    return null;
  };
  return { imap: pick('incomingServer', 'imap'), smtp: pick('outgoingServer', 'smtp') };
}

export function autoconfigUrls(domain: string, email: string): string[] {
  const e = encodeURIComponent(email);
  return [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${e}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${e}`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ];
}

// ---------------------------------------------------------------- SRV

/** RFC 2782 order: priority ascending, then weight descending; target "." = service not offered. */
export function sortSrv(records: SrvRecord[]): SrvRecord[] {
  return records.filter((r) => r.name && r.name !== '.' && r.port > 0).sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

/** SRV names in preference order with the security each one implies. */
export const SRV_NAMES = {
  imap: [
    ['_imaps._tcp', 'tls'],
    ['_imap._tcp', 'starttls'],
  ],
  smtp: [
    ['_submissions._tcp', 'tls'],
    ['_submission._tcp', 'starttls'],
  ],
} as const satisfies Record<'imap' | 'smtp', ReadonlyArray<readonly [string, MailSecurity]>>;

// ---------------------------------------------------------------- probe candidates

/** Probe candidates in preference order (§4 step 5): host prefixes × ports (implicit TLS first). */
export function probeCandidates(domain: string, mxExtra: string[]): { imap: MailServerSettings[]; smtp: MailServerSettings[] } {
  const uniq = (hosts: string[]): string[] => [...new Set(hosts.map((h) => h.toLowerCase().replace(/\.$/, '')).filter(Boolean))];
  const imapHosts = uniq([`imap.${domain}`, `mail.${domain}`, domain, ...mxExtra]);
  const smtpHosts = uniq([`smtp.${domain}`, `mail.${domain}`, ...mxExtra]);
  return {
    imap: [...imapHosts.map((h) => tls(h, 993)), ...imapHosts.map((h) => starttls(h, 143))],
    smtp: [...smtpHosts.map((h) => tls(h, 465)), ...smtpHosts.map((h) => starttls(h, 587))],
  };
}

// ---------------------------------------------------------------- the chain

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

interface Found {
  server: MailDiscoveredServer;
  source: MailDiscoverySource;
  login?: string;
}

/**
 * Discovers settings for an address. Resolves `MailDiscovery`, rejects `UNSUPPORTED_PROVIDER`
 * (Microsoft) or `DISCOVERY_FAILED` (with guesses), `INVALID` for a malformed address.
 */
export async function discover(emailRaw: string, net: DiscoverNet, now: () => number = Date.now): Promise<MailDiscovery> {
  const email = emailRaw.trim().toLowerCase();
  const domain = domainOf(email);
  if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(email) || !domain) throw mailError('INVALID', 'not an e-mail address');
  const deadline = now() + TOTAL_TIMEOUT_MS;
  const left = (): number => Math.max(0, Math.min(STEP_TIMEOUT_MS, deadline - now()));

  const known = (p: Provider, source: MailDiscoverySource): MailDiscovery => {
    if (p.id === 'microsoft') throw mailError('UNSUPPORTED_PROVIDER', 'Microsoft accounts need OAuth2, not supported yet');
    return { imap: p.imap, smtp: p.smtp, source, provider: p.id, loginTemplate: '%EMAILADDRESS%', appPasswordUrl: p.appPasswordUrl };
  };

  // 1. Known providers by the address domain.
  const byDomain = providerByDomain(domain);
  if (byDomain) return known(byDomain, 'known');

  // 2. MX: a known hosting, else the MX host and its domain join the probe candidates.
  const mx = await withTimeout(net.resolveMx(domain), left(), []);
  const mxHosts = [...mx].sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
  for (const h of mxHosts) {
    const p = providerByMx(h);
    if (p) return known(p, 'mx');
  }
  const mxExtra: string[] = [];
  for (const h of mxHosts.slice(0, 2)) {
    mxExtra.push(h);
    const base = baseDomain(h);
    if (base !== domain) mxExtra.push(`mail.${base}`, base);
  }

  let imap: Found | null = null;
  let smtp: Found | null = null;
  const done = (): boolean => imap !== null && smtp !== null;

  // 3 + 4. Autoconfig (three URLs, first usable in order) and SRV, in parallel; autoconfig wins.
  const [auto, srv] = await Promise.all([
    withTimeout(
      Promise.all(autoconfigUrls(domain, email).map((u) => net.fetchText(u, STEP_TIMEOUT_MS).catch(() => null))),
      left(),
      [] as Array<string | null>,
    ),
    withTimeout(resolveSrvAll(net, domain), left(), { imap: null, smtp: null }),
  ]);
  for (const xml of auto) {
    if (!xml) continue;
    const parsed = parseAutoconfig(xml, domain);
    if (!imap && parsed.imap) imap = { server: { host: parsed.imap.host, port: parsed.imap.port, security: parsed.imap.security }, source: 'autoconfig', login: parsed.imap.login };
    if (!smtp && parsed.smtp) smtp = { server: { host: parsed.smtp.host, port: parsed.smtp.port, security: parsed.smtp.security }, source: 'autoconfig' };
    if (done()) break;
  }
  if (!imap && srv.imap) imap = { server: srv.imap, source: 'srv' };
  if (!smtp && srv.smtp) smtp = { server: srv.smtp, source: 'srv' };

  // 5. Probes, all candidates in parallel; the first success in preference order wins.
  if (!done()) {
    const cands = probeCandidates(domain, mxExtra);
    const t = left();
    const run = (kind: 'imap' | 'smtp', list: MailServerSettings[]): Promise<MailDiscoveredServer | null> =>
      t <= 0
        ? Promise.resolve(null)
        : withTimeout(
            Promise.all(list.map((s) => net.probe(kind, s, t).catch((): ProbeResult => ({ ok: false })))).then((res) => {
              const i = res.findIndex((r) => r.ok);
              const r = res[i];
              const s = list[i];
              if (!s || !r?.ok) return null;
              return r.certIssue ? { ...s, certIssue: r.certIssue } : s;
            }),
            t + 100,
            null,
          );
    const [pi, ps] = await Promise.all([imap ? Promise.resolve(null) : run('imap', cands.imap), smtp ? Promise.resolve(null) : run('smtp', cands.smtp)]);
    if (!imap && pi) imap = { server: pi, source: 'probe' };
    if (!smtp && ps) smtp = { server: ps, source: 'probe' };
  }

  const loginTemplate = imap?.login ?? '%EMAILADDRESS%';
  if (imap && smtp) {
    return { imap: imap.server, smtp: smtp.server, source: imap.source, provider: 'other', loginTemplate, appPasswordUrl: null };
  }
  // 6. Nothing complete: guesses for the manual form.
  const guess: MailDiscovery = {
    imap: imap?.server ?? tls(`imap.${domain}`, 993),
    smtp: smtp?.server ?? tls(`smtp.${domain}`, 465),
    source: 'manual',
    provider: 'other',
    loginTemplate,
    appPasswordUrl: null,
  };
  throw mailError('DISCOVERY_FAILED', `no mail settings found for ${domain}`, guess);
}

async function resolveSrvAll(net: DiscoverNet, domain: string): Promise<{ imap: MailServerSettings | null; smtp: MailServerSettings | null }> {
  const lookup = async (names: ReadonlyArray<readonly [string, MailSecurity]>): Promise<MailServerSettings | null> => {
    const results = await Promise.all(names.map(([n]) => net.resolveSrv(`${n}.${domain}`).catch(() => [] as SrvRecord[])));
    for (let i = 0; i < names.length; i++) {
      const best = sortSrv(results[i] ?? [])[0];
      const sec = names[i]?.[1];
      if (best && sec) return { host: best.name.toLowerCase().replace(/\.$/, ''), port: best.port, security: sec };
    }
    return null;
  };
  const [imap, smtp] = await Promise.all([lookup(SRV_NAMES.imap), lookup(SRV_NAMES.smtp)]);
  return { imap, smtp };
}

/** `%EMAILADDRESS%` / `%EMAILLOCALPART%` / `%EMAILDOMAIN%` in a login template. */
export function resolveLogin(template: string, email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return template
    .replace(/%EMAILADDRESS%/g, e)
    .replace(/%EMAILLOCALPART%/g, at < 0 ? e : e.slice(0, at))
    .replace(/%EMAILDOMAIN%/g, at < 0 ? '' : e.slice(at + 1));
}
