// Screenshot sizes in CSS px (= the crops of scripts/assets.mjs; the @2x file is twice as large).
// Files: public/screens/<lang>/<name>.webp and <name>@2x.webp, the app and its team in that language.
export const SCREENS = {
  voice: { width: 1440, height: 900 },
  chat: { width: 600, height: 690 },
  call: { width: 1440, height: 870 },
  calendar: { width: 1110, height: 870 },
  findtime: { width: 1110, height: 870 },
  kanban: { width: 1110, height: 600 },
  timeline: { width: 1110, height: 870 },
  task: { width: 510, height: 870 },
  notes: { width: 1370, height: 560 },
  guest: { width: 600, height: 460 },
  sipdial: { width: 1110, height: 300 },
  siproom: { width: 1440, height: 500 },
  sipsettings: { width: 940, height: 660 },
  siplog: { width: 940, height: 660 },
  webapps: { width: 1440, height: 870 },
  boards2: { width: 890, height: 640 },
  checklists: { width: 480, height: 870 },
  boardfeatures: { width: 940, height: 660 },
  boardhook: { width: 940, height: 660 },
  sso: { width: 940, height: 660 },
  ssopolicy: { width: 940, height: 660 },
  consent: { width: 560, height: 480 },
  stickerchat: { width: 1110, height: 870 },
  stickerpicker: { width: 1110, height: 870 },
  voicelist: { width: 340, height: 440 },
} as const;

export type ScreenName = keyof typeof SCREENS;
