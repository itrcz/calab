/**
 * Charset resolution for mail text (bodies and snippets).
 *
 * Bank and legacy gateways send single-byte cyrillic mail either unlabelled or mislabelled as
 * utf-8; a naive utf-8 decode turns every high byte into U+FFFD ("���") while ascii survives.
 * We pick the encoding by sniffing the bytes: trust a valid label unless the bytes say
 * otherwise (valid utf-8 behind a single-byte cyrillic label, or a dirty decode), otherwise
 * score the two common single-byte cyrillic encodings against each other.
 */
import { Transform } from 'node:stream';

const REPLACEMENT = '�';
/** The frequent letters of running Russian text (о, е, а, и, н, т, с, р, в); case-insensitive. */
const FREQ = 'оаеинтсрв';
/** Box drawing / block elements (koi8-r's control area), C1 controls, replacement chars — never real text. */
const GARBAGE = /[\u2500-\u25FF\u0080-\u009F\uFFFD]/;
/** Cyrillic block incl. Ё/ё. */
const CYRILLIC = /[Ѐ-ӿ]/;
/** Share of cyrillic above which utf-8 bytes behind a cyrillic label are considered utf-8. */
const CYR_THRESHOLD = 0.3;

/** Canonical TextDecoder encodings that are single-byte cyrillic (labels are normalized by TextDecoder). */
const SINGLE_BYTE_CYR = new Set(['windows-1251', 'koi8-r', 'iso-8859-5', 'ibm866', 'x-mac-cyrillic']);

function safeDecoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function cyrShare(text: string): number {
  let cyr = 0;
  for (const ch of text) if (CYRILLIC.test(ch)) cyr++;
  return text.length ? cyr / text.length : 0;
}

/** Decode both single-byte cyrillic candidates; keep the one that reads like Russian (tie → windows-1251). */
function scoreCyrillic(bytes: Uint8Array): string {
  let best = 'windows-1251';
  let bestScore = -Infinity;
  for (const enc of ['windows-1251', 'koi8-r']) {
    const text = new TextDecoder(enc).decode(bytes);
    let score = 0;
    for (const ch of text) {
      if (FREQ.includes(ch) || FREQ.includes(ch.toLowerCase())) score += 1;
      else if (GARBAGE.test(ch)) score -= 4;
    }
    // strict > keeps windows-1251 on a tie — the more common of the two in the wild
    if (score > bestScore) {
      bestScore = score;
      best = enc;
    }
  }
  return best;
}

/**
 * The encoding to decode `bytes` with. `declared` is the label from the MIME part, if any.
 * Fast path for honest utf-8/ascii mail is one decode plus a U+FFFD scan.
 */
export function sniffCharset(bytes: Uint8Array, declared?: string): string {
  const label = (declared ?? '').trim();
  const dec = label ? safeDecoder(label) : null;
  if (dec) {
    const text = dec.decode(bytes);
    if (!text.includes(REPLACEMENT)) {
      // A valid, clean label. One exception: valid utf-8 bytes behind a single-byte cyrillic
      // label (the "РџСЂРёРІРµС‚" pattern) decode cleanly both ways — prefer utf-8 when the
      // utf-8 reading is mostly cyrillic.
      if (SINGLE_BYTE_CYR.has(dec.encoding) && isUtf8(bytes)) {
        const asUtf8 = new TextDecoder('utf-8').decode(bytes);
        if (cyrShare(asUtf8) >= CYR_THRESHOLD) return 'utf-8';
      }
      return dec.encoding;
    }
  }
  // No usable label (missing, unknown, or it produces U+FFFD): are the bytes utf-8 at all?
  if (isUtf8(bytes)) return 'utf-8';
  return scoreCyrillic(bytes);
}

/** The smallest byte count SniffingIconv buffers before it locks the encoding decision. */
const SNIFF_MIN = 16;

/**
 * node-iconv-compatible Transform for mailparser's `Iconv` option (mailparser does
 * `new Iconv(fromCharset, 'UTF-8//TRANSLIT//IGNORE')` and pumps raw part bytes through
 * write()/end(), reading UTF-8 chunks back). The encoding is chosen by sniffCharset from the
 * first ≥ SNIFF_MIN bytes and stays locked for the whole stream; smaller parts are buffered
 * until the decision can be made (or the stream ends).
 */
export class SniffingIconv extends Transform {
  private readonly declared: string;
  private decoder: TextDecoder | null = null;
  /** Locked to utf-8: the bytes are already utf-8, forward them without a re-encode. */
  private passthrough = false;
  private pending: Buffer[] = [];
  private pendingLen = 0;

  constructor(fromCharset: string, _toCharset?: string) {
    super();
    // The '//TRANSLIT//IGNORE' suffix is node-iconv syntax on the target; output here is plain UTF-8.
    this.declared = (fromCharset ?? '').trim();
  }

  // Node's Transform types the callback as Error | null; a wrapper keeps the override signature tight.
  override _transform(chunk: Buffer | string, _encoding: string, done: (error?: Error | null) => void): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    if (this.decoder || this.passthrough) {
      this.pushDecoded(buf);
      return done();
    }
    this.pending.push(buf);
    this.pendingLen += buf.length;
    if (this.pendingLen >= SNIFF_MIN) this.lock();
    done();
  }

  override _flush(done: (error?: Error | null) => void): void {
    if (!this.decoder && !this.passthrough) this.lock();
    done();
  }

  private lock(): void {
    const single = this.pending.length === 1 ? this.pending[0] : undefined;
    const bytes = single ?? Buffer.concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    const choice = sniffCharset(bytes, this.declared);
    if (choice === 'utf-8') {
      this.passthrough = true;
      if (bytes.length) this.push(bytes);
      return;
    }
    this.decoder = new TextDecoder(choice);
    this.pushDecoded(bytes);
  }

  // NB: deliberately not named `emit` — Transform inherits it from EventEmitter.
  private pushDecoded(buf: Buffer): void {
    if (this.passthrough) {
      if (buf.length) this.push(buf);
      return;
    }
    const text = this.decoder!.decode(buf, { stream: true });
    if (text) this.push(Buffer.from(text, 'utf8'));
  }
}
