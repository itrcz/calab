/**
 * Unit tests of MailEngine.verify (ADR-0088 §4) failure logging: every failed add-account attempt
 * leaves exactly one 'mail: verify failed' line in the engine log (stderr → main's main.log) with
 * the step, the tried server and the classified code — never the password, never a command.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailServerSettings } from '../../shared/mail';
import type { DiscoverNet } from './discover';
import { MailEngine, type EngineDeps } from './service';

const IMAP: MailServerSettings = { host: 'imap.example.test', port: 993, security: 'tls' };
const SMTP: MailServerSettings = { host: 'smtp.example.test', port: 465, security: 'tls' };
const SETTINGS = { imap: IMAP, smtp: SMTP, login: 'bob@example.test' };
const INPUT = { email: 'bob@example.test', password: 'app-password-123' };

const sockErr = (code: string): Error => Object.assign(new Error(`${code}: trouble`), { code });

/** Nothing on the network: discovery runs out of candidates and fails fast. */
const deadNet: DiscoverNet = {
  resolveMx: () => Promise.resolve([]),
  resolveSrv: () => Promise.resolve([]),
  fetchText: () => Promise.resolve(null),
  probe: () => Promise.resolve({ ok: false }),
};

describe('mail engine verify failure logging', () => {
  let dir: string;
  let engine: MailEngine;
  let logs: Array<{ message: string; meta: Record<string, unknown> }>;
  let smtpCalls: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calab-mail-verify-'));
    logs = [];
    smtpCalls = 0;
  });

  afterEach(async () => {
    await engine.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (over: Partial<EngineDeps>): void => {
    engine = new MailEngine({
      dataDir: dir,
      emit: () => undefined,
      connectImap: () => Promise.reject(new Error('not used here')),
      verifyImap: () => Promise.resolve(),
      verifySmtp: () => {
        smtpCalls++;
        return Promise.resolve();
      },
      smtpSend: () => Promise.resolve(),
      discoverNet: deadNet,
      ...over,
      log: (message, meta) => logs.push({ message, meta: meta ?? {} }),
    });
  };

  it('a failing verifyImap: one line with the step, tried server, code and error detail', async () => {
    make({
      verifyImap: () => Promise.reject(sockErr('ECONNREFUSED')),
      verifySmtp: () => {
        smtpCalls++;
        return Promise.reject(sockErr('ETIMEDOUT'));
      },
    });
    await expect(engine.verify({ ...INPUT, settings: SETTINGS })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(logs).toHaveLength(1); // the first failure throws: smtp is never reached, never logged
    expect(smtpCalls).toBe(0);
    expect(logs.at(0)?.message).toBe('mail: verify failed');
    expect(logs.at(0)?.meta).toMatchObject({
      email: 'bob@example.test',
      step: 'imap',
      server: 'imap.example.test:993',
      security: 'tls',
      code: 'NETWORK',
      errCode: 'ECONNREFUSED',
      message: 'ECONNREFUSED: trouble',
    });
    expect(JSON.stringify(logs)).not.toContain('app-password-123');
  });

  it('a failing verifySmtp: the same line with step smtp', async () => {
    make({
      verifySmtp: () => {
        smtpCalls++;
        return Promise.reject(sockErr('ETIMEDOUT'));
      },
    });
    await expect(engine.verify({ ...INPUT, settings: SETTINGS })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(logs).toHaveLength(1);
    expect(smtpCalls).toBe(1);
    expect(logs.at(0)?.meta).toMatchObject({ email: 'bob@example.test', step: 'smtp', server: 'smtp.example.test:465', security: 'tls', code: 'NETWORK', errCode: 'ETIMEDOUT' });
    expect(JSON.stringify(logs)).not.toContain('app-password-123');
  });

  it('a discovery failure: one line with the domain and the code', async () => {
    make({});
    await expect(engine.verify(INPUT)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' });
    expect(logs).toHaveLength(1);
    expect(logs.at(0)?.meta).toMatchObject({ email: 'bob@example.test', domain: 'example.test', code: 'DISCOVERY_FAILED' });
    // A known unsupported provider fails discovery the same way (one line, its own code).
    await expect(engine.verify({ email: 'bob@outlook.com', password: 'app-password-123' })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    expect(logs).toHaveLength(2);
    expect(logs.at(1)?.meta).toMatchObject({ email: 'bob@outlook.com', domain: 'outlook.com', code: 'UNSUPPORTED_PROVIDER' });
    expect(JSON.stringify(logs)).not.toContain('app-password-123');
  });

  it('a successful verify logs nothing', async () => {
    make({});
    await expect(engine.verify({ ...INPUT, settings: SETTINGS })).resolves.toMatchObject({ provider: 'other', login: 'bob@example.test' });
    expect(logs).toEqual([]);
  });
});
