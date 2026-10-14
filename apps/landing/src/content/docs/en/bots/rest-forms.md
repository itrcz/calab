---
title: Board forms
description: Intake forms on a board — create, change, preview and submit answers as a bot.
order: 8
---

A board form is a questionnaire whose answers become tasks. A bot can manage a board's forms (create, change, delete, validate a definition in preview) and submit answers to a form by its code — for example, to carry requests over from an external system.

| Action | Permission |
|---|---|
| list, create, change, delete forms, preview | `VIEW_BOARD` and `MANAGE_BOARD` |
| open and submit a form | access by the form's settings (for a private form, the bot is in `allowedUserIds`) |

Forms per board: Team — 5, Business — 20, a self-hosted installation — as configured (0 = unlimited). The board's “Forms” feature switched off gives `409 FEATURE_DISABLED`.

## Routes

<!-- routes:forms -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/boards/{id}/forms` | The board's forms → `{forms}` |
| `POST` | `/api/boards/{id}/forms` | Create a form `{definition}` → `{form}` |
| `PUT` | `/api/boards/{id}/forms/{fid}` | Replace the definition `{definition, revision}` → `{form}` |
| `DELETE` | `/api/boards/{id}/forms/{fid}` | Delete a form: its link stops working, tasks stay |
| `POST` | `/api/boards/{id}/forms/preview` | Validate an unsaved definition and answers without creating a task |
| `GET` | `/api/forms/{code}` | The form as a respondent sees it → `{title, description, fields, revision}` |
| `POST` | `/api/forms/{code}/submissions` | Submit answers → `{receiptId}` |
<!-- /routes -->

The anonymous `GET /api/public/forms/{code}` and `POST /api/public/forms/{code}/submissions` are public link access for people without an account; enforced workspace SSO closes them. Bots use the authenticated `/api/forms/{code}…`.

## Form definition

`BoardFormDefinition`:

| Field | Description |
|---|---|
| `title`, `description` | The form's title and description |
| `fields` | Fields: `id` (UUID), `type`, `label`, `hint`, `placeholder`, `required`, `options` |
| `titleFieldId` | Optional single-value field used as the task title (not `CHECKBOX` or `MULTISELECT`) |
| `statusId`, `priority` | Status and priority of the created tasks |
| `isPrivate`, `allowedUserIds` | A private form and who may submit it |

Field types (with the `BOARD_FORM_FIELD_TYPE_` prefix in JSON): `TEXT`, `PARAGRAPH`, `EMAIL`, `NUMBER`, `DATE`, `SELECT`, `CHECKBOX`, `PHONE`, `URL`, `MULTISELECT`.

> [!WARNING]
> Managing a form does not bypass a private form's allowlist: for the bot to submit it, add the bot's user id to `allowedUserIds` explicitly.

```sh tab="curl"
curl -s -X POST $CALAB/api/boards/$BOARD/forms \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "definition": {
    "title": "Support request",
    "fields": [
      {"id": "6f1c2b0e-8a4d-4e3b-9c1a-2d3e4f5a6b7c", "type": "BOARD_FORM_FIELD_TYPE_TEXT", "label": "Subject", "required": true},
      {"id": "7a2d3c1f-9b5e-4f4c-8d2b-3e4f5a6b7c8d", "type": "BOARD_FORM_FIELD_TYPE_EMAIL", "label": "Reply-to email"},
      {"id": "8b3e4d20-ac6f-4a5d-9e3c-4f5a6b7c8d9e", "type": "BOARD_FORM_FIELD_TYPE_MULTISELECT", "label": "Team", "options": ["Design", "Support", "Sales"]}
    ],
    "titleFieldId": "6f1c2b0e-8a4d-4e3b-9c1a-2d3e4f5a6b7c",
    "priority": "TASK_PRIORITY_MEDIUM"
  }}'
```

```js tab="JavaScript"
import { BoardFormFieldType } from '@calaba/protocol';

const { form } = await bot.forms.create(boardId, {
  definition: {
    title: 'Support request',
    fields: [
      { id: crypto.randomUUID(), type: BoardFormFieldType.TEXT, label: 'Subject', required: true },
    ],
  },
});
```

The answer is `{form: {id, boardId, url, definition, revision, createdBy, createdAt, updatedAt}}`. `PUT` replaces the whole `definition` and requires the current `revision`.

## Submit answers

`POST /api/forms/{code}/submissions {revision, nonce, answers: [{fieldId, value}]}` → `{receiptId}`, without task details.

- Values are strings; a checkbox is `"true"` or `"false"`.
- `MULTISELECT` uses `{fieldId, values: ["Design", "Support"]}` with no `value`; other types use only `value`.
- Unknown and duplicate options are rejected; the order of chosen options does not affect idempotency.
- `PHONE` keeps formatting and leading zeroes: 7–15 digits, up to 64 characters, an optional leading `+`, spaces, parentheses, dots and hyphens.
- `URL` is an absolute HTTP/HTTPS URL without credentials or whitespace; the server never fetches it.
- The task title comes from the `titleFieldId` answer: collapsed to one line and cut to 200 characters; the full value stays in the task description. No such field, or no answer — the form title.

```sh tab="curl"
curl -s -X POST $CALAB/api/forms/$CODE/submissions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "revision": 3,
  "nonce": "3b0f6c1e-2a4d-4b8e-9f10-6a7b8c9d0e1f",
  "answers": [
    {"fieldId": "6f1c2b0e-8a4d-4e3b-9c1a-2d3e4f5a6b7c", "value": "Email does not arrive"},
    {"fieldId": "8b3e4d20-ac6f-4a5d-9e3c-4f5a6b7c8d9e", "values": ["Support"]}
  ]}'
# → {"receiptId": "0192c9…", "preview": false}
```

```js tab="JavaScript"
const view = await bot.forms.get(code);              // {title, description, fields, revision}
const { receiptId } = await bot.forms.submit(code, {
  revision: view.revision,
  nonce: crypto.randomUUID(),
  answers: [{ fieldId: view.fields[0].id, value: 'Email does not arrive' }],
});
```

```python tab="Python"
import uuid
view = requests.get(f"{CALAB}/api/forms/{code}", headers=H).json()
r = requests.post(f"{CALAB}/api/forms/{code}/submissions", headers=H, json={
    "revision": view["revision"], "nonce": str(uuid.uuid4()),
    "answers": [{"fieldId": view["fields"][0]["id"], "value": "Email does not arrive"}],
})
```

> [!TIP]
> Keep the same UUID `nonce` when retrying: identical submissions create one task. The same `nonce` with different content is `NONCE_CONFLICT`.

## Preview

`POST /api/boards/{id}/forms/preview {definition, answers}` (SDK `bot.forms.preview`) validates an unsaved definition and answers without creating tasks, task numbers or webhook deliveries. The answer is `{receiptId: "", preview: true}`, or a validation error.

## Errors

All errors below are `409 CONFLICT` with the given `reason`; field errors are `422 VALIDATION` with `field`.

| `reason` | Meaning |
|---|---|
| `FORM_CHANGED` | The form changed — reload `revision` |
| `NONCE_CONFLICT` | The `nonce` was already used for different content |
| `FORM_TARGET_UNAVAILABLE` | The status the form creates tasks in was removed |
| `PLAN_LIMIT` | The plan's form limit per board |
| `FEATURE_DISABLED` | The “Forms” feature is off on the board |

Request and response types come from `@calaba/protocol`. The common error format is described in [Errors and limits](./errors-limits).
