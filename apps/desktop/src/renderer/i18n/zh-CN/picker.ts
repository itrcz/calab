import type { ruPicker } from '../ru/picker';
import type { DictShape } from '../types';

/** UI strings (zh-CN) — the member / room picker and the room invite dialog (docs/09 #33). */
export const zhPicker: DictShape<typeof ruPicker> = {
  'picker.empty': "未找到任何人",
  'picker.noRooms': "未找到房间",
  'picker.searchPeople': "姓名、昵称、邮箱或电话",
  'picker.searchRooms': "查找房间",
  'picker.roles': "角色",
  'picker.members': "成员",
  'picker.guests': "访客 · {n}",
  'picker.rooms': "房间",
  'picker.fullAccess': "完全权限",
  'picker.alwaysFull': "始终拥有完全权限：房间设置对此角色无效",
  'picker.listed': "已在列表中",
  'roomInvite.title': "邀请加入 {room}",
  'roomInvite.hint': "对方将收到一条附有房间链接的私信。",
  'roomInvite.send': "邀请",
  'roomInvite.sent': "已发送",
  'roomInvite.inRoom': "已在房间中",
  'roomInvite.dmText': "邀请你加入 {room}：{link}",
  'roomInvite.failed': "无法发送邀请",
  'roomInvite.link': "或发送链接",
  'roomInvite.copy': "复制",
};
