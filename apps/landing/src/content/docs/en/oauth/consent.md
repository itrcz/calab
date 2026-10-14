---
title: Consent screen and user access
description: What people see when signing in with Calab, how repeat sign-ins work and how to revoke an application's access.
order: 6
---

Calab never hands tokens to an application silently on the first sign-in: the person confirms that the application may learn who they are. A workspace admin cannot consent on members' behalf.

## What the person sees

After `/authorize`, the browser lands on Calab's consent page (`https://id.example.com/oauth/consent?request=…`):

1. If the person is not signed in to Calab in this browser — a normal sign-in.
2. If the workspace uses “Required SSO” and the corporate sign-in is stale — a sign-in through the corporate IdP ([re-authentication](../sso/reauth)).
3. The **“Allow sign-in to application?”** screen:
   - the application name (as the client's admin entered it);
   - the workspace and the account name used for sign-in;
   - the requested profile data: name, email;
   - an **“Allow continued access”** box — only when the client asks for refresh tokens; without it the application gets 5 minutes of access with no renewal;
   - the note: “The app receives only the selected profile data in this workspace. It cannot access chats or other workspaces.”
4. **“Allow”** and **“Deny”** buttons. Denying returns the person to the application with `error=access_denied`.

Rules and limits:

- A sign-in request is valid for **10 minutes**. After that, start the sign-in in the application again.
- Only workspace members can sign in. Guests and bots are refused.
- If an admin renames the client while the screen is open, Calab shows the new name once more before issuing a code.
- The consent page cannot be framed (`frame-ancestors 'none'`).
- One browser holds at most 4 unfinished sign-ins at a time; older ones are dropped.

## Repeat sign-ins

Consent is remembered for the “member + client” pair with a specific set of scopes and a refresh decision.

- `prompt=none` — a silent sign-in with no UI: it works when there is a Calab session in this browser, consent for the same (or wider) scopes, and the client name has not changed. Otherwise you get `login_required`, `consent_required` or `interaction_required`.
- `prompt=consent` — show the consent screen even if consent exists.
- `prompt=login` or `max_age` — require a fresh Calab sign-in (a session refresh does not count).
- New consent on a device replaces the previous access of **that device**. If the person narrows the data or unticks “Allow continued access”, Calab closes the application's access **on all their devices**, so no wider access survives anywhere.

## Managing access: “OAuth apps”

Everyone sees the applications they signed in to with Calab under **Settings → “OAuth apps”**: the application name, the workspace, the scopes and the expiry (“Valid until”). **“Revoke access”**:

- revokes the consent and **all** access of that application in that workspace on every device;
- the next sign-in to the application shows the consent screen again;
- does not delete data the application already stored, and does not end the person's session inside the application — that is the application's responsibility.

> [!NOTE]
> For a person signed in through corporate SSO, the list shows only applications of the workspace their session belongs to.

### API used by the Calab app

These routes back the “OAuth apps” screen and require a person's session (bot tokens and OAuth tokens are rejected; guests are not allowed).

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/me/oauth-grants` | List access grants → `{grants: [...]}` |
| `DELETE` | `/api/me/oauth-grants/{grant}` | Revoke an application's access → `204` |

```json
{
  "grants": [
    {
      "id": "0192a2c4-1d7e-7f30-8b91-2a3b4c5d6e7f",
      "workspaceId": "0192a000-0000-7000-8000-0000000000aa",
      "clientName": "Acme CRM",
      "scopes": ["email", "openid", "profile"],
      "createdAt": "2026-10-14T09:05:00Z",
      "expiresAt": "2026-10-14T17:05:00Z"
    }
  ]
}
```

## For application developers

- Make it clear that sign-in goes “through Calab” and into which workspace — every workspace has its own issuer.
- Handle `error=access_denied` gracefully: the person is entitled to say no.
- Do not ask for `email` unless you need it: the less you ask, the more people agree.
- Offer a way to disconnect the integration on your side and call [`/revoke`](./userinfo-refresh-revoke#revoke).
