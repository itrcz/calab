/** English UI strings — musician mode (ADR-0052, docs/02, docs/08). Same keys as ru/music.ts. */
export const enMusic = {
  'music.mode': 'Musician mode',
  'music.hint': 'Live sound of instruments and voice: no echo or noise suppression, no auto gain, high quality, the mic stays on in pauses. Headphones only.',
  'music.warnHeadphones': 'Headphones needed: without echo cancellation others will hear themselves.',
  'music.warnSpeakers': 'Sound goes to speakers ({device}). Without echo cancellation others will hear themselves — put on headphones.',
  'music.echoRisk': 'Others can hear themselves: musician mode has no echo cancellation. Put on headphones or turn the mode off',
  'music.turnOff': 'Turn off musician mode',
  'music.off': 'Turn off',
  'music.badge': 'Musician',
  'music.badgeHint': 'Musician mode: unprocessed sound',
  'music.rnnoiseOff': 'Off in musician mode',
  'music.audioOnly': 'Musician mode isn’t available on iPhone yet',
  'music.aecNote': 'Musician mode: echo cancellation, noise suppression and auto gain are off.',
  'music.stats': 'musician',
} as const;
