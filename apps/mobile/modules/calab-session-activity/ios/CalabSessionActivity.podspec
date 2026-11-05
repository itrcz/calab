Pod::Spec.new do |s|
  s.name = 'CalabSessionActivity'
  s.version = '1.0.0'
  s.summary = 'Calab shared web host native integrations'
  s.description = s.summary
  s.author = 'Calab'
  s.homepage = 'https://github.com/itrcz/calab'
  s.license = { :type => 'BUSL-1.1' }
  s.source = { :git => 'https://github.com/itrcz/calab' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Either native audio flag links the one pinned SDK; the room cues come from the withCallAudio plugin.
  room_audio = ENV['CALAB_IOS_NATIVE_ROOM_AUDIO'] == '1'
  native_audio = ENV['CALAB_IOS_NATIVE_CALL_AUDIO'] == '1' || room_audio
  s.dependency 'CalabLiveKit', '= 2.17.0' if native_audio
  s.source_files = '*.swift'
  s.resources = ['*.lproj/*.strings'] + (native_audio ? ['*.LICENSE'] : []) + (room_audio ? ['RoomSounds/*'] : [])
  s.frameworks = 'ActivityKit', 'UserNotifications', 'PushKit', 'CallKit', 'AVFAudio', 'Intents', 'ImageIO', 'WidgetKit', 'Security', 'CryptoKit'
end
