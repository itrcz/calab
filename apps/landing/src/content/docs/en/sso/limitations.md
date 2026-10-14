---
title: Limitations
description: What Calab corporate sign-in and directory don't do — SAML, SCIM, automatic account creation and more — and what to use instead.
order: 11
---

Corporate sign-in is deliberately narrow: each missing capability is one more way a foreign IdP or a misconfiguration can't open more than it should. Here is what isn't supported and how to work around it.

## Not supported

| Not available | Why | Use instead |
|---|---|---|
| **SAML 2.0** | OpenID Connect only | Most IdPs (Entra ID, AD FS 2019+, Okta, Keycloak) speak OIDC — connect through it |
| **SCIM** and automatic member creation/removal | No inbound provisioning API | Workspace invites + the [directory](./directory) to close access |
| **JIT account creation** on first SSO sign-in | A Calab account is created only through regular sign-up | Invite the employee; they sign up, then link their IdP account |
| **Merging accounts by email** | An email from the IdP isn't treated as proof | Explicit linking: “Link corporate identity” with a password confirmation |
| **Role assignment from IdP or AD groups** | Groups only filter access | Assign roles in Calab manually, or by a bot with `MANAGE_ROLES` |
| **Several active connections** in one workspace | One active OIDC connection per workspace | One IdP broker (e.g. Keycloak) in front of several sources |
| **Single logout (SLO)** | Signing out of the IdP doesn't end Calab sessions, and vice versa | The SSO confirmation expires within 1 hour; required mode then asks for a new sign-in |
| **Plain LDAP, StartTLS, custom filters** | LDAPS on port 636 with a built-in filter only | Enable LDAPS on your domain controller |
| **Directories other than Active Directory** | Sync reads AD attributes (`objectGUID`, `userAccountControl`, `memberOf`) | — |
| **A cloud connector** into a closed network | The directory and an internal IdP must be reachable from the Calab server directly | Your own Calab installation inside the network, or operator approval for the addresses |
| **Importing AD passwords** | AD passwords never reach Calab | Sign in through the IdP |
| **SSO for guests and bots** | Guest access is incompatible with required SSO; bots work with tokens | Guests only in workspaces without required SSO; for bots see [bots](../bots) |

## Worth knowing

- **An SSO session is limited to its workspace.** DMs, notes and other workspaces are available only from the local account. This is a protection boundary, not a gap.
- **Secret rotation means signing in again.** Changing the secret or issuer revokes current SSO confirmations; there is no seamless rotation.
- **Directory revocation delay.** A disable in AD takes effect with the next sync — within 5 minutes, not instantly.
- **Fail closed when unsure.** If Calab can't verify access (the database is unavailable, or the directory hasn't synced for over an hour), it closes access rather than opening it.
- **Recovery without a password and codes is manual.** If the owner has lost both the password and the recovery kit, only support or the operator can help.
- **Compatibility.** The Entra ID and AD FS integrations follow the providers' specifications; if your IdP behaves differently, start in “Optional” mode and see [troubleshooting](./troubleshooting).
