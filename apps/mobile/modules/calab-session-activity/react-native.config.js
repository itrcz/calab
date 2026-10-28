// Expo links CalabSessionActivity. The sibling LiveKit pod is added only by withCallAudio.
// React Native's fallback discovery otherwise links that optional pod even when calls are off.
module.exports = { dependency: { platforms: { ios: null, android: null } } };
