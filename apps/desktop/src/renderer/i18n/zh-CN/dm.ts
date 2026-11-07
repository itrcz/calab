import type { enDm } from '../en/dm';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — direct messages (ADR-0020, ADR-0022). Same keys as en/dm.ts. */
export const zhDm: DictShape<typeof enDm> = {
  'dm.home': '私信',
  'dm.homeUnread': '私信，未读：{n}',
  'dm.list': '私信',
  'dm.new': '新建私信',
  'dm.empty': '暂无私信',
  'dm.emptyHint': '给同事发消息：使用"新建私信"、其资料页或成员菜单。',
  'dm.pickTitle': '私信',
  'dm.pickText': '在左侧选择一个对话，或开始新的对话。',
  'dm.you': '你',
  'dm.noMessages': '暂无消息',
  'dm.placeholder': '发消息给 @{name}',
  'dm.searchIn': '在对话中搜索',
  'dm.searchMessages': '搜索消息',
  'dm.searchChats': '聊天',
  'dm.searchFailed': '搜索失败，请重试。',
  'dm.write': '发消息',
  'dm.welcomeText': '这里是你私信记录的开始。',
  'dm.markRead': '标为已读',
  'dm.copyLink': '复制链接',
  'dm.linkCopied': '链接已复制',
  'dm.chat': '与{name}的对话',
  // "New message"
  'dm.newTitle': '新建私信',
  'dm.newSearch': '姓名或昵称',
  'dm.newHint': '可以给你所在工作区的成员发消息。',
  'dm.newEmpty': '未找到相关成员',
  'dm.newFailed': '列表加载失败',
  // errors of POST /api/dms
  'dm.errRateLimited': '新建对话过于频繁——请稍后再试',
  'dm.errGuest': '访客无法使用私信',
  'dm.errNoCommon': '你与该用户没有共同的工作区',
  'dm.errSelf': '不能给自己发私信',
  'dm.errCreate': '对话创建失败',
  // a /dm/<id> link of someone else's (or a deleted) conversation
  'dm.errLink': '该对话不可用：不属于你，或已被删除',
  // archive and «delete for me» (docs/09 #51)
  'dm.archive': '归档',
  'dm.unarchive': '取消归档',
  'dm.archiveSection': '归档 — {n}',
  'dm.deleteTitle': '删除聊天？',
  'dm.deleteConfirm': '聊天记录只会为你删除，对方仍会保留。',
  'dm.errState': '无法更新对话',
  'dm.actions': '对话操作',
  // quick switcher
  'search.dms': '私信',
} as const;
