# Official prebuilt distribution, checksum from the 2.17.0 Swift Package manifest.
# The source CocoaPod does not separate its new nanopb C module from Swift.
Pod::Spec.new do |s|
  s.name = 'CalabLiveKit'
  s.version = '2.17.0'
  s.summary = 'Official LiveKit Swift binary distribution for the optional phone call driver'
  s.homepage = 'https://github.com/livekit/client-sdk-swift'
  s.author = 'LiveKit'
  s.license = { :type => 'Apache-2.0', :text => File.read(File.join(__dir__, 'ios', 'LiveKit.LICENSE')) }
  s.source = {
    :http => 'https://github.com/livekit/client-sdk-swift-xcframework/releases/download/2.17.0/LiveKit.xcframework.zip',
    :sha256 => '7f175c55ddd6e2931f92c7ce0fc342e3ccd956bfc1061d3b9d17f8546e5222ba'
  }
  s.platforms = { :ios => '16.4' }
  s.vendored_frameworks = 'LiveKit.xcframework'
  s.dependency 'LiveKitWebRTC', '= 150.7871.02'
  s.dependency 'LiveKitUniFFI', '= 0.1.9'
end
