// Behavioural checks of src/lib/offers.ts: mode → market/currency, parsing of the server body, formatting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const file = fileURLToPath(new globalThis.URL('../src/lib/offers.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const mod = { exports: {} };
vm.runInContext(`(function(module,exports){${outputText}\n})`, vm.createContext({ Intl, Number, Array, String }))(mod, mod.exports);
const { parseOffers, pickView, formatMoney, monthMinor, SNAPSHOT } = mod.exports;

const offer = (plan, minor, currency, market) => ({ plan, unitPrice: { minor: String(minor), currency }, market });
const body = (mode, markets, contact = 'https://forms.example/c') => ({
  mode,
  offers: [
    { plan: 'PLAN_FREE', limits: {}, market: 'global' },
    ...(markets.includes('global') ? [offer('PLAN_TEAM', 10, 'USD', 'global'), offer('PLAN_ENTERPRISE', 30, 'USD', 'global')] : []),
    ...(markets.includes('ru') ? [offer('PLAN_TEAM', 600, 'RUB', 'ru'), offer('PLAN_ENTERPRISE', 1800, 'RUB', 'ru')] : []),
  ],
  markets,
  contact,
});

const both = parseOffers(body('BILLING_SALES_MODE_BOTH', ['global', 'ru']));
const ruOnly = parseOffers(body('BILLING_SALES_MODE_RU_ONLY', ['ru']));
const globalOnly = parseOffers(body('BILLING_SALES_MODE_GLOBAL_ONLY', ['global']));
const contact = parseOffers(body('BILLING_SALES_MODE_CONTACT', []));
assert.equal(contact, null, 'contact mode without any offers is unusable');
const contactOk = parseOffers({ ...body('BILLING_SALES_MODE_CONTACT', ['global']), markets: [] });
assert.equal(contactOk.mode, 'contact');

// both: language decides, an explicit choice wins
assert.equal(pickView(both, 'ru', null).market, 'ru');
assert.equal(pickView(both, 'en', null).market, 'global');
assert.equal(pickView(both, 'zh', null).prices.team.currency, 'USD');
assert.equal(pickView(both, 'en', 'ru').market, 'ru');
assert.equal(pickView(both, 'ru', 'global').market, 'global');
assert.equal(pickView(both, 'ru', null).switchable, true);
// single-market modes ignore language and choice
for (const lang of ['ru', 'en']) {
  assert.equal(pickView(ruOnly, lang, 'global').prices.team.currency, 'RUB');
  assert.equal(pickView(globalOnly, lang, 'ru').prices.team.currency, 'USD');
  assert.equal(pickView(contactOk, lang, 'ru').prices.team.currency, 'USD');
}
assert.equal(pickView(ruOnly, 'en', null).switchable, false);
assert.equal(pickView(contactOk, 'ru', null).contactOnly, true);
assert.equal(pickView(contactOk, 'ru', null).contact, 'https://forms.example/c');

// fallback: snapshot by language, buttons stay safe
const snap = pickView(null, 'ru', null);
assert.equal(snap.mode, 'snapshot');
assert.deepEqual(snap.prices, SNAPSHOT.ru);
assert.deepEqual(pickView(null, 'es', null).prices, SNAPSHOT.global);

// untrusted bodies
for (const bad of [null, 'x', {}, { mode: 'BILLING_SALES_MODE_BOTH' }, { mode: 'nope', offers: [] },
  body('BILLING_SALES_MODE_BOTH', ['global']), // both needs both markets
  { ...body('BILLING_SALES_MODE_GLOBAL_ONLY', ['global']), offers: [offer('PLAN_TEAM', -5, 'USD', 'global')] },
  { ...body('BILLING_SALES_MODE_GLOBAL_ONLY', ['global']), offers: [offer('PLAN_TEAM', 10, 'RUB', 'global'), offer('PLAN_ENTERPRISE', 30, 'USD', 'global')] }]) {
  assert.equal(parseOffers(bad), null, JSON.stringify(bad)?.slice(0, 80));
}
assert.equal(parseOffers({ ...body('BILLING_SALES_MODE_GLOBAL_ONLY', ['global']), contact: 'javascript:alert(1)' }).contact, '');
assert.equal(parseOffers({ ...body('BILLING_SALES_MODE_GLOBAL_ONLY', ['global']), contact: 'mailto:it@x.io' }).contact, 'mailto:it@x.io');

// formatting
const nb = ' ';
assert.equal(formatMoney(600, 'RUB', 'ru'), `6${nb}₽`);
assert.equal(formatMoney(10, 'USD', 'en'), '$0.10');
assert.equal(formatMoney(10, 'USD', 'ru'), `0,10${nb}$`);
assert.equal(formatMoney(monthMinor({ minor: 10, currency: 'USD' }), 'USD', 'en'), '$3');
assert.equal(formatMoney(monthMinor({ minor: 1800, currency: 'RUB' }), 'RUB', 'ru'), `540${nb}₽`);
assert.equal(formatMoney(150, 'USD', 'en'), '$1.50');
console.log('offers: ok');
