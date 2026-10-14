---
title: Rooms and voice
description: Rooms and categories, temporary rooms, voice through LiveKit, call moderation, guest admission, meeting recording, the soundboard and telephony.
order: 5
---

A bot sees only the rooms where it has `VIEW_ROOM`. With the permissions of its roles it can create and configure rooms and categories, and in a voice room it joins the call as an ordinary participant: it listens, speaks, shares a screen, moderates, admits guests, records the meeting, plays sounds and dials phone numbers.

| Action | Permission |
|---|---|
| see a room and categories | `VIEW_ROOM` / workspace member |
| create, change, delete rooms and categories, permission overrides | `MANAGE_ROOM` (in the workspace or in the room) |
| temporary room | `CREATE_TEMP_ROOMS` |
| join voice | `CONNECT`; speak — `SPEAK`, screen share — `STREAM`, camera — `VIDEO` |
| mute / unmute, disconnect from voice, stop someone's screen share or camera | `MUTE_MEMBERS` (and the role hierarchy: only members below you) |
| move to another room | `MOVE_MEMBERS` in both rooms |
| guest admission | `INVITE_GUESTS` in the room |
| meeting recording | `VIEW_ROOM` + `CONNECT` + `MANAGE_RECORDINGS` |
| dial a phone number | `PLACE_CALLS`, the bot is in the room's call, telephony is on |
| sound library | `MANAGE_STICKERS` |

## Routes

<!-- routes:rooms -->
| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspaces/{id}/rooms` | Workspace rooms the bot can see → `{rooms}` |
| `POST` | `/api/workspaces/{id}/rooms` | Create a room → `{room}` (`MANAGE_ROOM`) |
| `POST` | `/api/workspaces/{id}/rooms/temp` | A temporary room without guests or a meeting (`CREATE_TEMP_ROOMS`) |
| `GET` | `/api/rooms/{id}` | The room and the bot's permissions in it → `{room, permissions}` |
| `PATCH` | `/api/rooms/{id}` | Change a room → `{room}` (`MANAGE_ROOM`) |
| `DELETE` | `/api/rooms/{id}` | Delete a room (`MANAGE_ROOM`) |
| `PUT` | `/api/rooms/{id}/permissions` | Replace the room's permission overrides `{overrides}` (`MANAGE_ROOM`) |
| `PUT` | `/api/workspaces/{id}/rooms/order` | Order of rooms and categories `{rooms, categories}` |
| `GET` | `/api/workspaces/{id}/categories` | Room categories → `{categories}` |
| `POST` | `/api/workspaces/{id}/categories` | Create a category `{name, position?}` |
| `PATCH` | `/api/categories/{id}` | Rename / move a category |
| `DELETE` | `/api/categories/{id}` | Delete a category |
| `POST` | `/api/rooms/{id}/join` | Join voice → `{url, token, …}` for LiveKit (`CONNECT`) |
| `POST` | `/api/rooms/{id}/voice/leave` | Leave voice → `204` |
| `POST` | `/api/rooms/{id}/stream/request` | Request a screen share slot (`STREAM`) |
| `POST` | `/api/rooms/{id}/camera/request` | Turn the camera on before publishing (`VIDEO`) |
| `POST` | `/api/rooms/{id}/camera/stop` | Turn your camera off |
| `PATCH` | `/api/voice/self` | Your own `muted` / `deafened` |
| `PATCH` | `/api/rooms/{id}/voice-status` | The room's call status `{status}` (≤ 60 characters) |
| `POST` | `/api/rooms/{id}/voice/{userId}/mute` | Mute a member (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/unmute` | Unmute a member (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/disconnect` | Disconnect from voice (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/move` | Move to another room `{targetRoomId}` (`MOVE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-stream` | Stop someone's screen share (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/stop-camera` | Turn someone's camera off until they leave the call (`MUTE_MEMBERS`) |
| `POST` | `/api/rooms/{id}/voice/{userId}/allow-camera` | Allow a member's camera again (`MUTE_MEMBERS`) |
| `GET` | `/api/rooms/{id}/admissions` | Guests waiting to be admitted → `{admissions}` (`INVITE_GUESTS`) |
| `POST` | `/api/rooms/{id}/admissions/{userId}` | Decide on a guest `{status, displayName?, badgeId?}` |
| `POST` | `/api/rooms/{id}/recording/start` | Start recording the meeting → `{recording}` |
| `POST` | `/api/rooms/{id}/recording/stop` | Stop recording → `{recording}` |
| `GET` | `/api/workspaces/{id}/sounds` | Soundboard sounds → `{sounds}` |
| `POST` | `/api/workspaces/{id}/sounds` | Add a sound `{name, emoji, fileId}` (`MANAGE_STICKERS`) |
| `PATCH` | `/api/workspaces/{id}/sounds/{soundId}` | Change a sound (`MANAGE_STICKERS`) |
| `DELETE` | `/api/workspaces/{id}/sounds/{soundId}` | Delete a sound (`MANAGE_STICKERS`) |
| `POST` | `/api/rooms/{id}/sounds/play` | Play a sound to everyone in the call `{soundId}` |
| `POST` | `/api/rooms/{id}/calls` | Dial a number from the room's call `{number}` (`PLACE_CALLS`) |
| `DELETE` | `/api/rooms/{id}/calls/{cid}` | Hang up |
<!-- /routes -->

### Not available to bots

- Room guest links: `GET · POST /api/rooms/{id}/invites`, `PATCH · DELETE /api/rooms/{id}/invites/{inviteId}`, joining by link `POST /api/room-invites/{code}/join`.
- Room notification settings: `PUT /api/rooms/{id}/notifications`.
- Waiting for admission (`DELETE /api/rooms/{id}/admissions/me`) — that is a guest's action.
- Workspace camera backgrounds `/api/workspaces/{id}/backgrounds…` — a bot has no camera background.
- Telephony settings and the call journal: `/api/workspaces/{id}/sip`, `/api/workspaces/{id}/sip/test`, `GET /api/workspaces/{id}/calls`.
- One-to-one calls: `POST /api/dms/{id}/call`, `/api/calls/{id}/…` — a bot neither calls nor answers, and nobody can call a bot.
- Reprocessing, re-uploading and deleting meeting recordings.

## Create a room

`CreateRoomRequest`: `type` (`ROOM_TYPE_TEXT` or `ROOM_TYPE_VOICE`), `name` (1..100), `topic` (≤ 1024), `isPrivate`, `categoryId`, `position`, `userLimit` (voice rooms only, 0..99).

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/rooms \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type": "ROOM_TYPE_VOICE", "name": "Stand-up", "userLimit": 12}'
```

```js tab="JavaScript"
// no dedicated SDK method — bot.rest.request returns the parsed JSON
const { room } = await bot.rest.request('POST', `/api/workspaces/${wsId}/rooms`, {
  json: { type: 'ROOM_TYPE_VOICE', name: 'Stand-up', userLimit: 12 },
});
```

```json
{
  "room": {
    "id": "0192a2d0-1111-7000-8000-00000000a001",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "type": "ROOM_TYPE_VOICE",
    "name": "Stand-up",
    "topic": "",
    "position": 7,
    "isPrivate": false,
    "categoryId": "",
    "userLimit": 12,
    "allowRecording": false,
    "restricted": false,
    "permissionOverrides": [],
    "createdAt": "2026-10-14T10:00:00Z"
  }
}
```

The SDK also lists rooms and fetches one: `bot.rooms(workspaceId?)`, `bot.room(roomId)`.

### Temporary room

`POST /api/workspaces/{id}/rooms/temp` takes `{name, ttlSeconds, private?, memberIds?, guests?, withEvent?}`; the lifetime is 900 s (15 minutes) to 604,800 s (7 days). The answer is `{room, inviteUrl, inviteCode}`: a link for workspace members only.

> [!WARNING]
> A bot neither invites guests nor books meetings from a temporary room. `guests` defaults to `true`, so a bot must pass `"guests": false` explicitly and must not pass `withEvent` — otherwise `403 BOT_NOT_ALLOWED`.

## Voice through LiveKit

Media flows directly through LiveKit (the SFU); the REST API does not proxy it. A bot in a call is an ordinary participant: a row in the list with a “BOT” badge and a speaking indicator; server mute and disconnect act on it as on a person; it takes a place in the room.

1. `POST /api/rooms/{id}/join` (a voice room, `CONNECT`) → `JoinVoiceResponse {url, token, identity, media, canSpeak, canStream, canVideo, pending}`. `token` is a 10-minute LiveKit JWT whose grant follows the bot's permissions: `SPEAK` — publish a microphone, `STREAM` — screen share (if a slot is free), `VIDEO` — camera (call `POST /api/rooms/{id}/camera/request` before publishing). Connect right away: without a connection within 15 seconds the place is freed.
2. Connect a LiveKit client with `url` + `token`: subscribe to participants' audio tracks and publish your own (Opus 48 kHz, “microphone” source).
3. To leave, disconnect from LiveKit and call `POST /api/rooms/{id}/voice/leave` (→ `204`); the place is freed at once.

Who is in the room: `voiceStates` in `READY` and `voiceStateUpdate` events (an empty `roomId` means the member left), see [Gateway](./gateway). In the SDK — `bot.voice.participants(roomId)`.

```js tab="JavaScript"
// npm i @livekit/rtc-node
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind,
  TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const { url, token, canSpeak } = await bot.voice.join(roomId);
const room = new Room();
await room.connect(url, token, { autoSubscribe: true });
room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  for await (const frame of new AudioStream(track, 48000, 1)) {
    // frame.data is an Int16Array: 10 ms of PCM from participant.identity
  }
});
const source = new AudioSource(48000, 1);
if (canSpeak) {
  await room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('bot', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  await source.captureFrame(new AudioFrame(pcm480, 48000, 1, 480)); // 10 ms at a time
}
// …
await room.disconnect();
await bot.voice.leave(roomId);
```

```python tab="Python"
# pip install livekit requests
import asyncio, requests
from livekit import rtc

join = requests.post(f"{CALAB}/api/rooms/{room_id}/join", headers=H).json()   # {"url", "token", …}
room = rtc.Room()

@room.on("track_subscribed")
def on_track(track, publication, participant):
    if track.kind == rtc.TrackKind.KIND_AUDIO:
        asyncio.create_task(listen(track, participant.identity))

async def listen(track, who):
    async for ev in rtc.AudioStream(track, sample_rate=48000, num_channels=1):
        pcm = ev.frame.data            # memoryview of int16

await room.connect(join["url"], join["token"])
# to speak: source = rtc.AudioSource(48000, 1); track = rtc.LocalAudioTrack.create_audio_track("bot", source)
# await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
```

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/join -H "Authorization: Bearer $TOKEN"
# {"url": "wss://…", "token": "eyJ…", "identity": "…", "canSpeak": true, "canStream": false, "canVideo": false, "pending": false, …}
curl -s -X POST $CALAB/api/rooms/$VOICE/voice/leave -H "Authorization: Bearer $TOKEN"   # → 204
```

In Go, use `livekit/server-sdk-go` (`lksdk.ConnectToRoomWithToken(url, token, callbacks)`). Ready-made examples (a voice echo bot, text to speech, Python) are listed in [SDK](./sdk).

> [!NOTE]
> A bot does not hear itself: LiveKit never sends a participant its own tracks.

## Call moderation

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/voice/$USER/mute -H "Authorization: Bearer $TOKEN"
curl -s -X POST $CALAB/api/rooms/$VOICE/voice/$USER/move -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"targetRoomId\": \"$OTHER_VOICE\"}"
curl -s -X PATCH $CALAB/api/voice/self -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"muted": true}'
```

## Guest admission

When a room requires approval for guests, a guest who follows a link waits for a decision. A bot with `INVITE_GUESTS` in the room reads the queue and decides: `status` is `ROOM_ADMISSION_STATUS_ADMITTED` or `ROOM_ADMISSION_STATUS_DECLINED`; on admission it may rename the guest (`displayName`, 1..40) and give a badge (`badgeId`). If the request is no longer pending — `409 CONFLICT`.

```sh tab="curl"
curl -s $CALAB/api/rooms/$VOICE/admissions -H "Authorization: Bearer $TOKEN"
curl -s -X POST $CALAB/api/rooms/$VOICE/admissions/$GUEST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status": "ROOM_ADMISSION_STATUS_ADMITTED", "displayName": "Partner"}'
```

## Meeting recording

`POST /api/rooms/{id}/recording/start` and `…/stop` work while someone is in the room's call, the room has `allowRecording` on and the workspace is connected to the recording and transcription service. The answer is `{recording: {recordingId, state, byUserId, since, …}}`. A bot needs `VIEW_ROOM`, `CONNECT` and **`MANAGE_RECORDINGS`**. The finished transcript is described in [Messages](./rest-messages#meeting-transcript).

```js tab="JavaScript"
const rec = await bot.recording.start(roomId);
// …
await bot.recording.stop(roomId);
```

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/recording/start -H "Authorization: Bearer $TOKEN"
```

## Soundboard

`GET /api/workspaces/{id}/sounds` lists the workspace's sounds (`{sounds: [{id, name, emoji, fileId, durationMs, position}]}`). `POST /api/rooms/{id}/sounds/play {soundId}` plays a sound to everyone in the call; `soundId` is a sound id or a built-in `builtin:<name>`. The bot must be in that room's call. Limits: 1 sound per 2 seconds per bot and 5 per 10 seconds per room.

A bot with `MANAGE_STICKERS` edits the library: `{name (1..32), emoji, fileId}`, where the file is the bot's own upload to this workspace.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$VOICE/sounds/play -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"soundId": "builtin:air_horn"}'
```

## Telephony

`POST /api/rooms/{id}/calls {number}` dials a number (E.164, e.g. `+79161234567`) from the room's call: the callee joins the room as participant `sip:<callId>`. `DELETE /api/rooms/{id}/calls/{cid}` hangs up your own line (someone else's with `MUTE_MEMBERS`). Statuses arrive as the `sipCallUpdate` event.

- Requires `PLACE_CALLS`, the bot in that room's call and telephony enabled for the workspace.
- At most 20 calls per hour per workspace (`429`, code `SIP_RATE_LIMITED`).
- Business plan only: below it — `409 PLAN_LIMIT` (hanging up always works).

## Gotchas

> [!NOTE]
> Closed rooms apply to bots too: a bot gets into one only through a permission override on that room itself (personal or by role); otherwise it gets `404`, like a person.

> [!WARNING]
> A bot's administrative actions (deleting a room, changing room permissions, admitting guests, recording) are written to the server log together with the bot's owner. Keep a bot token with `MANAGE_*` permissions like an admin's password.
