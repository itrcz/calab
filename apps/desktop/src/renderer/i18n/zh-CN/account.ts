import type { ruAccount } from '../ru/account';
import type { DictShape } from '../types';

/** UI strings (Simplified Chinese) — account deletion (ADR-0153). */
export const zhAccount: DictShape<typeof ruAccount> = {
  'account.delete.card': '删除账号',
  'account.delete.row': '删除账号',
  'account.delete.rowHint': '立即且永久删除。工作区中的消息会保留，署名为“已删除的用户”。',
  'account.delete.open': '删除…',
  'account.delete.title': '删除你的账号？',
  'account.delete.text': '账号将立即永久删除，无法恢复。',
  'account.delete.goneTitle': '将被删除',
  'account.delete.goneProfile': '个人资料：姓名、邮箱、密码、头像、用户名、电话、生日',
  'account.delete.goneSessions': '所有设备上的登录及其通知',
  'account.delete.gonePersonal': '个人笔记、关于他人的备注、已连接的日历、应用授权',
  'account.delete.staysTitle': '将保留',
  'account.delete.stays': '工作区和私信中的消息、任务和文件会保留给其成员，作者显示为“已删除的用户”。',
  'account.delete.ownerTitle': '请先删除你的工作区',
  'account.delete.ownerText': '请在工作区设置中删除工作区，或写信至 support@calab.io 转交所有权。',
  'account.delete.confirm': '永久删除',
  'account.delete.done': '账号已删除',
};
