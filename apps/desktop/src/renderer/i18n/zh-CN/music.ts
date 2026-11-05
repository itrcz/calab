import type { enMusic } from '../en/music';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — musician mode (ADR-0052, docs/02, docs/08). Same keys as en/music.ts. */
export const zhMusic: DictShape<typeof enMusic> = {
  'music.mode': '音乐人模式',
  'music.hint': '乐器和人声的现场声音：不做回声消除、降噪和自动增益，高音质，停顿时麦克风不关闭。仅限使用耳机。',
  'music.warnHeadphones': '需要耳机：没有回声消除，其他人会听到自己的声音。',
  'music.warnSpeakers': '声音正从扬声器播放（{device}）。没有回声消除，其他人会听到自己的声音——请戴上耳机。',
  'music.echoRisk': '其他人听到了自己的声音：音乐人模式没有回声消除。请戴上耳机或关闭该模式',
  'music.turnOff': '关闭音乐人模式',
  'music.off': '关闭',
  'music.badge': '音乐人',
  'music.badgeHint': '音乐人模式：未经处理的声音',
  'music.rnnoiseOff': '音乐人模式下已关闭',
  'music.audioOnly': 'iPhone 上暂不支持音乐人模式',
  'music.aecNote': '音乐人模式：回声消除、降噪和自动增益已关闭。',
  'music.stats': '音乐人',
};
