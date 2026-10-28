import type { ExpoConfig } from 'expo/config';
import { parseWebOrigin, parseLinkHosts, parseReleaseIdentity } from './src/config';

/**
 * Phone host (ADR-0067). Hosts, identifiers and the EAS link come from env only — a local,
 * git-ignored `.env` (see .env.example) or the build environment; nothing deployment-specific is
 * committed. A malformed web origin fails here, before any native build starts. A missing one
 * cannot: `expo export` reads this file once before it loads `.env`; the app then shows a
 * configuration error instead of loading anything.
 */
const webOrigin = process.env.EXPO_PUBLIC_CALAB_URL !== undefined ? parseWebOrigin(process.env.EXPO_PUBLIC_CALAB_URL) : null;

/**
 * Links that open the app (ADR-0140): the product scheme (like desktop `PROTOCOLS`, main/deeplink.ts;
 * `calaba` is the alias from before the rename) and https links of the web hosts —
 * `EXPO_PUBLIC_CALAB_LINK_HOSTS`, else the host of the web origin. The hosts serve
 * `/.well-known/apple-app-site-association` and `assetlinks.json` (Caddy, from env); only the
 * routes App.tsx accepts are claimed, everything else on those hosts stays in the browser.
 */
const SCHEME = 'calab';
const LEGACY_SCHEME = 'calaba';
const LINK_PATHS = ['/t/', '/join/', '/r/'];
const linkHosts = parseLinkHosts(process.env.EXPO_PUBLIC_CALAB_LINK_HOSTS, webOrigin);

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const iosBundleId = env('CALAB_IOS_BUNDLE_ID');
const androidPackage = env('CALAB_ANDROID_APPLICATION_ID');
const pushEnvironment = env('CALAB_IOS_PUSH_ENVIRONMENT');
if (pushEnvironment && !['development', 'production'].includes(pushEnvironment)) throw new Error('CALAB_IOS_PUSH_ENVIRONMENT must be development or production');
const incomingCalls = env('CALAB_IOS_INCOMING_CALLS') === '1';
if (incomingCalls && !pushEnvironment) throw new Error('CALAB_IOS_INCOMING_CALLS requires CALAB_IOS_PUSH_ENVIRONMENT');
const nativeCallAudio = env('CALAB_IOS_NATIVE_CALL_AUDIO') === '1';
if (nativeCallAudio && !incomingCalls) throw new Error('CALAB_IOS_NATIVE_CALL_AUDIO requires incoming calls');
const owner = env('CALAB_EXPO_OWNER');
const projectId = env('CALAB_EAS_PROJECT_ID');

const identity = parseReleaseIdentity(process.env.CALAB_APP_VERSION, process.env.CALAB_IOS_BUILD_NUMBER);

const config: ExpoConfig = {
  name: 'Calab',
  slug: 'calab',
  scheme: [SCHEME, LEGACY_SCHEME],
  ...(owner ? { owner } : {}),
  version: identity.version,
  platforms: ['ios', 'android'],
  orientation: 'portrait',
  // Existing Calab mark, full-bleed RGB at store resolution; iOS applies its own corner mask.
  icon: './assets/icon-1024.png',
  backgroundColor: '#1c1c1e',
  userInterfaceStyle: 'automatic',
  ios: {
    buildNumber: identity.buildNumber,
    supportsTablet: false,
    ...(iosBundleId ? { bundleIdentifier: iosBundleId } : {}),
    ...(linkHosts.length ? { associatedDomains: linkHosts.map((host) => `applinks:${host}`) } : {}),
    // Explicit opt-in only; requires a matching APNs-capable profile. Default local builds request no APS grant.
    ...(pushEnvironment ? { entitlements: { 'aps-environment': pushEnvironment } } : {}),
    infoPlist: {
      ...(pushEnvironment ? { CalabMessagePushEnvironment: pushEnvironment } : {}),
      ...(incomingCalls ? { CalabIncomingCallsEnabled: true } : {}),
      ...(nativeCallAudio ? { CalabCallAudioEnabled: true } : {}),
      // WKWebView terminates the app if the page asks for these without a usage string.
      NSMicrophoneUsageDescription: 'Calab uses the microphone when you join a voice room or a call.',
      NSCameraUsageDescription: 'Calab uses the camera for video in calls and to take photos for messages.',
      // «Save Image» on the share sheet of a downloaded file (ADR-0068) terminates the app without it.
      NSPhotoLibraryAddUsageDescription: 'Calab saves images you download from chats to your photo library.',
      // An ongoing voice room or call keeps playing and capturing when the app leaves the
      // foreground: WKWebView mutes the microphone of an app without `audio` here (WebKit bug
      // 226620). Calls opt-in adds PushKit/CallKit; no early AVAudioSession or keepalive sound.
      UIBackgroundModes: incomingCalls ? ['audio', 'voip'] : ['audio'],
    },
  },
  android: {
    ...(androidPackage ? { package: androidPackage } : {}),
    // The WebView grants getUserMedia only for permissions the app declares.
    permissions: ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'CAMERA'],
    intentFilters: [
      ...(linkHosts.length ? [{
        action: 'VIEW',
        // Verified against each host's assetlinks.json at install; unverified, Android shows a chooser.
        autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: linkHosts.flatMap((host) => LINK_PATHS.map((pathPrefix) => ({ scheme: 'https', host, pathPrefix }))),
      }] : []),
      // The plain `calab://` / `calaba://` filter (no verification) comes from `scheme` above.
    ],
  },
  plugins: [
    './plugins/withSessionActivity',
    './plugins/withCallAudio',
    './plugins/withCommunicationNotifications',
    // iOS 27 SDK apps without the UIKit scene lifecycle trap at launch. Expo's supported SDK 57
    // opt-in: a scene manifest plus ExpoAppSceneDelegate, which owns the window and starts React.
    ['expo-build-properties', { ios: { enableSceneSupport: true } }],
  ],
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
};

export default config;
