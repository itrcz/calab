const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { test } = require('node:test');
const withCallAudio = require('./withCallAudio');

const FLAGS = ['CALAB_IOS_NATIVE_CALL_AUDIO', 'CALAB_IOS_NATIVE_ROOM_AUDIO', 'CALAB_IOS_RTC_HOSTS'];
function keepEnv(t) {
  const previous = Object.fromEntries(FLAGS.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value; } });
  for (const name of FLAGS) Reflect.deleteProperty(process.env, name);
}
const mobileRoot = path.dirname(require.resolve('../package.json'));
const podfile = async contents => {
  const config = withCallAudio({});
  const result = await config.mods.ios.podfile({ ...config, modResults: { contents }, modRequest: { platform: 'ios', modName: 'podfile' } });
  return result.modResults.contents;
};
const infoPlist = async plist => {
  const config = withCallAudio({});
  const result = await config.mods.ios.infoPlist({ ...config, modResults: plist, modRequest: { platform: 'ios', modName: 'infoPlist' } });
  return result.modResults;
};
const original = "target 'Calab' do\n  use_expo_modules!\nend\n";

test('the optional SDK is absent by default and a repeated opt-in has one pod', async (t) => {
  keepEnv(t);
  assert.equal(await podfile(original), original);
  process.env.CALAB_IOS_NATIVE_CALL_AUDIO = '1';
  let contents = original;
  for (let i = 0; i < 3; i++) contents = await podfile(contents);
  assert.equal(contents.split("pod 'CalabLiveKit'").length - 1, 1);
  assert.equal(contents.split('https://github.com/livekit/podspecs.git').length - 1, 1);
  delete process.env.CALAB_IOS_NATIVE_CALL_AUDIO;
  contents = await podfile(contents);
  assert.ok(!contents.includes('CalabLiveKit'));
  assert.ok(!contents.includes('livekit/podspecs'));
});

test('the room flag alone links the same pod once, and an opt-out leaves no stale line', async (t) => {
  keepEnv(t);
  process.env.CALAB_IOS_NATIVE_ROOM_AUDIO = '1';
  process.env.CALAB_IOS_RTC_HOSTS = 'rtc.calab.ru';
  let contents = original;
  for (let i = 0; i < 3; i++) contents = await podfile(contents);
  assert.equal(contents.split("pod 'CalabLiveKit'").length - 1, 1);
  process.env.CALAB_IOS_NATIVE_CALL_AUDIO = '1';
  contents = await podfile(contents);
  assert.equal(contents.split("pod 'CalabLiveKit'").length - 1, 1, 'both flags link one pod');
  delete process.env.CALAB_IOS_NATIVE_CALL_AUDIO;
  delete process.env.CALAB_IOS_NATIVE_ROOM_AUDIO;
  contents = await podfile(contents);
  assert.ok(!contents.includes('CalabLiveKit'));
  assert.ok(!contents.includes('livekit/podspecs'));
});

test('Info.plist carries the room flag and hosts only with the flag, and an opt-out removes them', async (t) => {
  keepEnv(t);
  const base = { NSMicrophoneUsageDescription: 'x' };
  assert.deepEqual(await infoPlist({ ...base }), base);
  process.env.CALAB_IOS_NATIVE_ROOM_AUDIO = '1';
  process.env.CALAB_IOS_RTC_HOSTS = 'rtc.calab.ru rtc2.calab.ru rtc.calab.ru';
  const on = await infoPlist({ ...base });
  assert.equal(on.CalabRoomAudioEnabled, true);
  assert.deepEqual(on.CalabRoomAudioHosts, ['rtc.calab.ru', 'rtc2.calab.ru']);
  // The incoming-calls flag is independent: it neither needs nor writes the room keys.
  delete process.env.CALAB_IOS_NATIVE_ROOM_AUDIO;
  process.env.CALAB_IOS_NATIVE_CALL_AUDIO = '1';
  assert.deepEqual(await infoPlist({ ...on }), base);
  process.env.CALAB_IOS_NATIVE_ROOM_AUDIO = '1';
  process.env.CALAB_IOS_RTC_HOSTS = 'https://rtc.calab.ru';
  assert.throws(() => withCallAudio({}), /CALAB_IOS_RTC_HOSTS/);
  // No list writes an empty one: native room audio then stays off, never "any host".
  delete process.env.CALAB_IOS_RTC_HOSTS;
  assert.deepEqual((await infoPlist({ ...base })).CalabRoomAudioHosts, []);
});

test('room sounds: every cue, MP3 copied, Opus converted, and removed without the flag', () => {
  const log = [];
  const io = { reset: (dir, create) => log.push(['reset', dir, create]), copy: (from, to) => log.push(['copy', from, to]), convert: (from, to) => log.push(['convert', from, to]) };
  const project = path.join('/calab', 'apps', 'mobile');
  const dir = path.join(project, withCallAudio.ROOM_SOUNDS_DIR);
  const files = withCallAudio.writeRoomSounds(project, true, io);
  assert.deepEqual(log[0], ['reset', dir, true]);
  assert.equal(files.length, Object.keys(withCallAudio.ROOM_SOUNDS).length);
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.includes('calab-room-pttOn.mp3') && files.includes('calab-room-builtin-quack.m4a'));
  assert.deepEqual(log.find(entry => entry[0] === 'copy' && entry[2].endsWith('calab-room-join.mp3')), ['copy', '/calab/apps/desktop/resources/sounds/join.mp3', path.join(dir, 'calab-room-join.mp3')]);
  const converted = log.filter(entry => entry[0] === 'convert');
  assert.equal(converted.length, 6);
  assert.ok(converted.every(entry => entry[1].endsWith('.ogg') && entry[2].endsWith('.m4a')));
  log.length = 0;
  assert.deepEqual(withCallAudio.writeRoomSounds(project, false, io), []);
  assert.deepEqual(log, [['reset', dir, false]]);
});

test('every room sound source exists in the desktop app', () => {
  for (const source of Object.values(withCallAudio.ROOM_SOUNDS)) {
    assert.ok(fs.existsSync(path.join(mobileRoot, '../desktop', source)), source);
  }
});
