---
title: Directory (Active Directory)
description: Syncing with Active Directory over LDAPS — requirements, group filter, objectGUID, sync frequency and fail-closed access.
order: 7
---

Corporate sign-in answers “who is this”. The directory answers a different question: “does the organization allow this person in right now”. Every 5 minutes Calab reads Active Directory over LDAPS and closes access for anyone whose account is disabled, deleted or no longer in an allowed group.

## How it works

- The owner explicitly links a workspace member to an AD object by its `objectGUID`. That member becomes **directory-managed**.
- Every 5 minutes Calab takes a full snapshot of the directory and updates the status of managed members.
- If the last full successful sync is more than **1 hour** old, managed members lose access (“Your organization directory does not permit access. Contact the owner.”) until sync recovers. When the state is unknown, Calab closes access rather than opening it.
- Members not linked to the directory are not affected by it.

The directory works independently of the SSO connection: the employee makes the “IdP account ↔ Calab account” link when linking; the owner makes the “AD object ↔ member” link. AD passwords never reach Calab.

## Requirements

| Requirement | Details |
|---|---|
| Protocol | `ldaps://` only, port 636. Plain LDAP and StartTLS are not supported |
| Certificate | The chain and hostname are verified. If the operator set a CA for the host, only that CA is trusted |
| Operator approval | The domain controller's host must be on the operator's list (`IDENTITY_DIRECTORY_HOSTS`) together with its allowed networks — see [for operators](./operators). Otherwise the settings can't be saved |
| Account | A dedicated **read-only** service account. Anonymous bind is not accepted |
| Size | Up to 100,000 accounts; a full scan must complete within 120 seconds |

Calab builds the filter itself — `(&(objectCategory=person)(objectClass=user))` under the Base DN — and reads only `objectGUID`, `userAccountControl` and `memberOf`. Custom filters are not accepted, and referrals to other partitions are never followed.

## Setup

Workspace settings → “SSO settings” → “Active Directory” → “Directory configuration”. You need to be the owner with a confirmed password; under required SSO, also a fresh SSO sign-in.

| Field | Example | Meaning |
|---|---|---|
| “Enabled” | on | Sync is enabled |
| “LDAPS URL” | `ldaps://dc1.corp.example.com:636` | The domain controller address, `ldaps://` only |
| “Bind DN” | `CN=Calab,OU=Services,DC=corp,DC=example,DC=com` | The service account's full DN |
| “Read-only bind password” | — | Stored encrypted; leave blank to retain the current one |
| “Base DN” | `DC=corp,DC=example,DC=com` | The root for account searches |
| “Allowed groups (one DN per line)” | `CN=Calab Users,OU=Groups,DC=corp,DC=example,DC=com` | Up to 100 groups, one DN per line |

<!-- screenshot: identity/directory -->

After “Save”, click “Test connection”, then “Sync now” (manual sync runs at most once a minute). The card shows the “Last successful sync” time and the last error.

> [!NOTE]
> Saving the settings resets directory freshness: managed members regain access after the first successful sync of the new configuration. Run it right after saving.

### Group filter

- Empty list — every account under the Base DN that isn't disabled is allowed.
- List set — anyone who belongs to at least one of the groups is allowed, **including through nested groups**: the domain controller checks membership along the chain (the `LDAP_MATCHING_RULE_IN_CHAIN` rule, `1.2.840.113556.1.4.1941`).
- Groups don't assign Calab roles: they only filter access.

## Linking a member to the directory

The “Member eligibility” card: enter the “Member ID” (the Calab user ID) and the AD account's “Object GUID”, then click “Save”.

`objectGUID` is the immutable identifier of an AD object; it survives renames and moves between OUs. Calab accepts it in the standard GUID string form — the way Windows shows it:

```powershell
Get-ADUser -Identity jdoe -Properties ObjectGUID | Select-Object -ExpandProperty ObjectGUID
# 3f2504e0-4f89-11d3-9a0c-0305e82c3301
```

Over the API — `PUT /api/workspaces/{workspace_id}/identity/directory/members/{user_id}` with the body `{"objectGuid": "3f2504e0-4f89-11d3-9a0c-0305e82c3301"}`.

## Statuses

| Status | Meaning | Access |
|---|---|---|
| `DIRECTORY_MEMBER_STATUS_ACTIVE` | The account is enabled and passes the group filter | Allowed (while the directory is fresh) |
| `DIRECTORY_MEMBER_STATUS_DISABLED` | The account is disabled in AD (`userAccountControl` with the ACCOUNTDISABLE flag) left the allowed groups, or is missing from the latest full snapshot | Closed |
| `DIRECTORY_MEMBER_STATUS_DELETED` | The account is missing from two consecutive full successful snapshots — the final deletion mark | Closed |
| `DIRECTORY_MEMBER_STATUS_UNMAPPED` | The member isn't linked to a directory object yet | Not affected by the directory |

When access closes, Calab immediately revokes that member's SSO confirmations and OAuth access in the workspace. If the account is re-enabled, the person can sign in with SSO again; old OAuth access does not come back. The directory never touches manual bans or roles: re-enabling doesn't lift a ban or grant roles.

## Protection against mass loss

A network failure, an incomplete page set or an expired sync lease is never read as “everyone left” — the snapshot simply isn't published.

If a full snapshot is **empty or sharply smaller** than before (more than 20 % and at least 2 objects gone, or as many linked active members), Calab quarantines it: the previous state is kept and the card shows the error “Directory scan returned far fewer accounts than before; the previous state is kept…”. Usually it means the service account lost read access. If the drop is real, save the directory settings again: the first sync of a new configuration isn't checked for shrinkage.

> [!WARNING]
> Quarantine doesn't renew freshness. If no sync succeeds within an hour, managed members lose access.

## Turning the directory off

Disabling the directory or removing a link does **not** automatically lift restrictions from members that are already closed. Review each one and click “Detach from directory” — the action is audited. The member then signs in again.
