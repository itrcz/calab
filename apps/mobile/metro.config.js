// Expo's default config already resolves the pnpm workspace. One addition: the hoisted workspace
// root holds React 19.3 (desktop, landing), but react-native 0.86 ships its renderer for exactly
// React 19.2.3, installed in apps/mobile/node_modules. Every `react` / `react-dom` import in the
// bundle — react-native's own, from the root, included — is pinned to that copy.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const pinned = ['react', 'react-dom'].map((name) => [
  name,
  path.dirname(require.resolve(`${name}/package.json`, { paths: [__dirname] })),
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const [name, dir] of pinned) {
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      return context.resolveRequest(context, dir + moduleName.slice(name.length), platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
