---
title: SSO and directory
description: Corporate sign-in with OpenID Connect and Active Directory access control — what it gives a workspace and how it works.
order: 1
---

Calab can let employees into a workspace through your organization's identity provider (IdP) and check their access against Active Directory. This chapter is for workspace owners who set up sign-in and for operators who run their own Calab installation.

## What's included

| Capability | What it does | Protocol |
|---|---|---|
| Corporate sign-in (SSO) | Employees sign in to the workspace through your IdP; in required mode, that is the only way in | OpenID Connect, Authorization Code + PKCE S256 |
| Directory (AD) | Every 5 minutes, checks who your organization still allows in; disabled and deleted accounts lose access | LDAPS (read-only) |
| Recovery | A set of one-time codes so the owner can repair the policy if the IdP breaks | — |

Supported IdPs: any OpenID Connect provider ([generic OIDC](./oidc-generic)), [Microsoft Entra ID](./oidc-entra) and [AD FS 2019+](./oidc-adfs). SAML is not supported — see [limitations](./limitations).

> [!NOTE]
> The opposite direction — third-party apps letting people sign in “with Calab” — is covered in [OAuth 2 / OIDC](../oauth).

## The workspace is the trust boundary

Everything about corporate sign-in belongs to one workspace: the IdP connection, the policy, the directory and each employee's link. Your IdP's answer opens your workspace and nothing else:

- a session obtained through SSO works **only in that workspace** — no direct messages, personal notes, other workspaces or password management;
- accounts are **never merged by email**: a corporate identity is linked to a Calab account only explicitly, after that account's password is confirmed;
- data from the IdP (claims) never makes anyone an owner, admin or superadmin.

This way an administrator of somebody else's IdP cannot reach other people's data by presenting a matching email address.

## Terms

| Term | Meaning |
|---|---|
| IdP | Your organization's identity provider: Entra ID, AD FS, Keycloak, Okta, etc. |
| SSO connection | The IdP settings in a workspace: issuer, Client ID, secret. One active connection per workspace |
| External identity | The pair “connection + `sub` from the ID token”, explicitly linked to a Calab account |
| Local account | A regular Calab account with a password. Its session sees all of the person's workspaces |
| Corporate session | A session obtained by signing in with SSO. Limited to one workspace |
| SSO assurance | A mark that “this session recently passed corporate sign-in”. Valid for 1 hour |
| Password confirmation | A fresh entry of the local account password. Valid for 5 minutes for administration |
| Recovery kit | 10 one-time codes for repairing the policy, valid for 365 days |
| Directory | A read-only LDAPS connection to Active Directory used to check employee status |

## Requirements

- **Plan.** Business in the cloud or Enterprise on your own installation. On Free and Team, or with an expired plan, the tab is locked.
- **Server.** The installation's operator has set the `IDENTITY_*` variables (see [for operators](./operators)). If not, settings show “Corporate sign-in and OAuth are not configured on this server”.
- **Who configures it.** Only the workspace owner, signed in to their **local** account. Before each change Calab asks to confirm the password (a sign-in from the last 5 minutes).

## Where to find it

Workspace settings → “SSO settings”. The tab has the cards “Corporate sign-in” (your status), “SSO connection”, “Test and activate”, “Sign-in policy”, “Account recovery” and “Active Directory”.

<!-- screenshot: identity/overview -->

## Rollout order

1. Register an application in your IdP and create the “SSO connection” — [generic](./oidc-generic), [Entra](./oidc-entra) or [AD FS](./oidc-adfs).
2. Link your own corporate identity, “Test sign-in in browser”, then “Activate tested connection”.
3. Set the policy to “Optional” and let employees link their identities — see [modes](./modes).
4. If needed, connect the [directory](./directory).
5. Generate and store a [recovery kit](./recovery-kit).
6. Switch the policy to “Required SSO”.

> [!TIP]
> Don't turn on required mode on day one. “Optional” lets you test sign-in with real employees without breaking anything.

## Next steps

- [Sign-in modes](./modes) — what changes for members, guests and bots.
- [Reauthentication](./reauth) — which confirmations are required and when.
- [Troubleshooting](./troubleshooting) — common errors and how to fix them.
