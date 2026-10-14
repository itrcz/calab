---
title: Sign-in modes
description: “Off”, “Optional” and “Required SSO” — what changes for members, guests, bots and the owner.
order: 2
---

A workspace's sign-in policy is set in the “Sign-in policy” card and comes in three modes. The server enforces it everywhere: on REST, when delivering realtime events (including replay after a reconnect), on file links and in calls.

<!-- screenshot: identity/policy -->

## The three modes

| Mode | In the app | Meaning |
|---|---|---|
| `IDENTITY_POLICY_MODE_OFF` | “Off” | Corporate sign-in is not required. Everyone signs in as usual, with their local account password |
| `IDENTITY_POLICY_MODE_OPTIONAL` | “Optional” | Employees may sign in with SSO, or with a password. Good for a pilot |
| `IDENTITY_POLICY_MODE_ENFORCED` | “Required SSO” | The workspace opens only with a fresh SSO confirmation. A password, password reset, invite or old session does not replace it |

The “Sign in with SSO” button appears for a workspace as soon as it has an **active, tested** connection and an active plan. The mode only decides whether that sign-in is required.

## What changes for people

| | “Off” / “Optional” | “Required SSO” |
|---|---|---|
| Local account password sign-in | Opens the workspace | Opens the account, but this workspace only after “Confirm corporate sign-in” |
| SSO sign-in | Corporate session, this workspace only | Same |
| SSO confirmation lifetime | 1 hour for a corporate session | 1 hour for any session; then sign in to the IdP again |
| Direct messages, notes, other workspaces | Available from the local account | Available from the local account; a corporate session doesn't see them |
| Workspace invite | Works as usual | The person completes sign-up and linking, but sees workspace data only after SSO |

When the SSO confirmation expires, the app shows “This workspace requires a fresh corporate sign-in. Other workspaces and direct messages remain available.” The person's other workspaces are not affected.

### A corporate session is limited

A session obtained through SSO works only in its own workspace. It cannot reach:

- other workspaces or the list of the person's workspaces;
- direct messages and personal notes;
- password, email and session management;
- creating new workspaces and superadmin features.

For those, sign in to the local account (in the app — “Sign in to your local account”). Refreshing a corporate session neither extends the SSO confirmation nor widens its scope.

## Guests

Guest access is incompatible with required SSO: when the mode is turned on, the workspace's guests lose access, and guest links and guest invites stop working. Guests do not go through corporate sign-in and cannot link a corporate identity.

## Bots

Bots never sign in with SSO and never get corporate sessions. They work with their own tokens and role permissions — see [bots](../bots). The sign-in policy does not apply to bots; workspace suspension does.

## The owner

The owner manages the connection and the policy only from their **local** account with a confirmed password (a sign-in from the last 5 minutes). Under required SSO, changing the connection, policy, directory, recovery kit or OAuth clients also needs an SSO confirmation from the last 5 minutes. Details — [reauthentication](./reauth).

## Turning on required mode

Calab won't let you turn on “Required SSO” until all of this holds at once:

1. There is an active connection, tested by signing in through the browser.
2. The owner's corporate identity is linked to their account.
3. The owner has confirmed the password and passed SSO — both within the last 5 minutes.
4. A valid [recovery kit](./recovery-kit) exists and “Recovery kit saved” is checked.

> [!WARNING]
> Before turning it on, make sure every employee has already linked a corporate identity in “Optional” mode. An unlinked employee cannot enter the workspace afterwards until they link one.

## Turning it off and downgrades

- Moving from “Required SSO” to “Optional” or “Off” is an explicit owner action: a confirmed password plus fresh SSO, or a recovery session from the [recovery kit](./recovery-kit). The action is recorded in the audit log.
- A broken IdP or a plan downgrade does **not** lift required mode. The workspace becomes locked (“Corporate features require active Business or Enterprise access. Required SSO stays enforced.”), and the owner repairs the policy through recovery.
- On a downgrade, data, links and consents are kept; new SSO sign-ins, OAuth token issuance and directory sync stop.

## Changes apply immediately

A policy or connection change, a ban, removing a member or a directory disable revokes access precisely: open realtime connections and calls are closed rather than waiting for the next request. As a safety net against lost messages between servers, a positive decision is cached for at most 30 seconds.
