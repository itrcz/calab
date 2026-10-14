---
title: Security checklist
description: What to check in a “Sign in with Calab” integration before going to production.
order: 8
---

Calab closes many attack classes on its side: exact redirect URI matching, mandatory PKCE, single-use codes, refresh rotation that revokes the chain on replay, and a permission check on every exchange. Part of the protection, though, lives in your application. Go through this list before launch.

## Authorization request

- [ ] Every sign-in attempt gets a fresh `code_verifier`, `state` and `nonce` from a cryptographic generator, kept on the server (or in a protected cookie), never in the URL.
- [ ] `code_challenge_method=S256` — always, for every client type.
- [ ] Only the scopes you need are requested; `email` only if you really use it.
- [ ] The issuer and endpoints come from the discovery document of the intended workspace, never assembled from user input.

## Response at the redirect URI

- [ ] `state` is compared with the stored value; on mismatch the sign-in is aborted.
- [ ] The `iss` parameter is compared with the expected issuer (mix-up protection).
- [ ] The callback page keeps `code` out of logs, analytics and the `Referer` header (send `Referrer-Policy: no-referrer`).
- [ ] `error=access_denied` and other errors are handled without crashing and without an automatic redirect loop.

## Code exchange and tokens

- [ ] The client secret lives only on the server, in a secret store, and never reaches a browser or a mobile app. Public clients (SPA, native) have no secret at all.
- [ ] The client authenticates with an `Authorization: Basic` header, not in the request body.
- [ ] The ID token is fully verified: RS256 signature against the JWKS, `iss`, `aud` = your `client_id`, `exp`, `nonce`. The algorithm is pinned (`RS256`); `none` and HS* are rejected.
- [ ] Accounts are linked by the `(iss, sub)` pair, not by email or name.
- [ ] Access and refresh tokens are kept out of logs; refresh tokens are stored encrypted.
- [ ] Token refreshes run sequentially; the new refresh token is persisted before the new access token is used.
- [ ] `invalid_grant` and `invalid_token` lead to a new sign-in, not to endless retries.

## Client configuration

- [ ] Only the redirect URIs you need are registered, all `https://` (native apps: loopback or a private scheme).
- [ ] An SPA lists only its own origins.
- [ ] “Allow continued access” is on only if the application genuinely needs access for longer than 5 minutes.
- [ ] You have a secret rotation procedure: you know rotation revokes all access and are ready for people to sign in again; use the 10-minute window for planned rotations.
- [ ] Clients nobody uses any more are deleted.

## Sign-out and disconnecting

- [ ] Signing out of the application or disconnecting the integration calls [`/revoke`](./userinfo-refresh-revoke#revoke).
- [ ] You remember that revoking access in Calab does not end the session in your application: re-check access through `/userinfo` or a refresh before sensitive actions.

## What not to do

- Do not use an OAuth access token to call the Calab API — it does not work there. For automation, use [bots](../bots).
- Do not frame the consent page — Calab forbids it.
- Do not treat `email` as proof of owning a corporate mailbox: Calab sends only an address verified in the Calab account and asserts nothing about the corporate IdP.
- Do not cache the JWKS forever: the operator rotates signing keys.
