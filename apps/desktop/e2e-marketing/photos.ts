import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PersonKey } from './copy';

/**
 * Real photos of the landing team (the one place that maps people to pictures). Each person has a
 * 256×256 square face crop for the avatar; the people on camera in the scenes also have a 1280×720
 * webcam-style frame, and their avatar is cropped from that same frame so both match.
 *
 * Sources (crop = left, top, size in source px):
 * - anna    — 02-home-woman.png (owner's webcam frames, 1672×941): camera + avatar [478, 10, 680]
 * - boris   — 01-office-man.png: camera + avatar [508, 42, 627]
 * - grigory — 04-developer-man.png (glasses, headset): camera + avatar [512, 52, 627]
 * - dina    — 05-senior-woman.png: avatar only [523, 0, 627]
 * - vera    — apps/landing/public/editorial/team-conversation.webp (the woman, 1536×1024): avatar only [150, 90, 500]
 * Cameras: the frame resized (cover) to 1280×720, JPEG q78; avatars: JPEG q86.
 */
const DIR = resolve(import.meta.dirname, 'photos');

export const CAMERA_PEOPLE = ['anna', 'boris', 'grigory'] as const;
export type CameraPerson = (typeof CAMERA_PEOPLE)[number];

const read = (name: string): Buffer => readFileSync(resolve(DIR, name));

/** The person's 256×256 JPEG avatar. */
export const avatarPhoto = (k: PersonKey): Buffer => read(`${k}-avatar.jpg`);

/** The person's 1280×720 JPEG camera frame. */
export const cameraPhoto = (k: CameraPerson): Buffer => read(`${k}-camera.jpg`);

/** A data: URL with the picture's real type (JPEG or PNG). */
export const dataUrl = (b: Buffer): string => `data:${b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png'};base64,${b.toString('base64')}`;
