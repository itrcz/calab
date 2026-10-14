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
  s.dependency 'CalabLiveKit', '= 2.17.0' if ENV['CALAB_IOS_NATIVE_CALL_AUDIO'] == '1'
  s.source_files = '*.swift'
  s.resources = ['*.lproj/*.strings'] + (ENV['CALAB_IOS_NATIVE_CALL_AUDIO'] == '1' ? ['*.LICENSE'] : [])
  s.frameworks = 'ActivityKit', 'UserNotifications', 'PushKit', 'CallKit', 'AVFAudio', 'Intents', 'ImageIO'
end
