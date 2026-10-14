// Behavioural checks of src/lib/mail-link.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const file = fileURLToPath(new globalThis.URL('../src/lib/mail-link.ts', import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const mod = { exports: {} };
vm.runInContext(
  `(function(module,exports){${outputText}\n})`,
  vm.createContext({ atob: globalThis.atob, TextDecoder, Uint8Array, String }),
)(mod, mod.exports);
const { parseMailHash, mailDeepLink } = mod.exports;

const b64u = (s) => Buffer.from(s).toString('base64url');
const ok = parseMailHash(`#mail=${b64u('Ann@Example.COM:p:ss')}`);
assert.deepEqual({ ...ok }, { email: 'Ann@example.com', hasPassword: true, payload: b64u('Ann@Example.COM:p:ss') });
assert.equal(parseMailHash(`#mail=${b64u('a@b.io')}`).hasPassword, false);
assert.equal(parseMailHash(`#mail=${b64u('a@b.io:')}`).hasPassword, false);
assert.equal(parseMailHash(`#x=1&mail=${Buffer.from('a@b.io:pw').toString('base64')}`).email, 'a@b.io');
assert.equal(parseMailHash(`#mail=${b64u('привет@b.io')}`).error, 'malformed');
assert.equal(parseMailHash('#mail=!!!').error, 'malformed');
assert.equal(parseMailHash(`#mail=${b64u('not-an-email:pw')}`).error, 'malformed');
assert.equal(parseMailHash('#mail=').error, 'malformed');
assert.equal(parseMailHash('#download'), null);
assert.equal(mailDeepLink('abc'), 'calab://mail/abc');
console.log('mail-link: ok');
