import { BLUR_DOWNSCALE, BLUR_MAX_RADIUS, MASK_MIN_COVERAGE, SEG_MODELS, coverUv, gaussianKernel, type SegModelSpec } from './logic';

/**
 * The GPU half of the camera background (ADR-0035 §2), WebGL2 on the worker's OffscreenCanvas —
 * the same context MediaPipe's GPU delegate runs in, so the mask never leaves the GPU.
 *
 * Per segmentation (SEG_FPS, 15/s): the MediaPipe mask at the model's size (256×256 multiclass —
 * inverted, its mask 0 is the background — or 256×144 landscape) → `raw` (+ mipmaps: its 1×1 level
 * is the person's share of the frame) → temporal EMA into `ema` (a nearly empty mask keeps the
 * previous one while the hold is allowed — decided per pixel from the 1×1 level, no readback).
 * Per camera frame: joint bilateral smoothing of the mask at ¼ size guided by the frame's luma
 * (edges follow the picture, less halo) → for blur: separable Gaussian at ¼ size, H straight from the
 * frame with the background premultiplied by (1 − mask) so the person does not bleed into it, then
 * V → composite at full size: mix(background, camera, smoothstep(edge, mask)). 2 passes for a picture,
 * 4 for blur (docs/14 «Фон камеры»: render passes are what the GPU process pays for).
 *
 * Appearance effects (effects.ts), with or without a background: touch-up = a bilateral of the frame
 * at ¼ size + a skin-tone, contrast-guarded blend in the last pass; low light = a curve and a light
 * denoise in the last pass (no pass of its own).
 *
 * Every texture keeps the picture's top row first (uploads without FLIP_Y); only the last pass,
 * into the canvas, flips. GL state is set completely before each pass: MediaPipe shares the context.
 */

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
`;

/** MediaPipe confidence mask (float, not filterable) → our RGBA8 texture of the same size. */
const FS_MASK_IN = `${HEAD}
uniform highp sampler2D u_src;
uniform bool u_flip;
uniform bool u_invert;
void main() {
  ivec2 sz = textureSize(u_src, 0);
  vec2 uv = u_flip ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  ivec2 p = clamp(ivec2(uv * vec2(sz)), ivec2(0), sz - ivec2(1));
  float c = clamp(texelFetch(u_src, p, 0).r, 0.0, 1.0);
  o = vec4(u_invert ? 1.0 - c : c, 0.0, 0.0, 1.0);
}`;

/** Temporal EMA; a nearly empty new mask keeps the previous one while `u_hold` (ADR §6). */
const FS_EMA = `${HEAD}
uniform sampler2D u_raw;
uniform sampler2D u_prev;
uniform float u_alpha;
uniform bool u_hold;
uniform float u_top;
uniform float u_min;
void main() {
  float raw = textureLod(u_raw, v_uv, 0.0).r;
  float prev = texture(u_prev, v_uv).r;
  float coverage = textureLod(u_raw, vec2(0.5), u_top).r;
  float m = (u_hold && coverage < u_min) ? prev : mix(prev, raw, u_alpha);
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

/**
 * Joint bilateral 5×5 at ¼ size: mask taps weighted by distance and by the camera picture's luma
 * difference (read straight from the full frame, one bilinear tap each), so the edge follows it.
 */
const FS_REFINE = `${HEAD}
uniform sampler2D u_mask;
uniform sampler2D u_frame;
uniform vec2 u_step;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  float lc = dot(texture(u_frame, v_uv).rgb, LUMA);
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 uv = v_uv + vec2(float(x), float(y)) * u_step;
      float dl = dot(texture(u_frame, uv).rgb, LUMA) - lc;
      float w = exp(-float(x * x + y * y) / 8.0 - dl * dl / 0.04);
      sum += w * texture(u_mask, uv).r;
      wsum += w;
    }
  }
  o = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

/**
 * Horizontal Gaussian at ¼ size straight from the full frame, background only: each tap is the
 * frame (two bilinear taps one texel apart = a 2×4 box) premultiplied by its weight (1 − mask), so
 * the person does not bleed into the blur.
 */
const FS_BLUR_H = `${HEAD}
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform vec2 u_dir;
uniform vec2 u_texel;
uniform float u_w[${BLUR_MAX_RADIUS + 1}];
uniform int u_r;
vec4 bgAt(vec2 uv) {
  float b = 1.0 - texture(u_mask, uv).r;
  vec3 c = 0.5 * (texture(u_frame, uv - vec2(0.0, u_texel.y)).rgb + texture(u_frame, uv + vec2(0.0, u_texel.y)).rgb);
  return vec4(c * b, b);
}
void main() {
  vec4 c = bgAt(v_uv) * u_w[0];
  for (int i = 1; i <= ${BLUR_MAX_RADIUS}; i++) {
    if (i > u_r) break;
    vec2 d = u_dir * float(i);
    c += (bgAt(v_uv + d) + bgAt(v_uv - d)) * u_w[i];
  }
  o = c;
}`;

/** Vertical Gaussian at ¼ size over the premultiplied background. */
const FS_BLUR = `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_w[${BLUR_MAX_RADIUS + 1}];
uniform int u_r;
void main() {
  vec4 c = texture(u_src, v_uv) * u_w[0];
  for (int i = 1; i <= ${BLUR_MAX_RADIUS}; i++) {
    if (i > u_r) break;
    vec2 d = u_dir * float(i);
    c += (texture(u_src, v_uv + d) + texture(u_src, v_uv - d)) * u_w[i];
  }
  o = c;
}`;

/**
 * «Улучшить внешность» (effects.ts): an edge-preserving 5×5 bilateral of the frame at ¼ size, straight
 * from the full frame — every tap is a bilinear 2×2 box (taps sit on texel corners, `u_step` apart),
 * weighted by distance and by luma difference to the centre, so eyes, brows and hair do not smear.
 */
const FS_SMOOTH = `${HEAD}
uniform sampler2D u_frame;
uniform vec2 u_texel;
uniform float u_step;
uniform float u_range;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  float lc = dot(texture(u_frame, v_uv).rgb, LUMA);
  float k = 0.5 / (u_range * u_range);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec3 c = texture(u_frame, v_uv + vec2(float(x), float(y)) * u_step * u_texel).rgb;
      float dl = dot(c, LUMA) - lc;
      float w = exp(-float(x * x + y * y) / 4.5 - dl * dl * k);
      sum += c * w;
      wsum += w;
    }
  }
  o = vec4(sum / wsum, 1.0);
}`;

/**
 * Into the canvas (flipped). Per pixel, uniform-switched (no extra passes): low-light denoise →
 * touch-up (the smoothed picture on skin-toned pixels whose local contrast is small; with a
 * background also only on the person) → low-light curve → the camera over the blurred frame or
 * the picture (`u_mode` 0: no background).
 */
const FS_OUT = `${HEAD}
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform sampler2D u_bg;
uniform sampler2D u_smooth;
uniform int u_mode;
uniform vec2 u_bgScale;
uniform vec2 u_bgOffset;
uniform vec2 u_edge;
uniform vec2 u_texel;
uniform float u_touch;
uniform float u_range;
uniform float u_gamma;
uniform float u_denoise;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
/** Skin tones in YCbCr (Chai & Ngan ranges, soft edges), not in deep shadow. */
float skin(vec3 c) {
  float y = dot(c, LUMA);
  float cb = 0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  float cr = 0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
  float a = smoothstep(0.27, 0.31, cb) * (1.0 - smoothstep(0.50, 0.54, cb));
  float b = smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.68, 0.72, cr));
  return a * b * smoothstep(0.06, 0.14, y);
}
/** The low-light curve on luma (keeps colour) blended with a per-channel one (does not clip). */
vec3 lift(vec3 c) {
  float y = max(dot(c, LUMA), 1e-4);
  vec3 byLuma = c * (pow(y, u_gamma) / y);
  return clamp(mix(pow(c, vec3(u_gamma)), byLuma, 0.5), 0.0, 1.0);
}
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec3 fg = texture(u_frame, uv).rgb;
  float raw = u_mode == 0 ? 1.0 : texture(u_mask, uv).r;
  if (u_denoise > 0.0) {
    float lc = dot(fg, LUMA);
    vec3 s = fg;
    float ws = 1.0;
    vec2 d[4] = vec2[4](vec2(1.5, 0.5), vec2(-0.5, 1.5), vec2(-1.5, -0.5), vec2(0.5, -1.5));
    for (int i = 0; i < 4; i++) {
      vec3 n = texture(u_frame, uv + d[i] * u_texel).rgb;
      float dl = dot(n, LUMA) - lc;
      float w = exp(-dl * dl * 200.0);
      s += n * w;
      ws += w;
    }
    fg = mix(fg, s / ws, u_denoise);
  }
  float m = u_mode == 0 ? 1.0 : smoothstep(u_edge.x, u_edge.y, raw);
  if (u_touch > 0.0) {
    vec3 sm = texture(u_smooth, uv).rgb;
    float dl = abs(dot(fg, LUMA) - dot(sm, LUMA));
    float keep = 1.0 - smoothstep(0.5 * u_range, 1.5 * u_range, dl);
    fg = mix(fg, sm, u_touch * skin(sm) * keep * m);
  }
  vec3 cam = u_gamma < 1.0 ? lift(fg) : fg;
  if (u_mode == 0) {
    o = vec4(cam, 1.0);
    return;
  }
  vec3 bg;
  if (u_mode == 1) {
    vec4 b = texture(u_bg, uv);
    bg = mix(fg, b.rgb / max(b.a, 0.001), clamp(b.a * 6.0, 0.0, 1.0));
    if (u_gamma < 1.0) bg = lift(bg);
  } else {
    bg = texture(u_bg, uv * u_bgScale + u_bgOffset).rgb;
  }
  o = vec4(mix(bg, cam, m), 1.0);
}`;

interface Program {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  w: number;
  h: number;
}

export type ComposeMode = { kind: 'blur'; sigma: number } | { kind: 'image' };

/** One frame's work: the background (null = none, no mask needed) and the appearance effects (effects.ts). */
export interface RenderOpts {
  bg: ComposeMode | null;
  /** Touch-up amount 0..1 (0 = off) and its bilateral range (luma). */
  touchUp: number;
  touchRange: number;
  /** Low-light curve exponent (1 = off) and denoise 0..1. */
  gamma: number;
  denoise: number;
}

/** Width of the working mask: the models' input width (256, logic.ts SEG_MODELS). */
const MASK_WIDTH = 256;

/** The model's mask: its edge (smoothstep over the person confidence) and whether it is the background's. */
export type MaskSpec = Pick<SegModelSpec, 'edge' | 'invert'>;

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly progs: Record<'maskIn' | 'ema' | 'refine' | 'blurH' | 'blur' | 'smooth' | 'out', Program>;
  private maskSpec: MaskSpec = SEG_MODELS.landscape;
  private frame: WebGLTexture | null = null;
  private frameW = 0;
  private frameH = 0;
  private refined: Target | null = null;
  private blurA: Target | null = null;
  private blurB: Target | null = null;
  private smooth: Target | null = null;
  private raw: Target | null = null;
  private emaA: Target | null = null;
  private emaB: Target | null = null;
  private rawTop = 0;
  private hasMask = false;
  private image: WebGLTexture | null = null;
  private imageAspect = 16 / 9;
  /** Coverage readback: a pixel-pack buffer and its fence (read one segmentation later, no stall). */
  private readonly pbo: WebGLBuffer;
  private fence: WebGLSync | null = null;
  private readonly px = new Uint8Array(4);
  private coverageFb: WebGLFramebuffer | null = null;
  /** Flip the MediaPipe mask vertically (its texture origin), set once by the worker. */
  flipMask = false;

  constructor(readonly canvas: OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
    this.progs = {
      maskIn: this.program(FS_MASK_IN, ['u_src', 'u_flip', 'u_invert']),
      ema: this.program(FS_EMA, ['u_raw', 'u_prev', 'u_alpha', 'u_hold', 'u_top', 'u_min']),
      refine: this.program(FS_REFINE, ['u_mask', 'u_frame', 'u_step']),
      blurH: this.program(FS_BLUR_H, ['u_frame', 'u_mask', 'u_dir', 'u_texel', 'u_w', 'u_r']),
      blur: this.program(FS_BLUR, ['u_src', 'u_dir', 'u_w', 'u_r']),
      smooth: this.program(FS_SMOOTH, ['u_frame', 'u_texel', 'u_step', 'u_range']),
      out: this.program(FS_OUT, ['u_frame', 'u_mask', 'u_bg', 'u_smooth', 'u_mode', 'u_bgScale', 'u_bgOffset', 'u_edge', 'u_texel', 'u_touch', 'u_range', 'u_gamma', 'u_denoise']),
    };
    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  /** The GL renderer string (ANGLE backend and GPU), for the app log. */
  get renderer(): string {
    const gl = this.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }

  /** SwiftShader / llvmpipe / «Basic Render» = software WebGL (ADR §2). */
  get software(): boolean {
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(this.renderer);
  }

  private program(fs: string, uniforms: string[]): Program {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type);
      if (!s) throw new Error('createShader failed');
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s) ?? ''}`);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p) ?? ''}`);
    return { p, u: Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(p, n)])) };
  }

  /** The segmentation model's mask (set once the segmenter has started). */
  setMaskSpec(spec: MaskSpec): void {
    this.maskSpec = spec;
  }

  private texture(w: number, h: number, mipmaps = false): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mipmaps ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private target(w: number, h: number, mipmaps = false): Target {
    const gl = this.gl;
    const tex = this.texture(w, h, mipmaps);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  private drop(t: Target | null): void {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  /** Canvas and working textures for a camera of `w × h` (a new size reallocates). */
  resize(w: number, h: number): void {
    if (w === this.frameW && h === this.frameH) return;
    const gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;
    this.frameW = w;
    this.frameH = h;
    if (this.frame) gl.deleteTexture(this.frame);
    this.frame = this.texture(w, h);
    for (const t of [this.refined, this.blurA, this.blurB, this.smooth]) this.drop(t);
    this.smooth = null;
    const sw = Math.max(1, Math.ceil(w / BLUR_DOWNSCALE));
    const sh = Math.max(1, Math.ceil(h / BLUR_DOWNSCALE));
    this.refined = this.target(sw, sh);
    this.blurA = this.target(sw, sh);
    this.blurB = this.target(sw, sh);
  }

  /** The camera frame → the frame texture (GPU copy for GPU-backed frames). */
  upload(frame: VideoFrame): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.frameW, this.frameH, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }

  setImage(image: ImageBitmap | null): void {
    const gl = this.gl;
    if (this.image) gl.deleteTexture(this.image);
    this.image = null;
    if (!image) return;
    this.image = this.texture(image.width, image.height);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image.width, image.height, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.imageAspect = image.width / image.height;
  }

  private pass(t: Target | null, prog: Program): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : this.frameW, t ? t.h : this.frameH);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
  }

  private draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  private bind(unit: number, tex: WebGLTexture | null, loc: WebGLUniformLocation | null | undefined): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc ?? null, unit);
  }

  private setup(): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
  }

  /**
   * A new MediaPipe mask (a texture of its context = ours, valid only during its callback):
   * copied, then blended into the running mask. `hold`: a nearly empty mask may keep the old one.
   */
  pushMask(mask: WebGLTexture, mw: number, mh: number, alpha: number, hold: boolean): void {
    const gl = this.gl;
    this.setup();
    // MediaPipe scales its mask up to the input frame: work on the model's own size (256 wide).
    const tw = Math.min(mw, MASK_WIDTH);
    const th = Math.max(1, Math.round((mh * tw) / mw));
    if (!this.raw || this.raw.w !== tw || this.raw.h !== th) {
      for (const t of [this.raw, this.emaA, this.emaB]) this.drop(t);
      if (this.coverageFb) this.gl.deleteFramebuffer(this.coverageFb);
      this.coverageFb = null;
      this.raw = this.target(tw, th, true);
      this.emaA = this.target(tw, th);
      this.emaB = this.target(tw, th);
      this.rawTop = Math.floor(Math.log2(Math.max(tw, th)));
      this.hasMask = false;
    }
    const { maskIn, ema } = this.progs;
    this.pass(this.raw, maskIn);
    this.bind(0, mask, maskIn.u['u_src']);
    gl.uniform1i(maskIn.u['u_flip'] ?? null, this.flipMask ? 1 : 0);
    gl.uniform1i(maskIn.u['u_invert'] ?? null, this.maskSpec.invert ? 1 : 0);
    this.draw();
    gl.bindTexture(gl.TEXTURE_2D, this.raw.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.readCoverageAsync();
    const prev = this.emaA;
    const next = this.emaB;
    if (!prev || !next) return;
    this.pass(next, ema);
    this.bind(0, this.raw.tex, ema.u['u_raw']);
    this.bind(1, prev.tex, ema.u['u_prev']);
    gl.uniform1f(ema.u['u_alpha'] ?? null, this.hasMask ? alpha : 1);
    gl.uniform1i(ema.u['u_hold'] ?? null, hold && this.hasMask ? 1 : 0);
    gl.uniform1f(ema.u['u_top'] ?? null, this.rawTop);
    gl.uniform1f(ema.u['u_min'] ?? null, MASK_MIN_COVERAGE);
    this.draw();
    this.emaA = next;
    this.emaB = prev;
    this.hasMask = true;
  }

  /** A mask is there: a background can be rendered. */
  get ready(): boolean {
    return this.hasMask && !!this.frame;
  }

  /** Starts reading the 1×1 mip level of the last raw mask (the person's share) into the PBO. */
  private readCoverageAsync(): void {
    const gl = this.gl;
    if (!this.raw || this.fence) return;
    if (!this.coverageFb) {
      this.coverageFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.coverageFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.raw.tex, this.rawTop);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.coverageFb);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /** The person's share of the last finished readback, 0..1; null while none is ready. */
  takeCoverage(): number | null {
    const gl = this.gl;
    if (!this.fence) return null;
    const st = gl.clientWaitSync(this.fence, 0, 0);
    if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) return null;
    gl.deleteSync(this.fence);
    this.fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.px);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return (this.px[0] ?? 0) / 255;
  }

  /**
   * Renders the uploaded frame into the canvas. A background needs a mask (`ready`); the
   * appearance effects do not. Passes: touch-up alone 2, low light alone 1; a background adds its
   * own (picture 2, blur 4), touch-up one more at ¼ size, low light none (docs/14: every render
   * pass costs the GPU process CPU time).
   */
  render(opts: RenderOpts): void {
    const gl = this.gl;
    const { refined, blurA, blurB, emaA, frame } = this;
    if (!refined || !blurA || !blurB || !frame) return;
    const bgMode = opts.bg && emaA ? opts.bg : null;
    this.setup();
    const { refine, blurH, blur, smooth, out } = this.progs;

    if (bgMode && emaA) {
      this.pass(refined, refine);
      this.bind(0, emaA.tex, refine.u['u_mask']);
      this.bind(1, frame, refine.u['u_frame']);
      gl.uniform2f(refine.u['u_step'] ?? null, 1 / refined.w, 1 / refined.h);
      this.draw();
    }

    if (opts.touchUp > 0) {
      this.smooth ??= this.target(refined.w, refined.h);
      this.pass(this.smooth, smooth);
      this.bind(0, frame, smooth.u['u_frame']);
      gl.uniform2f(smooth.u['u_texel'] ?? null, 1 / this.frameW, 1 / this.frameH);
      // 2 px apart in 720p: 5 taps of 2×2 cover 10×10 pixels (pores, small blemishes).
      gl.uniform1f(smooth.u['u_step'] ?? null, Math.max(1, (2 * this.frameH) / 720));
      gl.uniform1f(smooth.u['u_range'] ?? null, Math.max(0.01, opts.touchRange));
      this.draw();
    }

    let bg: WebGLTexture | null = this.image;
    if (bgMode?.kind === 'blur') {
      const k = gaussianKernel(bgMode.sigma);
      const w = new Float32Array(BLUR_MAX_RADIUS + 1);
      w.set(k);
      this.pass(blurB, blurH);
      this.bind(0, frame, blurH.u['u_frame']);
      this.bind(1, refined.tex, blurH.u['u_mask']);
      gl.uniform2f(blurH.u['u_dir'] ?? null, 1 / refined.w, 0);
      gl.uniform2f(blurH.u['u_texel'] ?? null, 1 / this.frameW, 1 / this.frameH);
      gl.uniform1fv(blurH.u['u_w'] ?? null, w);
      gl.uniform1i(blurH.u['u_r'] ?? null, k.length - 1);
      this.draw();
      this.pass(blurA, blur);
      this.bind(0, blurB.tex, blur.u['u_src']);
      gl.uniform2f(blur.u['u_dir'] ?? null, 0, 1 / refined.h);
      gl.uniform1fv(blur.u['u_w'] ?? null, w);
      gl.uniform1i(blur.u['u_r'] ?? null, k.length - 1);
      this.draw();
      bg = blurA.tex;
    }

    this.pass(null, out);
    this.bind(0, frame, out.u['u_frame']);
    this.bind(1, refined.tex, out.u['u_mask']);
    this.bind(2, bg ?? frame, out.u['u_bg']);
    this.bind(3, this.smooth?.tex ?? frame, out.u['u_smooth']);
    gl.uniform1i(out.u['u_mode'] ?? null, !bgMode ? 0 : bgMode.kind === 'blur' || !this.image ? 1 : 2);
    const c = coverUv(this.imageAspect, this.frameW / this.frameH);
    gl.uniform2f(out.u['u_bgScale'] ?? null, c.scale[0], c.scale[1]);
    gl.uniform2f(out.u['u_bgOffset'] ?? null, c.offset[0], c.offset[1]);
    gl.uniform2f(out.u['u_edge'] ?? null, this.maskSpec.edge[0], this.maskSpec.edge[1]);
    gl.uniform2f(out.u['u_texel'] ?? null, 1 / this.frameW, 1 / this.frameH);
    gl.uniform1f(out.u['u_touch'] ?? null, opts.touchUp > 0 && this.smooth ? opts.touchUp : 0);
    gl.uniform1f(out.u['u_range'] ?? null, Math.max(0.01, opts.touchRange));
    gl.uniform1f(out.u['u_gamma'] ?? null, opts.gamma);
    gl.uniform1f(out.u['u_denoise'] ?? null, opts.denoise);
    this.draw();
  }

  destroy(): void {
    const gl = this.gl;
    for (const t of [this.refined, this.blurA, this.blurB, this.smooth, this.raw, this.emaA, this.emaB]) this.drop(t);
    if (this.coverageFb) gl.deleteFramebuffer(this.coverageFb);
    if (this.frame) gl.deleteTexture(this.frame);
    if (this.image) gl.deleteTexture(this.image);
    if (this.fence) gl.deleteSync(this.fence);
    gl.deleteBuffer(this.pbo);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
