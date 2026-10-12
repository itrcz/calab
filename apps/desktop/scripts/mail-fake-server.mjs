#!/usr/bin/env node
/**
 * A local IMAP + SMTP server for trying the mail client end to end without Docker (ADR-0088,
 * TESTING.md §2.19): hoodiecrow-imap (IDLE, SPECIAL-USE, MOVE, UIDPLUS, CONDSTORE) and smtp-server,
 * both over implicit TLS with the test certificate of infra/docker/greenmail/gen-cert.sh (made on the
 * first run). Same ports and users as the GreenMail of the dev compose, so engine.it.test.ts runs
 * against either: IMAPS 127.0.0.1:3993, SMTPS 127.0.0.1:3465, alice@example.test / bob@example.test,
 * password `secret` (all users share one mailbox — hoodiecrow is single-user). Test only.
 *
 *   node scripts/mail-fake-server.mjs          # serve (state lives in memory; Ctrl-C to stop)
 *   node scripts/mail-fake-server.mjs send     # bob sends alice a new message over SMTP
 *
 * The app trusts the certificate through NODE_EXTRA_CA_CERTS (the engine checks TLS strictly):
 *   NODE_EXTRA_CA_CERTS=$PWD/../../infra/docker/greenmail/certs/ca.pem pnpm dev
 * Env: MAIL_FAKE_IMAP_PORT, MAIL_FAKE_SMTP_PORT.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const certDir = resolve(here, '../../../infra/docker/greenmail/certs');
const IMAP_PORT = Number(process.env.MAIL_FAKE_IMAP_PORT ?? 3993);
const SMTP_PORT = Number(process.env.MAIL_FAKE_SMTP_PORT ?? 3465);
const USERS = { 'alice@example.test': 'secret', alice: 'secret', 'bob@example.test': 'secret', bob: 'secret' };

if (!existsSync(join(certDir, 'key.pem')) || !existsSync(join(certDir, 'ca.pem'))) {
  execFileSync('sh', [resolve(certDir, '../gen-cert.sh')], { stdio: 'inherit' });
}
const key = readFileSync(join(certDir, 'key.pem'));
const cert = readFileSync(join(certDir, 'ca.pem'));

const MailComposer = require('nodemailer/lib/mail-composer');
const nodemailer = require('nodemailer');

/** RFC 822 text of a message (nodemailer builds the MIME). */
function compose(opts) {
  return new Promise((ok, fail) => {
    new MailComposer({ ...opts, messageId: opts.messageId ?? `<${Math.random().toString(36).slice(2)}@example.test>` }).compile().build((err, buf) => (err ? fail(err) : ok(buf.toString('binary'))));
  });
}

// A 2×2 red PNG (the cid: image) and a tiny PDF-ish attachment.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkZGBgYGAAkBQEBn9FcIgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

async function seed() {
  const day = 24 * 3600 * 1000;
  const at = (daysAgo) => new Date(Date.now() - daysAgo * day);
  const inbox = [
    await compose({
      from: 'Maria Lumen <maria@lumen.example>',
      to: 'alice@example.test',
      subject: 'Logo and contract',
      date: at(1),
      html: '<p>Hi Alice,</p><p>Here is the final logo:</p><p><img src="cid:logo@lumen" width="120" alt="logo"></p><p>Details on <a href="https://calab.io">our site</a>, questions to <a href="mailto:maria@lumen.example?subject=Logo%20question">Maria</a>.</p><p>Best, Maria</p>',
      text: 'Hi Alice,\n\nHere is the final logo. Details on https://calab.io\n\nBest, Maria',
      attachments: [
        { filename: 'logo.png', content: PNG, contentType: 'image/png', cid: 'logo@lumen' },
        { filename: 'Договор.pdf', content: PDF, contentType: 'application/pdf' },
      ],
    }),
    await compose({
      from: 'Bob <bob@example.test>',
      to: 'alice@example.test',
      subject: 'Plain text note',
      date: at(2),
      text: 'Alice,\n\nthis one is text/plain only — it must follow the app theme.\nLink: https://example.com/notes and mail bob@example.test.\n\n> quoted line\n\n— Bob',
    }),
    await compose({
      from: 'Market <news@market.example>',
      to: 'alice@example.test',
      subject: 'Sale: 30% off',
      date: at(3),
      html: '<html><body style="background:#f4f4f4"><table width="100%" bgcolor="#f4f4f4"><tr><td align="center"><table width="560" bgcolor="#ffffff"><tr><td style="padding:24px;color:#222;font-family:Arial"><h1 style="color:#e4572e">Sale</h1><p>Only this week.</p><img src="https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png" width="92" alt=""><p><a href="https://market.example/sale">Shop now</a></p></td></tr></table></td></tr></table></body></html>',
    }),
  ];
  return {
    INBOX: { messages: inbox.map((raw, i) => ({ raw, flags: i === 2 ? ['\\Seen'] : [], internaldate: at(i + 1) })) },
    '': {
      separator: '/',
      folders: {
        Sent: { 'special-use': '\\Sent', subscribed: true },
        Drafts: { 'special-use': '\\Drafts', subscribed: true },
        Junk: { 'special-use': '\\Junk', subscribed: true },
        Trash: { 'special-use': '\\Trash', subscribed: true },
      },
    },
  };
}

async function serve() {
  const hoodiecrow = require('hoodiecrow-imap');
  const { SMTPServer } = require('smtp-server');
  const users = Object.fromEntries(Object.entries(USERS).map(([u, password]) => [u, { password }]));
  const imap = hoodiecrow({
    secureConnection: true,
    credentials: { key, cert },
    users,
    plugins: ['ID', 'IDLE', 'NAMESPACE', 'UNSELECT', 'ENABLE', 'CONDSTORE', 'SPECIAL-USE', 'UIDPLUS', 'MOVE', 'LITERALPLUS', 'ESEARCH', 'AUTH-PLAIN', 'SASL-IR'],
    storage: await seed(),
  });
  imap.listen(IMAP_PORT, '127.0.0.1', () => console.log(`IMAPS 127.0.0.1:${IMAP_PORT}`));

  const smtp = new SMTPServer({
    secure: true,
    key,
    cert,
    banner: 'calab mail fake',
    logger: false,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _session, done) {
      if (USERS[auth.username] && USERS[auth.username] === auth.password) done(null, { user: auth.username });
      else done(new Error('Invalid username or password'));
    },
    onData(stream, session, done) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', done);
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('binary');
        const subject = /^Subject: (.*)$/im.exec(raw)?.[1] ?? '';
        const to = session.envelope.rcptTo.map((r) => r.address);
        console.log(`SMTP ${session.user ?? '-'}: ${session.envelope.mailFrom?.address ?? ''} → ${to.join(', ')} «${subject}»`);
        // One shared mailbox: anything for our users lands in INBOX (IDLE clients are told at once).
        if (to.some((a) => USERS[a.toLowerCase()])) imap.appendMessage('INBOX', [], new Date(), raw);
        done();
      });
    },
  });
  smtp.listen(SMTP_PORT, '127.0.0.1', () => console.log(`SMTPS 127.0.0.1:${SMTP_PORT}`));
}

async function send() {
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: SMTP_PORT, secure: true, auth: { user: 'bob', pass: 'secret' }, tls: { ca: cert, servername: 'localhost' } });
  const stamp = new Date().toLocaleTimeString('en-GB');
  await t.sendMail({ from: 'Bob <bob@example.test>', to: 'alice@example.test', subject: `New message ${stamp}`, text: `Sent at ${stamp} while the client was idle.` });
  console.log(`sent «New message ${stamp}»`);
}

(process.argv[2] === 'send' ? send() : serve()).catch((e) => {
  console.error(e);
  process.exit(1);
});
