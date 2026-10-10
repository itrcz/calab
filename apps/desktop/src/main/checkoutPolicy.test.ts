import { describe, expect, it } from 'vitest';
import {
  addressOf,
  barHtml,
  CANCEL_URL,
  checkoutNavigation,
  isSbpAppLink,
  extraStartHosts,
  mayNavigateCheckout,
  parseCheckoutStart,
  returnHosts,
  returnOutcome,
} from './checkoutPolicy';

describe('parseCheckoutStart (ADR-0084: the window starts only on a provider host)', () => {
  it('takes Stripe Checkout and Tochka payment links', () => {
    expect(parseCheckoutStart('https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWxOYHwnPyd1blpxYHZxWjA0')).toBe(
      'https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWxOYHwnPyd1blpxYHZxWjA0',
    );
    expect(parseCheckoutStart('  https://merch.securepaytb.ru/order/?uuid=5f0c1a7e ')).toBe('https://merch.securepaytb.ru/order/?uuid=5f0c1a7e');
    expect(parseCheckoutStart('https://merch.tochka.com/order/?uuid=1')).toBe('https://merch.tochka.com/order/?uuid=1');
    expect(parseCheckoutStart('https://CHECKOUT.Stripe.com/c/pay/x')).toBe('https://checkout.stripe.com/c/pay/x');
    // A one-click top-up's 3-D Secure page (Stripe test mode answered this host, 2026-10-10).
    expect(parseCheckoutStart('https://hooks.stripe.com/3d_secure_2/hosted?merchant=acct_1&payment_intent=pi_1')).toBe(
      'https://hooks.stripe.com/3d_secure_2/hosted?merchant=acct_1&payment_intent=pi_1',
    );
    expect(parseCheckoutStart('https://a.hooks.stripe.com/x')).toBeNull();
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['http', 'http://checkout.stripe.com/c/pay/x'],
    ['other host', 'https://evil.test/c/pay/x'],
    ['lookalike suffix', 'https://checkout.stripe.com.evil.test/x'],
    ['subdomain of an allowed host', 'https://a.checkout.stripe.com/x'],
    ['credentials', 'https://checkout.stripe.com@evil.test/x'],
    ['user info on the allowed host', 'https://u:p@checkout.stripe.com/x'],
    ['explicit port', 'https://checkout.stripe.com:8443/x'],
    ['backslash', 'https://evil.test\\@checkout.stripe.com/x'],
    ['whitespace inside', 'https://checkout.stripe.com/x y'],
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['too long', `https://checkout.stripe.com/${'a'.repeat(5000)}`],
  ])('refuses %s', (_name, raw) => {
    expect(parseCheckoutStart(raw)).toBeNull();
  });

  it('extra hosts come from the environment, hostnames only', () => {
    const extra = extraStartHosts(' merch.example.test , BAD HOST,https://x.test,localhost,pay.sandbox.example.com');
    expect(extra).toEqual(['merch.example.test', 'pay.sandbox.example.com']);
    expect(parseCheckoutStart('https://merch.example.test/order/?uuid=1', extra)).toBe('https://merch.example.test/order/?uuid=1');
    expect(parseCheckoutStart('https://merch.example.test/order/?uuid=1')).toBeNull();
    expect(extraStartHosts(undefined)).toEqual([]);
  });
});

describe('mayNavigateCheckout (3DS: any https page, nothing else)', () => {
  it.each([
    ['https://acs.somebank.ru/3ds/challenge', true],
    ['https://hooks.stripe.com/3d_secure_2/hosted', true],
    ['about:blank', true],
    ['http://acs.somebank.ru/3ds', false],
    ['data:text/html,<script>1</script>', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['calab://sso/complete?flow=a&ticket=b', false],
    ['https://u:p@acs.bank.test/', false],
  ])('%s → %s', (url, ok) => {
    expect(mayNavigateCheckout(url)).toBe(ok);
  });
});

describe('SBP on the desktop: the window stays on the QR (owner, 2026-10-10)', () => {
  const server = 'https://app.calab.io';

  it.each([
    'bank100000000111://qr.nspk.ru/AD10006M8KH?type=02',
    'https://qr.nspk.ru/AD10006M8KH?type=02&bank=100000000111',
    'https://sub.nspk.ru/AS1000?type=01',
  ])('%s is an SBP app link, kept on the page', (url) => {
    expect(isSbpAppLink(url)).toBe(true);
    expect(checkoutNavigation(url, server)).toEqual({ kind: 'stay' });
  });

  it.each(['bank1://x', 'bankx100000000111://x', 'https://qr.nspk.ru.evil.test/AD1', 'https://evil.test/qr.nspk.ru', 'https://checkout.stripe.com/x'])(
    'not an SBP link: %s',
    (url) => {
      expect(isSbpAppLink(url)).toBe(false);
    },
  );

  it('the checkout and 3DS load in place, other schemes stay, return pages close', () => {
    expect(checkoutNavigation('https://merch.securepaytb.ru/order/?uuid=1', server)).toEqual({ kind: 'load' });
    expect(checkoutNavigation('https://acs.somebank.ru/3ds', server)).toEqual({ kind: 'load' });
    expect(checkoutNavigation('intent://pay#Intent;scheme=bank;end', server)).toEqual({ kind: 'stay' });
    expect(checkoutNavigation('tg://resolve?domain=x', server)).toEqual({ kind: 'stay' });
    expect(checkoutNavigation('https://app.calab.io/api/billing/return?checkout=1', server)).toEqual({ kind: 'return', outcome: 'returned' });
    expect(checkoutNavigation('https://calab.io/onpay/fail', server)).toEqual({ kind: 'return', outcome: 'fail' });
  });
});

describe('returnOutcome (the payer is back)', () => {
  const server = 'https://app.calab.io';

  it('our return page (BILLING_PUBLIC_RETURN_URL) — success and cancel share it', () => {
    expect(returnOutcome('https://app.calab.io/api/billing/return?checkout=0b0c', server)).toBe('returned');
    expect(returnOutcome('https://app.calab.io/api/billing/return', server)).toBe('returned');
  });

  it('the landing pages of the Tochka merchant settings', () => {
    expect(returnOutcome('https://calab.io/onpay/success', server)).toBe('success');
    expect(returnOutcome('https://calab.io/onpay/fail?orderId=1', server)).toBe('fail');
    expect(returnOutcome('https://www.calab.io/onpay/success/', server)).toBe('success');
    expect(returnOutcome('https://calab.ru/onpay/success', 'https://app.calab.ru')).toBe('success');
  });

  it.each([
    'https://evil.test/api/billing/return?checkout=1',
    'https://app.calab.io.evil.test/api/billing/return',
    'https://app.calab.io/api/billing/returned',
    'https://evil.test/onpay/success',
    'https://calab.io.evil.test/onpay/success',
    'http://calab.io/onpay/success',
    'https://calab.io/onpay/successful',
    'https://user@calab.io/onpay/success',
    'https://checkout.stripe.com/c/pay/x',
    'not a url',
  ])('not %s', (url) => {
    expect(returnOutcome(url, server)).toBeNull();
  });

  it('a dev server on localhost: its own return page only', () => {
    expect(returnOutcome('http://localhost:8080/api/billing/return?checkout=1', 'http://localhost:8080')).toBe('returned');
    expect(returnHosts('not a url')).toBeNull();
    expect(returnOutcome('https://app.calab.io/api/billing/return', '')).toBeNull();
  });
});

describe('title bar', () => {
  it('shows the host and the lock for https only', () => {
    expect(addressOf('https://checkout.stripe.com/c/pay/x')).toEqual({ host: 'checkout.stripe.com', secure: true });
    expect(addressOf('http://acs.bank.test/')).toEqual({ host: 'acs.bank.test', secure: false });
    expect(addressOf('data:text/html,x')).toEqual({ host: '', secure: false });
  });

  it('is static HTML with no script; the host and the label are escaped', () => {
    const html = barHtml({ host: 'a"<b>.test', secure: true }, '<Cancel>');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('a&quot;&lt;b&gt;.test');
    expect(html).toContain('&lt;Cancel&gt;');
    expect(html).toContain(`href="${CANCEL_URL}"`);
    expect(html).toContain('class="lock"');
    expect(barHtml({ host: 'x.test', secure: false }, 'Cancel')).not.toContain('class="lock"');
  });
});
