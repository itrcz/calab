const { withPodfile } = require('expo/config-plugins');
const process = require('node:process');
module.exports = function withCallAudio(config) {
  const enabled = process.env.CALAB_IOS_NATIVE_CALL_AUDIO === '1';
  return withPodfile(config, mod => {
    const source = 'source "https://github.com/livekit/podspecs.git"';
    const pod = "  pod 'CalabLiveKit', :podspec => '../modules/calab-session-activity/CalabLiveKit.podspec'";
    // An opt-out must also remove a previous local opt-in from a reused native tree.
    mod.modResults.contents = mod.modResults.contents.split('\n').filter(line => line !== source && line !== pod).join('\n');
    if (enabled) {
      if (!mod.modResults.contents.includes('  use_expo_modules!')) throw new Error('Calab call audio: Expo Podfile target was not found');
      if (!mod.modResults.contents.includes('source "https://cdn.cocoapods.org/"')) mod.modResults.contents = 'source "https://cdn.cocoapods.org/"\n' + mod.modResults.contents;
      mod.modResults.contents = source + '\n' + mod.modResults.contents.replace('  use_expo_modules!', '  use_expo_modules!\n' + pod);
    }
    return mod;
  });
};
