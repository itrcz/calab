const assert = require('node:assert/strict');
const process = require('node:process');
const { test } = require('node:test');
const withCallAudio = require('./withCallAudio');

test('the optional SDK is absent by default and a repeated opt-in has one pod', async (t) => {
  const previous = process.env.CALAB_IOS_NATIVE_CALL_AUDIO;
  t.after(() => { if (previous === undefined) delete process.env.CALAB_IOS_NATIVE_CALL_AUDIO; else process.env.CALAB_IOS_NATIVE_CALL_AUDIO = previous; });
  const apply = async contents => {
    const config = withCallAudio({});
    const result = await config.mods.ios.podfile({ ...config, modResults: { contents }, modRequest: { platform: 'ios', modName: 'podfile' } });
    return result.modResults.contents;
  };
  delete process.env.CALAB_IOS_NATIVE_CALL_AUDIO;
  const original = "target 'Calab' do\n  use_expo_modules!\nend\n";
  assert.equal(await apply(original), original);
  process.env.CALAB_IOS_NATIVE_CALL_AUDIO = '1';
  let contents = original;
  for (let i = 0; i < 3; i++) contents = await apply(contents);
  assert.equal(contents.split("pod 'CalabLiveKit'").length - 1, 1);
  assert.equal(contents.split('https://github.com/livekit/podspecs.git').length - 1, 1);
  delete process.env.CALAB_IOS_NATIVE_CALL_AUDIO;
  contents = await apply(contents);
  assert.ok(!contents.includes('CalabLiveKit'));
  assert.ok(!contents.includes('livekit/podspecs'));
});
