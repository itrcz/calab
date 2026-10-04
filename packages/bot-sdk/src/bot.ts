import { BoardFormResponseSchema, CreateBoardFormRequestSchema, UpdateBoardFormRequestSchema, ListBoardFormsResponseSchema, PublicBoardFormResponseSchema, SubmitBoardFormRequestSchema, PreviewBoardFormRequestSchema, FormSubmissionResponseSchema } from '@calaba/protocol';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { create, toJson, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import {
  CalendarEventResponseSchema,
  CreateBadgeRequestSchema,
  CreateBadgeResponseSchema,
  CreateCalendarEventRequestSchema,
  CreateEmailInviteRequestSchema,
  CreateEmailInviteResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  FreeBusyResponseSchema,
  GetMemberResponseSchema,
  ListBadgesResponseSchema,
  ListCalendarEventsResponseSchema,
  ListEmailInvitesResponseSchema,
  ListInvitesResponseSchema,
  SetMemberBadgeRequestSchema,
  SetMemberBadgeResponseSchema,
  StartRecordingResponseSchema,
  StopRecordingResponseSchema,
  SuggestSlotsRequestSchema,
  SuggestSlotsResponseSchema,
  UpdateBadgeRequestSchema,
  UpdateBadgeResponseSchema,
  UpdateCalendarEventRequestSchema,
  UpdateMemberRequestSchema,
  UpdateMemberResponseSchema,
  type Badge,
  type CalendarEvent,
  type EmailInvite,
  type FreeBusyUser,
  type GetMemberResponse,
  type Invite,
  type RoomRecording,
  type Slot,
  BoardCategoryResponseSchema,
  BoardResponseSchema,
  type BoardCategory,
  type BoardFeature,
  type EstimateScale,
  type TaskChecklist,
  ConvertChecklistItemResponseSchema,
  CreateBoardCategoryRequestSchema,
  CreateTaskChecklistItemRequestSchema,
  CreateTaskChecklistRequestSchema,
  ListBoardCategoriesResponseSchema,
  SetBoardOrderRequestSchema,
  SetBoardOrderResponseSchema,
  TaskChecklistResponseSchema,
  TaskMilestoneResponseSchema,
  CreateTaskMilestoneRequestSchema,
  UpdateTaskMilestoneRequestSchema,
  type TaskMilestoneResponse,
  UpdateBoardCategoryRequestSchema,
  UpdateBoardRequestSchema,
  UpdateTaskChecklistItemRequestSchema,
  UpdateTaskChecklistRequestSchema,
  BotWebhookResponseSchema,
  InlineKeyboardSchema,
  type BotCallback,
  CreateTaskRequestSchema,
  ListBoardsResponseSchema,
  ListTasksResponseSchema,
  SearchTasksResponseSchema,
  SetAssigneesRequestSchema,
  TaskFilterSchema,
  TaskResponseSchema,
  UpdateTaskRequestSchema,
  type Board,
  type Task,
  type TaskResponse,
  CreateDmRequestSchema,
  CreateDmResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateStickerPackRequestSchema,
  ForwardMessageRequestSchema,
  ForwardMessageResponseSchema,
  GetBotMeResponseSchema,
  GetRecordingTranscriptResponseSchema,
  GetRoomResponseSchema,
  JoinVoiceResponseSchema,
  MessageSchema,
  ListMembersResponseSchema,
  ListMessagesResponseSchema,
  ListRoomsResponseSchema,
  ListStickerPacksResponseSchema,
  ListWorkspacesResponseSchema,
  RoomType,
  SetBotCommandsRequestSchema,
  SetBotCommandsResponseSchema,
  SetBotWebhookRequestSchema,
  StickerPackResponseSchema,
  UpdateBotMeRequestSchema,
  UpdateMessageRequestSchema,
  UpdateMessageResponseSchema,
  UploadFileResponseSchema,
  UploadStickersResponseSchema,
  type Bot as BotProfile,
  type BotCommand,
  type BotWebhook,
  type BotWebhookUpdate,
  type DispatchEvent,
  type DmSummary,
  type FileMeta,
  type GetRecordingTranscriptResponse,
  type JoinVoiceResponse,
  type Message,
  type MessageDelete,
  type Ready,
  type Resumed,
  type Room,
  type StickerPack,
  type UploadStickersResponse,
  type User,
  type VoiceState,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceSnapshot,
} from '@calaba/protocol';
import { Emitter } from './emitter.js';
import { GatewayFatalError } from './errors.js';
import { Gateway, gatewayUrl, type GatewayStatus, type SocketLike } from './gateway.js';
import { Rest, type RestOptions } from './rest.js';
import { DELIVERY_HEADER, SIGNATURE_HEADER, parseWebhookUpdate, verifyWebhookSignature } from './webhook.js';

// ---- public types ----

export interface BotOptions {
  /** Server origin, e.g. `https://app.calab.io` (the gateway is `wss://<host>/gateway`). */
  server: string;
  /** Webhook secret: `handleWebhook` then requires a valid X-Calab-Signature. */
  webhookSecret?: string;
  /** Deliver the bot's own messages and reactions as events too (default false). */
  receiveOwn?: boolean;
  /** 429 retries after `Retry-After` (default 3). */
  maxRetries?: number;
  /** Debug log (gateway reconnects, retries). */
  log?: (msg: string) => void;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Custom socket factory (tests). Default: `ws`. */
  createSocket?: (url: string) => SocketLike;
  /** Gateway timing (tests). */
  gateway?: {
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    invalidSessionMinMs?: number;
    invalidSessionJitterMs?: number;
    random?: () => number;
  };
  /** Sleep between 429 retries (tests). */
  sleep?: RestOptions['sleep'];
}

/** A file to attach: bytes and a name (the server sniffs the type; `type` is a hint). */
export interface FileInput {
  name: string;
  data: Uint8Array | ArrayBuffer | Blob;
  type?: string;
}

export interface SendOptions {
  text?: string;
  /** Send a sticker (ADR-0030) instead of text and files. */
  stickerId?: string;
  /** Files to upload and attach (≤ 20), or ids of files uploaded before. */
  files?: (FileInput | string)[];
  /** Id of the message this one answers. */
  replyTo?: string;
  /** Idempotency key (≤ 64 chars); generated when omitted. */
  nonce?: string;
  /** Public callback metadata; never include secrets. */
  inlineKeyboard?: MessageInitShape<typeof InlineKeyboardSchema>;
}

export type SendContent = string | SendOptions;

export interface EditOptions {
  text?: string;
  /** Omitted = keep; { rows: [] } = remove. */
  inlineKeyboard?: MessageInitShape<typeof InlineKeyboardSchema>;
}

/** A `/command` addressed to this bot (ADR-0031 §6). */
export interface CommandEvent {
  /** Lower case, without the slash and `@username`. */
  name: string;
  /** The rest of the message, trimmed. */
  args: string;
  message: Message;
  /** Empty for a DM. */
  workspaceId: string;
}

export interface ReactionEvent {
  type: 'add' | 'remove';
  /** Empty for a DM. */
  workspaceId: string;
  roomId: string;
  messageId: string;
  userId: string;
  emoji: string;
}

export interface MessageDeleteEvent {
  workspaceId: string;
  roomId: string;
  messageId: string;
}

export interface BotEvents {
  /** READY: the bot's account, its workspaces (rooms it can view, members, voice states) and DMs. */
  ready: Ready;
  /** The connection came back and missed events were replayed. */
  resumed: Resumed;
  /** A new message from someone else (a command addressed to this bot comes as `command` instead). */
  message: Message;
  messageUpdate: Message;
  messageDelete: MessageDeleteEvent;
  command: CommandEvent;
  reaction: ReactionEvent;
  /** Accepted button press. Persistently dedupe by id and revalidate domain state before effects. */
  callback: BotCallback;
  voiceState: VoiceState;
  /** Every gateway / webhook event, raw. */
  dispatch: DispatchEvent;
  status: GatewayStatus;
  /** A listener threw, or the gateway gave up (`GatewayFatalError`). */
  error: Error;
}

interface RoomInfo {
  workspaceId: string;
  type: RoomType;
}

const MAX_SEEN_DELIVERIES = 2048;

/**
 * A Calab bot: REST client + realtime gateway (or webhook) with typed events.
 *
 * ```ts
 * const bot = new Bot(process.env.BOT_TOKEN!, { server: 'https://app.calab.io' });
 * bot.on('message', (m) => bot.reply(m, `echo: ${m.content}`));
 * await bot.start();
 * ```
 */
export class Bot extends Emitter<BotEvents> {
  readonly rest: Rest;
  private readonly opts: BotOptions;
  private gateway: Gateway | null = null;
  private meUser: User | undefined;
  private botUserId = '';
  private readonly roomsById = new Map<string, RoomInfo>();
  private readonly voiceStates = new Map<string, VoiceState>();
  private readonly seenDeliveries = new Set<string>();

  constructor(token: string, options: BotOptions) {
    super((err, event) => {
      this.reportError(err instanceof Error ? err : new Error(String(err)), event === 'error');
    });
    if (!token.startsWith('calab_bot_')) throw new Error('Bot token must start with "calab_bot_"');
    this.opts = options;
    this.rest = new Rest({
      server: options.server,
      token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    this.token = token;
  }

  private readonly token: string;

  /** The bot's account (after `start()` or `fetchMe()`). */
  get me(): User | undefined {
    return this.meUser;
  }

  // ---- lifecycle ----

  /** Connects the gateway; resolves with READY. Rejects if the token is refused. */
  start(): Promise<Ready> {
    if (this.gateway) throw new Error('bot already started');
    const g = this.opts.gateway ?? {};
    return new Promise<Ready>((resolve, reject) => {
      let settled = false;
      this.gateway = new Gateway({
        url: gatewayUrl(this.rest.server),
        token: this.token,
        createSocket: this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike),
        onDispatch: (ev) => {
          this.handle(ev);
          if (!settled && ev.event.case === 'ready') {
            settled = true;
            resolve(ev.event.value);
          }
        },
        onStatus: (s) => {
          this.emit('status', s);
        },
        onFatal: (kind, code, reason) => {
          const err = new GatewayFatalError(kind, code, reason);
          this.gateway = null;
          if (!settled) {
            settled = true;
            reject(err);
            return;
          }
          this.reportError(err, false);
        },
        ...(this.opts.log ? { log: this.opts.log } : {}),
        ...g,
      });
      this.gateway.start();
    });
  }

  /** Disconnects (the server ends the gateway session at once; the bot goes offline). */
  stop(): void {
    this.gateway?.stop();
    this.gateway = null;
  }

  /** GET /api/bots/me — the bot's profile, commands and webhook state. */
  async fetchMe(): Promise<BotProfile> {
    const r = await this.rest.call(GetBotMeResponseSchema, 'GET', '/api/bots/me');
    if (!r.bot) throw new Error('GET /api/bots/me: empty response');
    if (r.bot.user) this.setMe(r.bot.user);
    return r.bot;
  }

  /** PATCH /api/bots/me — display name and description («about»). */
  async updateProfile(p: { displayName?: string; description?: string }): Promise<BotProfile> {
    const r = await this.rest.call(GetBotMeResponseSchema, 'PATCH', '/api/bots/me', { json: Rest.body(UpdateBotMeRequestSchema, p) });
    if (!r.bot) throw new Error('PATCH /api/bots/me: empty response');
    return r.bot;
  }

  // ---- messages ----

  /** Sends a message: text, files (uploaded first) or a sticker. */
  async send(roomId: string, content: SendContent): Promise<Message> {
    const o: SendOptions = typeof content === 'string' ? { text: content } : content;
    const attachmentIds: string[] = [];
    for (const f of o.files ?? []) attachmentIds.push(typeof f === 'string' ? f : (await this.upload(roomId, f)).id);
    const r = await this.rest.call(CreateMessageResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/messages`, {
      json: Rest.body(CreateMessageRequestSchema, {
        content: o.text ?? '',
        attachmentIds,
        replyToId: o.replyTo ?? '',
        inlineKeyboard: o.inlineKeyboard,
        stickerId: o.stickerId ?? '',
        nonce: o.nonce ?? randomUUID(),
      }),
    });
    if (!r.message) throw new Error('send: empty response');
    return r.message;
  }

  /** Answers a message (or a command) in its room, as a reply to it. */
  reply(to: Message | { message: Message }, content: SendContent): Promise<Message> {
    const m = 'message' in to && typeof to.message === 'object' ? to.message : (to as Message);
    const o: SendOptions = typeof content === 'string' ? { text: content } : content;
    return this.send(m.roomId, { ...o, replyTo: o.replyTo ?? m.id });
  }

  /**
   * Forwards a message of `roomId` into `toRoomId` (a room or a DM, ADR-0033): a copy by the bot
   * with `forward` (the original's author and time); files are the same, mentions do not notify.
   */
  async forward(roomId: string, messageId: string, toRoomId: string): Promise<Message> {
    const r = await this.rest.call(ForwardMessageResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/messages/${enc(messageId)}/forward`, {
      json: Rest.body(ForwardMessageRequestSchema, { toRoomId }),
    });
    if (!r.message) throw new Error('forward: empty response');
    return r.message;
  }

  /** Edits the bot's own message. */
  async edit(messageId: string, content: string | EditOptions): Promise<Message> {
    const o: EditOptions = typeof content === 'string' ? { text: content } : content;
    const r = await this.rest.call(UpdateMessageResponseSchema, 'PATCH', `/api/messages/${enc(messageId)}`, {
      json: Rest.body(UpdateMessageRequestSchema, { content: o.text ?? '', inlineKeyboard: o.inlineKeyboard, preserveContent: o.text === undefined && o.inlineKeyboard !== undefined }),
    });
    if (!r.message) throw new Error('edit: empty response');
    return r.message;
  }

  /** Deletes a message (own, or any with MANAGE_MESSAGES). */
  async deleteMessage(messageId: string): Promise<void> {
    await this.rest.request('DELETE', `/api/messages/${enc(messageId)}`);
  }

  async react(messageId: string, emoji: string): Promise<void> {
    await this.rest.request('PUT', `/api/messages/${enc(messageId)}/reactions/${enc(emoji)}`);
  }

  async unreact(messageId: string, emoji: string): Promise<void> {
    await this.rest.request('DELETE', `/api/messages/${enc(messageId)}/reactions/${enc(emoji)}`);
  }

  /** History of a room, newest first (`before`/`after` are message ids; limit ≤ 100). */
  async messages(roomId: string, q: { before?: string; after?: string; limit?: number } = {}): Promise<{ messages: Message[]; hasMore: boolean }> {
    const r = await this.rest.call(ListMessagesResponseSchema, 'GET', `/api/rooms/${enc(roomId)}/messages`, { query: q });
    return { messages: r.messages, hasMore: r.hasMore };
  }

  /**
   * One message of a room by id (e.g. a `replyToId` target, a recording card), with the same access as
   * history: VIEW_ROOM; 404 for a message of another room, a deleted one or one before a cleared DM mark.
   */
  async message(roomId: string, messageId: string): Promise<Message> {
    return this.rest.call(MessageSchema, 'GET', `/api/rooms/${enc(roomId)}/messages/${enc(messageId)}`);
  }

  /**
   * The full saved transcript of a meeting recording visible in the room (its card or a live forwarded
   * copy, ADR-0033): `recordingId` of the card's `system.payload` (case `recording`). VIEW_ROOM; 404 while none.
   */
  async transcript(roomId: string, recordingId: string): Promise<GetRecordingTranscriptResponse> {
    return this.rest.call(GetRecordingTranscriptResponseSchema, 'GET', `/api/rooms/${enc(roomId)}/recordings/${enc(recordingId)}/transcript`);
  }

  /** «… is typing» in a room for a few seconds (gateway; no-op when not connected). */
  typing(roomId: string): void {
    this.gateway?.typing(roomId);
  }

  /** Uploads a file into the room's workspace (or the DM) and returns its metadata. */
  async upload(roomId: string, file: FileInput): Promise<FileMeta> {
    const info = await this.roomInfo(roomId);
    const path = info.workspaceId ? `/api/workspaces/${enc(info.workspaceId)}/files` : `/api/dms/${enc(roomId)}/files`;
    const r = await this.rest.call(UploadFileResponseSchema, 'POST', path, {
      form: () => {
        const f = new FormData();
        f.append('file', toBlob(file.data, file.type), file.name);
        return f;
      },
    });
    if (!r.file) throw new Error('upload: empty response');
    return r.file;
  }

  /** Opens (or finds) the DM with a member of a shared workspace; send to `dm.room.id`. */
  async dm(userId: string): Promise<DmSummary> {
    const r = await this.rest.call(CreateDmResponseSchema, 'POST', '/api/dms', { json: Rest.body(CreateDmRequestSchema, { userId }) });
    if (!r.dm?.room) throw new Error('dm: empty response');
    this.roomsById.set(r.dm.room.id, { workspaceId: '', type: RoomType.DM });
    return r.dm;
  }

  // ---- commands ----

  /** PUT /api/bots/me/commands — replaces the commands shown in the composer on «/» (≤ 100). */
  async commands(list: { name: string; description?: string }[]): Promise<BotCommand[]> {
    const r = await this.rest.call(SetBotCommandsResponseSchema, 'PUT', '/api/bots/me/commands', {
      json: Rest.body(SetBotCommandsRequestSchema, { commands: list.map((c) => ({ name: c.name, description: c.description ?? '' })) }),
    });
    return r.commands;
  }

  // ---- workspaces, rooms, members ----

  async workspaces(): Promise<Workspace[]> {
    return (await this.rest.call(ListWorkspacesResponseSchema, 'GET', '/api/workspaces')).workspaces;
  }

  /** Rooms the bot can view: of one workspace, or of all its workspaces. */
  async rooms(workspaceId?: string): Promise<Room[]> {
    const ids = workspaceId ? [workspaceId] : (await this.workspaces()).map((w) => w.id);
    const out: Room[] = [];
    for (const id of ids) {
      const r = await this.rest.call(ListRoomsResponseSchema, 'GET', `/api/workspaces/${enc(id)}/rooms`);
      for (const room of r.rooms) this.indexRoom(room);
      out.push(...r.rooms);
    }
    return out;
  }

  async room(roomId: string): Promise<Room> {
    const r = await this.rest.call(GetRoomResponseSchema, 'GET', `/api/rooms/${enc(roomId)}`);
    if (!r.room) throw new Error('room: empty response');
    this.indexRoom(r.room);
    return r.room;
  }

  /**
   * `members(roomId)`: members of the room's workspace (who of them sees the room is decided by roles
   * and room overrides: VIEW_ROOM; a DM has no workspace: use `dm.peer`). `members.get` /
   * `members.setNickname`: one member's profile and nickname (ADR-0051).
   */
  readonly members = Object.assign(
    async (roomId: string): Promise<WorkspaceMember[]> => {
      const info = await this.roomInfo(roomId);
      if (!info.workspaceId) throw new Error('members: a DM has no workspace members');
      return (await this.rest.call(ListMembersResponseSchema, 'GET', `/api/workspaces/${enc(info.workspaceId)}/members`)).members;
    },
    {
      /** A member's profile with their open tasks on the boards the bot sees ('@me' = the bot). */
      get: (workspaceId: string, userId: string): Promise<GetMemberResponse> =>
        this.rest.call(GetMemberResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}`),
      /** A member's nickname in the workspace (MANAGE_NICKNAMES); '' clears it. */
      setNickname: async (workspaceId: string, userId: string, nickname: string): Promise<WorkspaceMember> =>
        (
          await this.rest.call(UpdateMemberResponseSchema, 'PATCH', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}`, {
            json: Rest.body(UpdateMemberRequestSchema, { nickname }),
          })
        ).member ?? fail('member'),
    },
  );

  /** Whether a room is a DM of the bot (known from READY / DM_CREATE / `dm()`). */
  isDm(roomId: string): boolean {
    return this.roomsById.get(roomId)?.type === RoomType.DM;
  }

  /** The workspace of a room seen on the gateway ('' for a DM, undefined when unknown). */
  workspaceOf(roomId: string): string | undefined {
    return this.roomsById.get(roomId)?.workspaceId;
  }

  // ---- voice (LiveKit) ----

  readonly voice = {
    /**
     * POST /api/rooms/{id}/join (CONNECT): a LiveKit `url` + `token` for this bot. Connect a LiveKit
     * client right away (the token lives 10 min; without a connection within 15 s the place is freed).
     */
    join: async (roomId: string): Promise<JoinVoiceResponse> =>
      this.rest.call(JoinVoiceResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/join`),
    /** POST /api/rooms/{id}/voice/leave — call after disconnecting the LiveKit client. */
    leave: async (roomId: string): Promise<void> => {
      await this.rest.request('POST', `/api/rooms/${enc(roomId)}/voice/leave`);
    },
    /** Who is in a voice room now (from the gateway: READY + VOICE_STATE_UPDATE). */
    participants: (roomId: string): VoiceState[] => [...this.voiceStates.values()].filter((v) => v.roomId === roomId),
  };

  // ---- webhook ----

  readonly webhook = {
    get: async (): Promise<BotWebhook> => (await this.rest.call(BotWebhookResponseSchema, 'GET', '/api/bots/me/webhook')).webhook ?? fail('webhook'),
    /** https only, public address; secret 16..256 characters (signs every delivery). */
    set: async (url: string, secret: string): Promise<BotWebhook> =>
      (await this.rest.call(BotWebhookResponseSchema, 'PUT', '/api/bots/me/webhook', { json: Rest.body(SetBotWebhookRequestSchema, { url, secret }) }))
        .webhook ?? fail('webhook'),
    delete: async (): Promise<void> => {
      await this.rest.request('DELETE', '/api/bots/me/webhook');
    },
  };

  /**
   * Feeds one webhook delivery (the raw body and the request headers) into the same events as the
   * gateway. Verifies X-Calab-Signature when `webhookSecret` is set (false = rejected: answer 401) and
   * drops repeated deliveries (by id). Answer the HTTP request with 2xx quickly, then do the work.
   */
  handleWebhook(body: string | Uint8Array, headers: Headers | Record<string, string | string[] | undefined> = {}): boolean {
    const header = (name: string): string | undefined => {
      if (headers instanceof Headers) return headers.get(name) ?? undefined;
      const v = Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
      return Array.isArray(v) ? v[0] : v;
    };
    if (this.opts.webhookSecret !== undefined && !verifyWebhookSignature(this.opts.webhookSecret, body, header(SIGNATURE_HEADER))) return false;
    const update: BotWebhookUpdate = parseWebhookUpdate(body);
    const id = update.id || header(DELIVERY_HEADER) || '';
    if (id) {
      if (this.seenDeliveries.has(id)) return true;
      this.seenDeliveries.add(id);
      if (this.seenDeliveries.size > MAX_SEEN_DELIVERIES) {
        const first = this.seenDeliveries.values().next();
        if (!first.done) this.seenDeliveries.delete(first.value);
      }
    }
    if (!this.botUserId && update.botUserId) this.botUserId = update.botUserId;
    if (update.event) this.handle(update.event);
    return true;
  }

  // ---- stickers (ADR-0030; creating packs needs MANAGE_STICKERS) ----

  readonly stickers = {
    list: async (workspaceId: string): Promise<StickerPack[]> =>
      (await this.rest.call(ListStickerPacksResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/sticker-packs`)).packs,
    createPack: async (workspaceId: string, p: { name: string; shortName?: string }): Promise<StickerPack> =>
      (
        await this.rest.call(StickerPackResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/sticker-packs`, {
          json: Rest.body(CreateStickerPackRequestSchema, { name: p.name, shortName: p.shortName ?? '' }),
        })
      ).pack ?? fail('pack'),
    /** WebP files (≤ 50 per call, all or nothing), each with its emoji. */
    addStickers: async (packId: string, stickers: { emoji: string; data: FileInput['data']; name?: string }[]): Promise<UploadStickersResponse> =>
      this.rest.call(UploadStickersResponseSchema, 'POST', `/api/sticker-packs/${enc(packId)}/stickers`, {
        form: () => {
          const f = new FormData();
          stickers.forEach((s, i) => {
            f.append('emoji', s.emoji);
            f.append('file', toBlob(s.data, 'image/webp'), s.name ?? `sticker-${i}.webp`);
          });
          return f;
        },
      }),
    remove: async (stickerId: string): Promise<void> => {
      await this.rest.request('DELETE', `/api/stickers/${enc(stickerId)}`);
    },
  };

  // ---- task boards (ADR-0042): a bot works within the board bits of its roles ----

  /** Board intake forms (ADR-0064). Management requires MANAGE_BOARD; submission uses the form ACL. */
  readonly forms = {
    list: (boardId: string) => this.rest.call(ListBoardFormsResponseSchema, 'GET', `/api/boards/${enc(boardId)}/forms`),
    create: (boardId: string, input: MessageInitShape<typeof CreateBoardFormRequestSchema>) => this.rest.call(BoardFormResponseSchema, 'POST', `/api/boards/${enc(boardId)}/forms`, { json: Rest.body(CreateBoardFormRequestSchema, input) }),
    update: (boardId: string, formId: string, input: MessageInitShape<typeof UpdateBoardFormRequestSchema>) => this.rest.call(BoardFormResponseSchema, 'PUT', `/api/boards/${enc(boardId)}/forms/${enc(formId)}`, { json: Rest.body(UpdateBoardFormRequestSchema, input) }),
    delete: (boardId: string, formId: string) => this.rest.request('DELETE', `/api/boards/${enc(boardId)}/forms/${enc(formId)}`),
    get: (code: string) => this.rest.call(PublicBoardFormResponseSchema, 'GET', `/api/forms/${enc(code)}`),
    submit: (code: string, input: MessageInitShape<typeof SubmitBoardFormRequestSchema>) => this.rest.call(FormSubmissionResponseSchema, 'POST', `/api/forms/${enc(code)}/submissions`, { json: Rest.body(SubmitBoardFormRequestSchema, input) }),
    preview: (boardId: string, input: MessageInitShape<typeof PreviewBoardFormRequestSchema>) => this.rest.call(FormSubmissionResponseSchema, 'POST', `/api/boards/${enc(boardId)}/forms/preview`, { json: Rest.body(PreviewBoardFormRequestSchema, input) }),
  };

  readonly boards = {
    /** Boards of a workspace the bot sees. */
    list: async (workspaceId: string): Promise<Board[]> =>
      (await this.rest.call(ListBoardsResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/boards`)).boards,
    get: async (boardId: string): Promise<Board> =>
      (await this.rest.call(BoardResponseSchema, 'GET', `/api/boards/${enc(boardId)}`)).board ?? fail('board'),
    /**
     * Switches board features and the estimate scale (MANAGE_BOARD, ADR-0058 §3). `disabledFeatures` is the whole
     * list of switched-off features (an empty list enables everything); omit it to leave the set unchanged.
     */
    setFeatures: async (boardId: string, f: { disabledFeatures?: BoardFeature[]; estimateScale?: EstimateScale }): Promise<Board> =>
      (
        await this.rest.call(BoardResponseSchema, 'PATCH', `/api/boards/${enc(boardId)}`, {
          json: Rest.body(UpdateBoardRequestSchema, {
            setDisabledFeatures: f.disabledFeatures !== undefined,
            disabledFeatures: f.disabledFeatures ?? [],
            estimateScale: f.estimateScale,
          }),
        })
      ).board ?? fail('board'),
    /** One drag in one transaction: boards get a category ('' = none) and position, categories a position. */
    setOrder: (
      workspaceId: string,
      o: { boards?: { boardId: string; categoryId?: string; position: number }[]; categories?: { categoryId: string; position: number }[] },
    ): Promise<{ boards: Board[]; categories: BoardCategory[] }> =>
      this.rest.call(SetBoardOrderResponseSchema, 'PUT', `/api/workspaces/${enc(workspaceId)}/boards/order`, {
        json: Rest.body(SetBoardOrderRequestSchema, { boards: o.boards ?? [], categories: o.categories ?? [] }),
      }),
    /** Board categories (ADR-0058 §1; separate from room categories). Writes need CREATE_BOARDS. */
    categories: {
      list: async (workspaceId: string): Promise<BoardCategory[]> =>
        (await this.rest.call(ListBoardCategoriesResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/board-categories`)).categories,
      create: async (workspaceId: string, name: string, position?: number): Promise<BoardCategory> =>
        (
          await this.rest.call(BoardCategoryResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/board-categories`, {
            json: Rest.body(CreateBoardCategoryRequestSchema, { name, position }),
          })
        ).category ?? fail('category'),
      update: async (categoryId: string, p: { name?: string; position?: number }): Promise<BoardCategory> =>
        (
          await this.rest.call(BoardCategoryResponseSchema, 'PATCH', `/api/board-categories/${enc(categoryId)}`, {
            json: Rest.body(UpdateBoardCategoryRequestSchema, p),
          })
        ).category ?? fail('category'),
      /** Its boards move to «no category». */
      delete: async (categoryId: string): Promise<void> => {
        await this.rest.request('DELETE', `/api/board-categories/${enc(categoryId)}`);
      },
    },
  };

  readonly tasks = {
    /** All live tasks of a board (every page), optionally filtered (TaskFilter, ADR-0042 §3). */
    list: async (boardId: string, filter?: MessageInitShape<typeof TaskFilterSchema>): Promise<Task[]> => {
      const out: Task[] = [];
      const f = filter ? JSON.stringify(toJson(TaskFilterSchema, create(TaskFilterSchema, filter))) : undefined;
      for (let cursor = ''; ; ) {
        const r = await this.rest.call(ListTasksResponseSchema, 'GET', `/api/boards/${enc(boardId)}/tasks`, {
          query: { filter: f, cursor: cursor || undefined },
        });
        out.push(...r.tasks);
        if (!r.nextCursor) return out;
        cursor = r.nextCursor;
      }
    },
    /** Search over the boards the bot sees: by key (FNG-12) and words of title / description. */
    search: async (workspaceId: string, q: string, limit?: number): Promise<Task[]> =>
      (await this.rest.call(SearchTasksResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/tasks/search`, { query: { q, limit } }))
        .tasks,
    /** A task with its subtasks, related tasks and comment room. */
    get: (taskId: string): Promise<TaskResponse> => this.rest.call(TaskResponseSchema, 'GET', `/api/tasks/${enc(taskId)}`),
    create: async (boardId: string, t: MessageInitShape<typeof CreateTaskRequestSchema>): Promise<Task> =>
      (await this.rest.call(TaskResponseSchema, 'POST', `/api/boards/${enc(boardId)}/tasks`, { json: Rest.body(CreateTaskRequestSchema, t) }))
        .task ?? fail('task'),
    /** Changes fields (unset = unchanged); statusId with afterTaskId / beforeTaskId moves it in the kanban. */
    update: async (taskId: string, p: MessageInitShape<typeof UpdateTaskRequestSchema>): Promise<Task> =>
      (await this.rest.call(TaskResponseSchema, 'PATCH', `/api/tasks/${enc(taskId)}`, { json: Rest.body(UpdateTaskRequestSchema, p) })).task ??
      fail('task'),
    /** Replaces the assignees (exactly one lead; the first when none is marked). */
    setAssignees: async (taskId: string, assignees: { userId: string; isLead?: boolean; note?: string }[]): Promise<Task> =>
      (
        await this.rest.call(TaskResponseSchema, 'PUT', `/api/tasks/${enc(taskId)}/assignees`, {
          json: Rest.body(SetAssigneesRequestSchema, { assignees }),
        })
      ).task ?? fail('task'),
    /**
     * Checklists of a task (ADR-0058 §2; ≤ 10 per task, ≤ 100 items each; Team plan and up). Rights as for task fields;
     * every call returns the changed checklist and the task's counters.
     */
    checklists: {
      create: (taskId: string, title: string, position?: number): Promise<ChecklistResult> =>
        this.checklistCall('POST', `/api/tasks/${enc(taskId)}/checklists`, CreateTaskChecklistRequestSchema, { title, position }),
      update: (checklistId: string, p: { title?: string; position?: number }): Promise<ChecklistResult> =>
        this.checklistCall('PATCH', `/api/checklists/${enc(checklistId)}`, UpdateTaskChecklistRequestSchema, p),
      /** The result has no checklist, only the new counters. */
      delete: (checklistId: string): Promise<ChecklistResult> => this.checklistCall('DELETE', `/api/checklists/${enc(checklistId)}`),
      addItem: (checklistId: string, text: string, position?: number): Promise<ChecklistResult> =>
        this.checklistCall('POST', `/api/checklists/${enc(checklistId)}/items`, CreateTaskChecklistItemRequestSchema, { text, position }),
      /** `done` ticks / unticks; `checklistId` moves the item to another checklist of the same task. */
      updateItem: (itemId: string, p: { text?: string; done?: boolean; position?: number; checklistId?: string }): Promise<ChecklistResult> =>
        this.checklistCall('PATCH', `/api/checklist-items/${enc(itemId)}`, UpdateTaskChecklistItemRequestSchema, p),
      deleteItem: (itemId: string): Promise<ChecklistResult> => this.checklistCall('DELETE', `/api/checklist-items/${enc(itemId)}`),
      /** Turns the item into a subtask titled with its text (needs the SUBTASKS feature; the task must not be a subtask). */
      convertItem: async (itemId: string): Promise<{ task: Task; checklist?: TaskChecklist | undefined; checklistTotal: number; checklistDone: number }> => {
        const r = await this.rest.call(ConvertChecklistItemResponseSchema, 'POST', `/api/checklist-items/${enc(itemId)}/convert`);
        return { task: r.task ?? fail('task'), checklist: r.checklist, checklistTotal: r.checklistTotal, checklistDone: r.checklistDone };
      },
    },
    /**
     * Milestones inside a task (ADR-0063; ≤ 20 per task, not on subtasks). Rights as for task fields; every call returns
     * the milestone and the task with all its milestones. A subtask links one of its parent's milestones with
     * `tasks.update(id, { taskMilestoneId })`; while subtasks are linked the server completes the milestone itself.
     */
    milestones: {
      create: (taskId: string, name: string, dueOn = ''): Promise<TaskMilestoneResponse> =>
        this.rest.call(TaskMilestoneResponseSchema, 'POST', `/api/tasks/${enc(taskId)}/milestones`, {
          json: Rest.body(CreateTaskMilestoneRequestSchema, { name, dueOn }),
        }),
      /** `dueOn: ''` clears the date; `completed` is refused (409 TASK_MILESTONE_AUTO) while subtasks are linked. */
      update: (milestoneId: string, p: { name?: string; dueOn?: string; position?: number; completed?: boolean }): Promise<TaskMilestoneResponse> =>
        this.rest.call(TaskMilestoneResponseSchema, 'PATCH', `/api/task-milestones/${enc(milestoneId)}`, { json: Rest.body(UpdateTaskMilestoneRequestSchema, p) }),
      /** The result has the task only; linked subtasks lose their link. */
      delete: (milestoneId: string): Promise<TaskMilestoneResponse> => this.rest.call(TaskMilestoneResponseSchema, 'DELETE', `/api/task-milestones/${enc(milestoneId)}`),
    },
    /** A comment: a message of the task's hidden room (reactions, files, replies as in a chat). */
    comment: async (task: Task | string, content: SendContent): Promise<Message> => {
      const roomId = typeof task === 'string' ? ((await this.tasks.get(task)).task?.roomId ?? fail('task')) : task.roomId;
      return this.send(roomId, content);
    },
  };

  private async checklistCall<S extends DescMessage>(
    method: string,
    path: string,
    schema?: S,
    body?: MessageInitShape<S>,
  ): Promise<ChecklistResult> {
    const r = await this.rest.call(TaskChecklistResponseSchema, method, path, schema && body ? { json: Rest.body(schema, body) } : {});
    return { checklist: r.checklist, checklistTotal: r.checklistTotal, checklistDone: r.checklistDone };
  }

  // ---- calendar (ADR-0038, ADR-0051): the bot organizes meetings but never attends them ----

  readonly calendar = {
    /** Occurrences overlapping [from, to) (≤ 62 days) the bot sees: its own meetings and those of rooms it views. */
    list: async (workspaceId: string, from: Date, to: Date): Promise<CalendarEvent[]> =>
      (
        await this.rest.call(ListCalendarEventsResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/events`, {
          query: { from: from.toISOString(), to: to.toISOString() },
        })
      ).events,
    get: async (eventId: string): Promise<CalendarEvent> =>
      (await this.rest.call(CalendarEventResponseSchema, 'GET', `/api/events/${enc(eventId)}`)).event ?? fail('event'),
    /**
     * Creates a meeting organized by the bot (times: `timestampFromDate` of `@bufbuild/protobuf/wkt`).
     * The bot is not an attendee; invitations to outside addresses go out on its behalf.
     */
    create: async (workspaceId: string, e: MessageInitShape<typeof CreateCalendarEventRequestSchema>): Promise<CalendarEvent> =>
      (
        await this.rest.call(CalendarEventResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/events`, {
          json: Rest.body(CreateCalendarEventRequestSchema, e),
        })
      ).event ?? fail('event'),
    /** Changes a meeting: its own, or others' with MANAGE_ROOM in the room / MANAGE_EVENTS. */
    update: async (eventId: string, p: MessageInitShape<typeof UpdateCalendarEventRequestSchema>): Promise<CalendarEvent> =>
      (
        await this.rest.call(CalendarEventResponseSchema, 'PATCH', `/api/events/${enc(eventId)}`, {
          json: Rest.body(UpdateCalendarEventRequestSchema, p),
        })
      ).event ?? fail('event'),
    /** Cancels the meeting, or one occurrence of a series. */
    delete: async (eventId: string, occurrence?: Date): Promise<void> => {
      await this.rest.request('DELETE', `/api/events/${enc(eventId)}`, { query: { occurrence: occurrence?.toISOString() } });
    },
    /** Busy time of ≤ 20 members in [from, to) (≤ 14 days): the fact of being busy only. */
    freebusy: async (workspaceId: string, users: string[], from: Date, to: Date): Promise<FreeBusyUser[]> =>
      (
        await this.rest.call(FreeBusyResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/freebusy`, {
          query: { users: users.join(','), from: from.toISOString(), to: to.toISOString() },
        })
      ).users,
    /** Up to 10 earliest common free windows (optionally within working hours and a free room). */
    suggest: async (workspaceId: string, q: MessageInitShape<typeof SuggestSlotsRequestSchema>): Promise<Slot[]> =>
      (
        await this.rest.call(SuggestSlotsResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/freebusy/suggest`, {
          json: Rest.body(SuggestSlotsRequestSchema, q),
        })
      ).slots,
  };

  // ---- invitations (INVITE_MEMBERS, ADR-0043 / ADR-0051) ----

  readonly invites = {
    list: async (workspaceId: string): Promise<Invite[]> =>
      (await this.rest.call(ListInvitesResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/invites`)).invites,
    /** An invite link: `maxUses` 0 = unlimited, `expiresInSeconds` 0 = never. */
    create: async (workspaceId: string, o: { maxUses?: number; expiresInSeconds?: number } = {}): Promise<Invite> =>
      (
        await this.rest.call(CreateInviteResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/invites`, {
          json: Rest.body(CreateInviteRequestSchema, o),
        })
      ).invite ?? fail('invite'),
    delete: async (workspaceId: string, inviteId: string): Promise<void> => {
      await this.rest.request('DELETE', `/api/workspaces/${enc(workspaceId)}/invites/${enc(inviteId)}`);
    },
    /** An invitation by mail («… on behalf of bot X»); the same address again only after 24 h. */
    email: async (workspaceId: string, email: string): Promise<EmailInvite> =>
      (
        await this.rest.call(CreateEmailInviteResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/invites/email`, {
          json: Rest.body(CreateEmailInviteRequestSchema, { email }),
        })
      ).invite ?? fail('invite'),
    listEmail: async (workspaceId: string): Promise<EmailInvite[]> =>
      (await this.rest.call(ListEmailInvitesResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/invites/email`)).invites,
    deleteEmail: async (workspaceId: string, inviteId: string): Promise<void> => {
      await this.rest.request('DELETE', `/api/workspaces/${enc(workspaceId)}/invites/email/${enc(inviteId)}`);
    },
  };

  // ---- badges (library: MANAGE_MEMBERS; a member's badge: MANAGE_NICKNAMES) ----

  readonly badges = {
    list: async (workspaceId: string): Promise<Badge[]> =>
      (await this.rest.call(ListBadgesResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/badges`)).badges,
    /** A badge from a picture (PNG / WebP / JPEG ≤ 128 KB, ≤ 256×256): a file or the id of the bot's upload. */
    create: async (workspaceId: string, name: string, picture: FileInput | string): Promise<Badge> => {
      const fileId = typeof picture === 'string' ? picture : (await this.uploadTo(workspaceId, picture)).id;
      return (
        (
          await this.rest.call(CreateBadgeResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/badges`, {
            json: Rest.body(CreateBadgeRequestSchema, { name, fileId }),
          })
        ).badge ?? fail('badge')
      );
    },
    update: async (workspaceId: string, badgeId: string, p: { name?: string; fileId?: string }): Promise<Badge> =>
      (
        await this.rest.call(UpdateBadgeResponseSchema, 'PATCH', `/api/workspaces/${enc(workspaceId)}/badges/${enc(badgeId)}`, {
          json: Rest.body(UpdateBadgeRequestSchema, p),
        })
      ).badge ?? fail('badge'),
    delete: async (workspaceId: string, badgeId: string): Promise<void> => {
      await this.rest.request('DELETE', `/api/workspaces/${enc(workspaceId)}/badges/${enc(badgeId)}`);
    },
    /** Gives a member (not a bot) a badge; '' takes it. */
    set: async (workspaceId: string, userId: string, badgeId: string): Promise<WorkspaceMember> =>
      (
        await this.rest.call(SetMemberBadgeResponseSchema, 'PUT', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}/badge`, {
          json: Rest.body(SetMemberBadgeRequestSchema, { badgeId }),
        })
      ).member ?? fail('member'),
  };

  // ---- meeting recording (a bot needs MANAGE_RECORDINGS, ADR-0051) ----

  readonly recording = {
    /** Starts recording a voice room with a call going (allow_recording, a paired workspace). */
    start: async (roomId: string): Promise<RoomRecording> =>
      (await this.rest.call(StartRecordingResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/recording/start`)).recording ?? fail('recording'),
    stop: async (roomId: string): Promise<RoomRecording> =>
      (await this.rest.call(StopRecordingResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/recording/stop`)).recording ?? fail('recording'),
  };

  /** Uploads a file into a workspace (badges, stickers …). */
  private async uploadTo(workspaceId: string, file: FileInput): Promise<FileMeta> {
    const r = await this.rest.call(UploadFileResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/files`, {
      form: () => {
        const f = new FormData();
        f.append('file', toBlob(file.data, file.type), file.name);
        return f;
      },
    });
    return r.file ?? fail('file');
  }

  // ---- events ----

  private setMe(u: User): void {
    this.meUser = u;
    this.botUserId = u.id;
  }

  private reportError(err: Error, fromErrorListener: boolean): void {
    if (!fromErrorListener && this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[calab-bot]', err);
  }

  private indexRoom(r: Room): void {
    this.roomsById.set(r.id, { workspaceId: r.workspaceId, type: r.type });
  }

  private indexSnapshot(s: WorkspaceSnapshot): void {
    for (const r of s.rooms) this.indexRoom(r);
    for (const v of s.voiceStates) this.setVoiceState(v);
  }

  private setVoiceState(v: VoiceState): void {
    const key = `${v.workspaceId}:${v.userId}`;
    if (v.roomId) this.voiceStates.set(key, v);
    else this.voiceStates.delete(key);
  }

  private async roomInfo(roomId: string): Promise<RoomInfo> {
    const known = this.roomsById.get(roomId);
    if (known) return known;
    const r = await this.room(roomId);
    return { workspaceId: r.workspaceId, type: r.type };
  }

  private isOwn(userId: string): boolean {
    return !this.opts.receiveOwn && userId !== '' && userId === this.botUserId;
  }

  private handle(ev: DispatchEvent): void {
    this.emit('dispatch', ev);
    const e = ev.event;
    switch (e.case) {
      case 'ready':
        if (e.value.me?.user) this.setMe(e.value.me.user);
        for (const s of e.value.workspaces) this.indexSnapshot(s);
        for (const d of e.value.dms) if (d.room) this.roomsById.set(d.room.id, { workspaceId: '', type: RoomType.DM });
        this.emit('ready', e.value);
        return;
      case 'resumed':
        this.emit('resumed', e.value);
        return;
      case 'workspaceCreate':
        if (e.value.snapshot) this.indexSnapshot(e.value.snapshot);
        return;
      case 'workspaceDelete':
        for (const [id, r] of this.roomsById) if (r.workspaceId === e.value.workspaceId) this.roomsById.delete(id);
        for (const [k, v] of this.voiceStates) if (v.workspaceId === e.value.workspaceId) this.voiceStates.delete(k);
        return;
      case 'roomCreate':
      case 'roomUpdate':
        if (e.value.room) this.indexRoom(e.value.room);
        return;
      case 'roomDelete':
        this.roomsById.delete(e.value.roomId);
        return;
      case 'dmCreate':
        if (e.value.dm?.room) this.roomsById.set(e.value.dm.room.id, { workspaceId: '', type: RoomType.DM });
        return;
      case 'messageCreate': {
        const m = e.value.message;
        if (!m || this.isOwn(m.authorId)) return;
        const cmd = m.command;
        if (cmd && (cmd.botUserId === this.botUserId || !this.botUserId)) {
          this.emit('command', { name: cmd.name, args: cmd.args, message: m, workspaceId: e.value.workspaceId });
          return;
        }
        this.emit('message', m);
        return;
      }
      case 'botCallback':
        if (e.value.botUserId === this.botUserId || !this.botUserId) this.emit('callback', e.value);
        return;
      case 'messageUpdate':
        if (e.value.message && !this.isOwn(e.value.message.authorId)) this.emit('messageUpdate', e.value.message);
        return;
      case 'messageDelete': {
        const d: MessageDelete = e.value;
        this.emit('messageDelete', { workspaceId: d.workspaceId, roomId: d.roomId, messageId: d.messageId });
        return;
      }
      case 'messageReactionAdd':
      case 'messageReactionRemove': {
        const r = e.value;
        if (this.isOwn(r.userId)) return;
        this.emit('reaction', {
          type: e.case === 'messageReactionAdd' ? 'add' : 'remove',
          workspaceId: r.workspaceId,
          roomId: r.roomId,
          messageId: r.messageId,
          userId: r.userId,
          emoji: r.emoji,
        });
        return;
      }
      case 'voiceStateUpdate':
        if (e.value.state) {
          this.setVoiceState(e.value.state);
          this.emit('voiceState', e.value.state);
        }
        return;
      default:
        return;
    }
  }
}

const enc = encodeURIComponent;

function fail(what: string): never {
  throw new Error(`empty ${what} in the response`);
}

function toBlob(data: FileInput['data'], type?: string): Blob {
  if (data instanceof Blob) return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], type ? { type } : {});
}

/** The changed checklist (unset after a delete) and the task's checklist counters. */
export interface ChecklistResult {
  checklist?: TaskChecklist | undefined;
  checklistTotal: number;
  checklistDone: number;
}
