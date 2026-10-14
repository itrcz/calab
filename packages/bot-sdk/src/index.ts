// Calab Bot SDK (ADR-0031, docs/19-bot-api.md).
export { Bot } from './bot.js';
export type {
  BotEvents,
  BotOptions,
  ChecklistResult,
  CommandEvent,
  FileInput,
  EditOptions,
  MessageDeleteEvent,
  ReactionEvent,
  SendContent,
  SendOptions,
} from './bot.js';
export { ApiError, GatewayFatalError, type GatewayFatal } from './errors.js';
export type { DiskApi, DiskDownload, DiskListOptions, DiskUploadData } from './disk.js';
export type { WikiApi, WikiListOptions, WikiPageContent, WikiPageHandle, WikiWriteOptions } from './wiki.js';
export { WikiSyncError, WikiSyncSession, wikiSyncUrl, type SyncSocket, type WikiSyncOptions } from './wikiSync.js';
export { Gateway, gatewayUrl, type GatewayOptions, type GatewayStatus, type SocketLike } from './gateway.js';
export { Rest, parseRetryAfter, type RestOptions } from './rest.js';
export {
  BOARD_WEBHOOK_TOLERANCE_SECONDS,
  DELIVERY_HEADER,
  SIGNATURE_HEADER,
  parseBoardWebhookEvent,
  parseWebhookUpdate,
  signBoardWebhook,
  signWebhook,
  verifyBoardWebhook,
  verifyWebhookSignature,
} from './webhook.js';
// Contract types the events and methods use (generated from proto/calaba/v1).
export type {
  Badge,
  Board,
  BoardCategory,
  BoardWebhookEvent,
  TaskChecklist,
  TaskChecklistItem,
  Bot as BotProfile,
  BotCommand,
  CalendarEvent,
  EmailInvite,
  FreeBusyUser,
  GetMemberResponse,
  Invite,
  RoomRecording,
  Slot,
  Task,
  BotCallback,
  TaskNoticeRelay,
  InlineKeyboard,
  InlineKeyboardRow,
  InlineButton,
  BotWebhook,
  BotWebhookUpdate,
  DispatchEvent,
  DmSummary,
  FileMeta,
  JoinVoiceResponse,
  Message,
  MessageCommand,
  Ready,
  Resumed,
  Room,
  Sticker,
  StickerPack,
  UploadStickersResponse,
  User,
  VoiceState,
  Workspace,
  WorkspaceMember,
  DiskItem,
  DiskLink,
  DiskPermissionEntry,
  WikiPage,
  WikiLink,
  WikiPermissionEntry,
  WikiVersion,
} from '@calaba/protocol';
export { BoardFeature, DISK_BITS, DiskItemKind, EstimateScale, PermissionTargetType, RoomType, WIKI_BITS } from '@calaba/protocol';
