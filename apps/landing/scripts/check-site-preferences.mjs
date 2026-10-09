// Focused behavioural checks: optional storage must fail closed on both entry paths.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new globalThis.URL('../src/', import.meta.url));
const values = new Map();
let blocked = false;
let blockedWrite = false;
const localStorage = {
  getItem(key) { if (blocked) throw new Error('blocked'); return values.get(key) ?? null; },
  setItem(key, value) { if (blocked || blockedWrite) throw new Error('blocked'); values.set(key, value); },
  removeItem(key) { if (blocked) throw new Error('blocked'); values.delete(key); },
};
const context = vm.createContext({ localStorage, window: new globalThis.EventTarget(), Event: globalThis.Event, Response: globalThis.Response, Date });
const cache = new Map();
function load(path) {
  if (cache.has(path)) return cache.get(path);
  const source = readFileSync(path, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loaded = { exports: {} };
  const require = (name) => {
    assert.ok(name.startsWith('@/'), `unexpected import ${name}`);
    return load(resolve(root, name.slice(2) + '.ts'));
  };
  vm.runInContext(`(function(require,module,exports){${outputText}\n})`, context)(require, loaded, loaded.exports);
  cache.set(path, loaded.exports);
  return loaded.exports;
}
const consent = load(resolve(root, 'lib/site-preferences.ts'));
const router = load(resolve(root, 'app/index.html/route.ts'));
const html = await router.GET().text();
const redirect = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const now = Date.now();
const choice = (fields = {}) => ({ version: 1, savedAt: now - 1_000, expiresAt: now + 10_000, language: true, analytics: false, marketing: false, ...fields });
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`✓ ${name}`); }
function route(record, savedLanguage = 'ru', languages = ['es-ES']) {
  values.clear();
  if (record !== undefined) values.set(consent.PREFERENCES_KEY, typeof record === 'string' ? record : JSON.stringify(record));
  values.set('calab.locale', savedLanguage);
  let location;
  vm.runInNewContext(redirect, {
    localStorage, navigator: { languages }, Date,
    location: { search: '?from=test', hash: '#pricing', replace(url) { location = url; } },
  });
  return location;
}
check('valid permission enables the saved language and preserves query/hash', () => {
  assert.equal(route(choice()), '/ru/?from=test#pricing');
  assert.equal(consent.hasSiteConsent('language'), true);
});
const invalid = [
  ['no choice', undefined], ['corrupt JSON', '{'], ['primitive JSON', 'true'],
  ['rejected', choice({ language: false })], ['expired', choice({ expiresAt: now - 1 })],
  ['future choice', choice({ savedAt: now + 60_000 })], ['old version', choice({ version: 0 })],
  ['lifetime too long', choice({ expiresAt: now + consent.PREFERENCES_TTL + 1_000 })],
  ['unknown purpose grant', choice({ analytics: true })], ['wrong flag type', choice({ language: 'yes' })],
  ['missing purpose', { version: 1, savedAt: now - 1000, expiresAt: now + 10000, language: true }],
];
for (const [name, record] of invalid) check(`${name}: root and helper both deny optional storage`, () => {
  assert.equal(route(record), '/es/?from=test#pricing');
  assert.equal(consent.hasSiteConsent('language'), false);
  assert.equal(values.has('calab.locale'), false);
});
check('unknown saved locale falls back to supported browser language', () => {
  assert.equal(route(choice(), 'xx', ['de-DE', 'zh-CN']), '/zh/?from=test#pricing');
});
check('unsupported browser language falls back to English', () => {
  assert.equal(route(undefined, 'ru', ['de-DE']), '/en/?from=test#pricing');
});
check('allow, switch language, then withdraw deletes optional data', () => {
  assert.equal(consent.savePreferences(true, 'en'), true);
  assert.equal(values.get('calab.locale'), 'en');
  consent.rememberLocale('zh');
  assert.equal(values.get('calab.locale'), 'zh');
  assert.equal(consent.savePreferences(false, 'ru'), true);
  assert.equal(values.has('calab.locale'), false);
  consent.rememberLocale('es');
  assert.equal(values.has('calab.locale'), false);
});
check('unconnected analytics and marketing cannot be granted', () => {
  consent.savePreferences(true, 'en');
  assert.equal(consent.hasSiteConsent('analytics'), false);
  assert.equal(consent.hasSiteConsent('marketing'), false);
});
check('blocked reads preserve navigation and cannot grant consent', () => {
  blocked = true;
  assert.equal(route(choice()), '/es/?from=test#pricing');
  assert.equal(consent.hasSiteConsent('language'), false);
  assert.equal(consent.savePreferences(true, 'ru'), false);
  blocked = false;
});
check('failed write removes the old grant and saved language', () => {
  consent.savePreferences(true, 'en');
  blockedWrite = true;
  assert.equal(consent.savePreferences(true, 'ru'), false);
  assert.equal(values.has('calab.locale'), false);
  assert.equal(consent.hasSiteConsent('language'), false);
  blockedWrite = false;
});
console.log(`${checks} preference and root-router checks passed`);
