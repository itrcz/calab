import type { ruFormer } from '../ru/former';
import type { DictShape } from '../types';

/** UI strings — former members and guests (ADR-0097, ADR-0098). */
export const zhFormer: DictShape<typeof ruFormer> = {
  'former.chip': '前成员',
  'former.since': '{date} 离开',
  'former.profile': '前成员 · {what} {date}',
  'former.profileNoDate': '前成员',
  'former.reason.left': '已离开',
  'former.reason.removed': '已移除',
  'former.reason.banned': '已封禁',
  'former.reason.guestExpired': '访客权限已过期',
  'former.reason.directory': '已在目录中停用',
  'former.tab': '前成员',
  'former.card': '前成员 — {n}',
  'former.none': '没有前成员',
  'former.search': '按名称搜索',
  'former.showGuests': '显示访客',
  'former.guestsHint': '无活动的访客将在 48 小时后移除',
  'former.openTasks': '未完成任务：{n}',
  'former.openTasksOpen': '未完成任务：{n}',
  'former.invite': '重新邀请',
  'former.inviteFor': '重新邀请 {name}',
  'former.more': '显示更多',
  'former.by': '操作人：{who}',
  'former.reassign': '重新分配',
  'former.filter': '负责人：前成员',
  'former.filterValue': '前成员',
  'former.guestsGroup': '访客 · {n}',
  'former.seen': '{when}在线',
  'former.noActions': '与其私信仍保留在“私信”中',
};
