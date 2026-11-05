const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { execFileSync } = require('node:child_process');
const { withDangerousMod, withInfoPlist, withPodfile } = require('expo/config-plugins');
const { parseRtcHosts } = require('../src/config');

// Native room cues by name (ADR-0149 §5): the desktop's bundled UI cues (renderer/lib/sounds.ts
// FILE_SOUNDS) and built-in soundboard clips (renderer/assets/sounds), relative to apps/desktop.
const ROOM_SOUNDS = {
  join: 'resources/sounds/join.mp3', leave: 'resources/sounds/leave.mp3', mute: 'resources/sounds/mute.mp3',
  unmute: 'resources/sounds/unmute.mp3', deafen: 'resources/sounds/deafen.mp3', undeafen: 'resources/sounds/undeafen.mp3',
  pttOn: 'resources/sounds/ptt-on.mp3', pttOff: 'resources/sounds/ptt-off.mp3', mention: 'resources/sounds/mention.mp3',
  message: 'resources/sounds/message.mp3', streamStart: 'resources/sounds/stream-start.mp3', streamEnd: 'resources/sounds/stream-end.mp3',
  watchStart: 'resources/sounds/watch-start.mp3', watchStop: 'resources/sounds/watch-stop.mp3', moved: 'resources/sounds/moved.mp3',
  disconnect: 'resources/sounds/disconnect.mp3', reconnect: 'resources/sounds/reconnect.mp3', recStart: 'resources/sounds/rec-start.mp3',
  recStop: 'resources/sounds/rec-stop.mp3',
  'builtin:air_horn': 'src/renderer/assets/sounds/air_horn.ogg', 'builtin:ba_dum_tss': 'src/renderer/assets/sounds/ba_dum_tss.ogg',
  'builtin:cricket': 'src/renderer/assets/sounds/cricket.ogg', 'builtin:golf_clap': 'src/renderer/assets/sounds/golf_clap.ogg',
  'builtin:quack': 'src/renderer/assets/sounds/quack.ogg', 'builtin:sad_horn': 'src/renderer/assets/sounds/sad_horn.ogg',
};
// Generated and git-ignored; the podspec ships it as resources only with the room flag.
const ROOM_SOUNDS_DIR = 'modules/calab-session-activity/ios/RoomSounds';

// iOS has no Ogg reader, so the Opus clips become AAC; afconvert ships with every macOS that builds iOS.
function afconvert(from, to) {
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', from, to], { stdio: 'pipe' });
}

const disk = {
  reset(dir, create) { fs.rmSync(dir, { recursive: true, force: true }); if (create) fs.mkdirSync(dir, { recursive: true }); },
  copy: (from, to) => fs.copyFileSync(from, to),
  convert: afconvert,
};

/** Writes `calab-room-<cue>` files the driver plays by name (CalabRoomAudio.swift), or removes them. */
function writeRoomSounds(projectRoot, enabled, io = disk) {
  const target = path.join(projectRoot, ROOM_SOUNDS_DIR);
  io.reset(target, enabled);
  if (!enabled) return [];
  return Object.entries(ROOM_SOUNDS).map(([cue, source]) => {
    const from = path.join(projectRoot, '../desktop', source);
    const base = `calab-room-${cue.replace(':', '-')}`;
    // AVAudioFile reads MP3 as it is.
    if (from.endsWith('.mp3')) { io.copy(from, path.join(target, `${base}.mp3`)); return `${base}.mp3`; }
    io.convert(from, path.join(target, `${base}.m4a`));
    return `${base}.m4a`;
  });
}

function withCallAudio(config) {
  const call = process.env.CALAB_IOS_NATIVE_CALL_AUDIO === '1';
  const room = process.env.CALAB_IOS_NATIVE_ROOM_AUDIO === '1';
  const hosts = room ? parseRtcHosts(process.env.CALAB_IOS_RTC_HOSTS) : [];
  config = withInfoPlist(config, mod => {
    // A reused native tree loses a previous opt-in too.
    delete mod.modResults.CalabRoomAudioEnabled;
    delete mod.modResults.CalabRoomAudioHosts;
    if (room) { mod.modResults.CalabRoomAudioEnabled = true; mod.modResults.CalabRoomAudioHosts = hosts; }
    return mod;
  });
  config = withDangerousMod(config, ['ios', mod => { writeRoomSounds(mod.modRequest.projectRoot, room); return mod; }]);
  return withPodfile(config, mod => {
    const source = 'source "https://github.com/livekit/podspecs.git"';
    const pod = "  pod 'CalabLiveKit', :podspec => '../modules/calab-session-activity/CalabLiveKit.podspec'";
    // An opt-out must also remove a previous local opt-in from a reused native tree.
    mod.modResults.contents = mod.modResults.contents.split('\n').filter(line => line !== source && line !== pod).join('\n');
    if (call || room) {
      if (!mod.modResults.contents.includes('  use_expo_modules!')) throw new Error('Calab native audio: Expo Podfile target was not found');
      if (!mod.modResults.contents.includes('source "https://cdn.cocoapods.org/"')) mod.modResults.contents = 'source "https://cdn.cocoapods.org/"\n' + mod.modResults.contents;
      mod.modResults.contents = source + '\n' + mod.modResults.contents.replace('  use_expo_modules!', '  use_expo_modules!\n' + pod);
    }
    return mod;
  });
}

module.exports = withCallAudio;
module.exports.ROOM_SOUNDS = ROOM_SOUNDS;
module.exports.ROOM_SOUNDS_DIR = ROOM_SOUNDS_DIR;
module.exports.writeRoomSounds = writeRoomSounds;
