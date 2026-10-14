---
title: 'Gateway: realtime events'
description: Connecting to the gateway over WebSocket, IDENTIFY and READY, heartbeats, events, RESUME after a drop and close codes.
order: 17
---

The gateway is a persistent WebSocket connection over which the server pushes events to the bot: new messages, reactions, voice changes, tasks. One socket per bot. If a persistent connection doesn't suit you (serverless), message and task events are also available through a [webhook](./webhooks).

## Connecting

```text
wss://app.example.com/gateway?v=1                  # binary protobuf (default)
wss://app.example.com/gateway?v=1&encoding=json    # protojson text frames
```

Every frame is `GatewayFrame { op, seq, <payload> }`. Frames are binary protobuf by default; with `encoding=json` they are JSON text frames in the same format as REST (lowerCamelCase fields, enums by full name, `uint64` as strings). JSON is handy when your language has no protobuf library.

## Lifecycle

1. **Server → `HELLO`** `{ heartbeatIntervalMs }` — the heartbeat interval, about 41 seconds.
2. **Bot → `IDENTIFY`** `{ token, device: { name, platform, appVersion } }` — the bot token and a description of the process.
3. **Server → `DISPATCH ready`** with `seq = 1`: `sessionId`, `me`, `workspaces[]` (for each workspace — visible rooms, members, roles, voice states, presence, the bot's permissions per room), `dms[]`, `readStates`.
4. Then **`DISPATCH`** frames with events and a growing `seq`.
5. Every `heartbeatIntervalMs` the bot sends **`HEARTBEAT`** `{ lastSeq }`; the server answers `HEARTBEAT_ACK`. No heartbeat for 2 × the interval + 10 s closes the socket with `4009`.

Frames in JSON mode:

```json
→ {"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {"token": "calab_bot_0192a1b2-…", "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}
← {"op": "GATEWAY_OPCODE_HELLO", "hello": {"heartbeatIntervalMs": 41000}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "1", "dispatch": {"ready": {"sessionId": "…", "me": {"user": {"id": "…", "isBot": true}}, "workspaces": […], "dms": […]}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "2", "dispatch": {"messageCreate": {"workspaceId": "…", "message": {"id": "…", "content": "/echo hi", "command": {"botUserId": "…", "name": "echo", "args": "hi"}}}}}
→ {"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": "2"}}
← {"op": "GATEWAY_OPCODE_HEARTBEAT_ACK", "heartbeatAck": {}}
```

## A minimal client

```js tab="JavaScript"
import WebSocket from 'ws';

const ws = new WebSocket('wss://app.example.com/gateway?v=1&encoding=json');
let lastSeq = '0';
let timer;

ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.seq) lastSeq = f.seq;
  switch (f.op) {
    case 'GATEWAY_OPCODE_HELLO':
      ws.send(JSON.stringify({ op: 'GATEWAY_OPCODE_IDENTIFY',
        identify: { token: process.env.TOKEN, device: { name: 'my-bot', platform: 'linux', appVersion: '1.0' } } }));
      timer = setInterval(() => ws.send(JSON.stringify({ op: 'GATEWAY_OPCODE_HEARTBEAT', heartbeat: { lastSeq } })),
        f.hello.heartbeatIntervalMs);
      break;
    case 'GATEWAY_OPCODE_DISPATCH':
      if (f.dispatch.messageCreate) console.log('message:', f.dispatch.messageCreate.message.content);
      break;
  }
});
ws.on('close', (code, reason) => { clearInterval(timer); console.log('closed', code, reason.toString()); });
```

```python tab="Python"
import asyncio, json, os, websockets

async def main():
    async with websockets.connect("wss://app.example.com/gateway?v=1&encoding=json") as ws:
        hello = json.loads(await ws.recv())
        interval = hello["hello"]["heartbeatIntervalMs"] / 1000
        await ws.send(json.dumps({"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {
            "token": os.environ["TOKEN"], "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}))
        last_seq = "0"

        async def heartbeat():
            while True:
                await asyncio.sleep(interval)
                await ws.send(json.dumps({"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": last_seq}}))

        hb = asyncio.create_task(heartbeat())
        async for raw in ws:
            f = json.loads(raw)
            last_seq = f.get("seq", last_seq)
            ev = f.get("dispatch", {})
            if "messageCreate" in ev:
                print("message:", ev["messageCreate"]["message"]["content"])
        hb.cancel()

asyncio.run(main())
```

This is a skeleton: a real bot also needs reconnects and `RESUME` (below). The [Node.js SDK](./sdk) does all of that for you.

## Events

An event is the `dispatch` field of a `DISPATCH` frame (exactly one per frame). A bot gets only what it can see through its permissions (`VIEW_ROOM`, `VIEW_BOARD`).

| Event | When |
|---|---|
| `ready` · `resumed` | after `IDENTIFY` · after a successful `RESUME` |
| `messageCreate` · `messageUpdate` · `messageDelete` | messages in rooms and the bot's DMs (its own included) |
| `messageReactionAdd` · `messageReactionRemove` | reactions |
| `botCallback` | a person pressed a button under the bot's message — to that bot only; see [Commands and buttons](./commands-buttons) |
| `voiceStateUpdate` · `voiceStreamStart` / `voiceStreamStop` · `voiceCameraStop` · `voiceMoved` | voice: who is in which room, mute, streams |
| `presenceUpdate` · `userUpdate` | presence and profiles |
| `roomCreate` / `roomUpdate` / `roomDelete` · `roomPermissionsUpdate` · `categoryCreate` / `categoryUpdate` / `categoryDelete` | rooms and categories |
| `workspaceCreate` / `workspaceUpdate` / `workspaceDelete` · `workspaceMemberAdd` / `workspaceMemberUpdate` / `workspaceMemberRemove` · `roleCreate` / `roleUpdate` / `roleDelete` | workspaces, members, roles |
| `dmCreate` | a new DM with the bot |
| `typingStart` | “is typing” — only in rooms from `SUBSCRIBE` |
| `stickerPackCreate` / `stickerPackUpdate` / `stickerPackDelete` | the workspace's sticker packs |
| `soundCreate` / `soundUpdate` / `soundDelete` · `soundPlay` | the workspace's sounds; `soundPlay` only while the bot is in the room's call |
| `botCreate` / `botUpdate` / `botDelete` | the workspace's bots — only with `MANAGE_BOTS` |
| `sipCallUpdate` | a phone call from a room was placed or changed status |
| `eventCreate` / `eventUpdate` / `eventDelete` · `eventRsvp` | meetings: its own (the bot organizes) and those of visible rooms; outside addresses only if the bot may change the meeting |
| `boardCreate` / `boardUpdate` / `boardDelete` · `taskCreate` / `taskUpdate` / `taskDelete` · `taskActivity` | boards and tasks — by the bot's `VIEW_BOARD` |
| `taskNotice` | a person's task notification, when they chose this bot — see [Task notifications](./task-notices) |

The full table of every protocol event, marked with which ones reach bots, is in [Gateway events](../reference/gateway-events). Bots **don't receive** people's read receipts, one-to-one call notifications, or notes, billing and Disk events.

## What a bot can send

| Frame | What it does | Limits |
|---|---|---|
| `HEARTBEAT { lastSeq }` | keeps the connection alive | every `heartbeatIntervalMs` |
| `TYPING { roomId }` | “bot is typing” in a room | at most once per 3 s per room |
| `SUBSCRIBE { roomIds }` | subscribes to `typingStart` of these rooms; replaces the previous set | up to 100 rooms |
| `PRESENCE_UPDATE { status }` | presence status (`PRESENCE_STATUS_ONLINE`, `…_IDLE`, `…_DND`, `…_INVISIBLE`) | — |

`TYPING`, `SUBSCRIBE` and `PRESENCE_UPDATE` together: at most 10 in a row and 2 per second; extras are silently dropped. More than 50 frames per second sustained closes the socket with `4008`.

## Reconnect and RESUME

Connections drop — that's normal (server deploys, networks). The right response:

1. Reconnect with exponential backoff: 1 → 30 s with jitter.
2. After `HELLO`, send **`RESUME`** `{ token, sessionId, seq }` — `sessionId` from `ready`, `seq` the last one you processed.
3. The server replays what you missed (a buffer of about 5 minutes or 1000 events) and sends `resumed { replayed }`.
4. If the session can't be resumed you get `INVALID_SESSION { resumable: false }`: after 1–5 s send `IDENTIFY` on the same socket and get a new `ready`.

A `RECONNECT` frame means the server itself asks you to reconnect (for example, before a deploy): close the socket and follow the steps above. Skip events whose `seq` is not greater than the last one you processed — after a replay they may arrive twice.

## Close codes

| Code | Meaning | What to do |
|---|---|---|
| `4000` | unknown error | reconnect, `RESUME` |
| `4000` + `replaced by a new session` | another process connected with the same token | **don't** reconnect |
| `4001` · `4002` | unknown opcode · decode error | reconnect, `RESUME` |
| `1006` | the connection dropped | reconnect, `RESUME` |
| `4003` | not identified | reconnect, new `IDENTIFY` |
| `4004` | invalid token | **don't** reconnect |
| `4007` · `4009` | invalid `seq` · heartbeat timed out | reconnect, new `IDENTIFY` |
| `4008` | rate limited (flooding, or the 256-frame send queue overflowed) | back off, `RESUME` |
| `4010` | token revoked or bot deleted | **don't** reconnect |

## Socket limits

| What | Value |
|---|---|
| Sockets per token | 1 |
| Inbound frame size | up to 64 KiB |
| Server send queue | 256 frames; overflow → `4008` |
| `RESUME` buffer | about 5 minutes or 1000 events |
