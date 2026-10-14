---
title: What you can integrate
description: Three ways to connect Calab to your systems — bots and the integration API, sign-in with Calab over OAuth 2 / OIDC, and SSO with an AD directory.
order: 1
---

Calab is a voice-first messenger for teams: workspaces, rooms, calls, task boards and a calendar. Everything people see in the app is available to programs through three open interfaces. This documentation is for integration developers and workspace admins.

| You want to… | Use | Section |
|---|---|---|
| Have a program post to rooms, answer commands, manage tasks, join voice | A **bot** with its REST API and gateway | [Bots and integration API](../bots) |
| Let people sign in to your service “with Calab” and learn who they are | **OAuth 2 / OpenID Connect** with Calab as the provider | [OAuth 2 / OIDC](../oauth) |
| Have people sign in to Calab with their corporate account and keep the team in sync with AD | **OIDC SSO** and an **LDAPS directory** | [SSO and directory](../sso) |

## Bots — the integration API

A Calab bot is an ordinary workspace member with a bot flag. It calls the same REST API and the same realtime gateway as the app, and it can do exactly what its roles allow — just like a person. There is no separate, cut-down API: a CRM that creates tasks on a board, a monitoring system that posts alerts to a room, a voice assistant in a call — they are all bots.

- [Quickstart](../bots/quickstart) — a bot, a token and the first message in five minutes.
- [Token and permissions](../bots/auth) — what a bot can do, and what it can never do.
- [Gateway](../bots/gateway) and [webhooks](../bots/webhooks) — how to receive events.

## OAuth 2 / OIDC

Every workspace is its own OpenID provider with its own issuer. You register a client in the workspace settings, and your application gets a verified member identity — id, name and email — through Authorization Code + PKCE. It fits internal portals, CRMs and wikis: anything where people should sign in “the Calab way”. Details are in [OAuth 2 / OIDC](../oauth).

## SSO and directory

A workspace admin connects a corporate OpenID Connect provider — Microsoft Entra ID, AD FS or any compliant one — and decides whether signing in through it is required. An LDAPS directory checks members against Active Directory groups, so someone who leaves the company loses access automatically. Details are in [SSO and directory](../sso).

## Base URLs

Examples use placeholder addresses — substitute your own.

| Address | What lives there | Example |
|---|---|---|
| App address (`APP_HOST`) | REST API (`/api/…`), the gateway (`/gateway`), task links | `https://app.example.com` |
| Identity public origin (`IDENTITY_PUBLIC_ORIGIN`) | The workspaces' OIDC provider (`/oidc/workspaces/{id}/…`), SSO return addresses | `https://id.example.com` |

On many installations both are the same: the API server also serves identity. Ask your server's operator for the exact values; on Calab cloud it is the address where you open the web app.

> [!NOTE]
> Once identity is switched on for a server, the OIDC issuer never changes — it is the value you configure in your application and at your SSO provider.

## Versions

- **REST** has no version in the path: the contract only grows — new fields are added, existing ones keep their meaning. The server ignores unknown request fields, and your client should likewise skip response fields it doesn't know.
- **The gateway** is opened with an explicit protocol version: `wss://app.example.com/gateway?v=1`.
- **The server version** is `GET /api/version`, no authentication. See [API version](../reference/version).

## Where to get tokens

| Token | Where | Details |
|---|---|---|
| Bot token `calab_bot_…` | “Workspace settings → Bots → Create bot” — shown once | [Token and permissions](../bots/auth) |
| OAuth client `client_id` / `client_secret` | Workspace settings → OAuth | [Register a client](../oauth/register-client) |
| OAuth access / refresh tokens | Issued by the token endpoint after the user consents | [Tokens and lifetimes](../oauth/tokens) |

All formats are listed in the [token reference](../reference/tokens).

## Limits

A bot gets 30 requests per second and 20 messages per minute — plenty for integrations, not enough for mass mailing. The full table is in [Limits](../reference/limits). Going over returns `429` with a `Retry-After` header.

## Types and contract

Every request and response body is a protobuf message in JSON (protojson): lowerCamelCase fields, enums by full name (`"ROOM_TYPE_VOICE"`), `uint64` as strings, times in RFC 3339. The schemas live in the open repository [github.com/itrcz/calab](https://github.com/itrcz/calab) under `proto/`; the TypeScript and Go types are generated from them. For Node.js there is a ready-made [SDK](../bots/sdk).

## Support

Questions and bug reports go to the repository's [issues](https://github.com/itrcz/calab/issues). If you found a vulnerability, don't publish it in an issue — contact the server's owners directly.
