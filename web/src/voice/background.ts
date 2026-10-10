// SPDX-License-Identifier: Apache-2.0
/**
 * Camera background blur or replacement with LiveKit's `@livekit/track-processors` (MediaPipe selfie
 * segmentation on the GPU). The MediaPipe runtime and models are served by the node itself
 * (`/mediapipe/…`, see vite.config.ts), never from a CDN. Loaded only when an effect is switched on.
 *
 * Settings (design note 4.11): the blur strength (0–100 %, mapped to the processor's blur radius, changed live)
 * and a quality level: `fast` uses MediaPipe's lighter landscape model (144×256), `balanced` the general
 * model (256×256) with temporal smoothing of the mask, `high` the general model with stronger smoothing and
 * an extra feather of the mask edge. The smoothing runs as one small WebGL pass on the segmenter's own
 * context between the model and the processor's compositing (the processor exposes no option for it).
 * Replacement images are pre-scaled to the camera's capture size. In-browser segmentation stays approximate
 * with busy backgrounds and in low light; the settings say so.
 *
 * A slow-frame detector turns the effect off on machines that cannot keep up (design note 4.9).
 */
import { BackgroundTransformer, ProcessorWrapper, supportsBackgroundProcessors } from "@livekit/track-processors";
import type { LocalVideoTrack } from "livekit-client";
import type { BackgroundQuality, VoiceSettings } from "./settings";
import { SlowFrameDetector, type SlowFrames } from "./frames";

const MODELS = { general: "/mediapipe/selfie_segmenter.tflite", landscape: "/mediapipe/selfie_segmenter_landscape.tflite" };

interface QualityPlan {
  model: string;
  /** Weight of the newest mask (1 = no temporal smoothing). */
  alpha: number;
  /** Feather radius of the mask edge in mask pixels (0 = none). */
  feather: number;
}

export const QUALITY: Record<BackgroundQuality, QualityPlan> = {
  fast: { model: MODELS.landscape, alpha: 1, feather: 0 },
  balanced: { model: MODELS.general, alpha: 0.55, feather: 1 },
  high: { model: MODELS.general, alpha: 0.4, feather: 2 },
};

/**
 * The processor's blur radius for a strength of 0–100 %. The processor blurs a quarter-size copy of the
 * frame with radius/4 (at most 16 samples), so 2–64 covers its whole range.
 */
export function blurRadius(strength: number): number {
  const s = Math.max(0, Math.min(100, strength));
  return Math.round(2 + (62 * s) / 100);
}

export function backgroundSupported(): boolean {
  try {
    return supportsBackgroundProcessors();
  } catch {
    return false;
  }
}

/** Scales and crops an image (URL) to cover `width`×`height`; returns a JPEG data URL. */
export async function coverImage(url: string, width: number, height: number): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", 0.88);
}

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D current;
uniform sampler2D previous;
uniform float alpha;
uniform float feather;
uniform vec2 texel;
out vec4 color;
void main() {
  float c = texture(current, uv).r;
  if (feather > 0.0) {
    float sum = 0.0;
    for (int dx = -1; dx <= 1; dx++)
      for (int dy = -1; dy <= 1; dy++) sum += texture(current, uv + vec2(float(dx), float(dy)) * texel * feather).r;
    c = sum / 9.0;
  }
  float m = alpha >= 1.0 ? c : mix(texture(previous, uv).r, c, alpha);
  color = vec4(m, m, m, 1.0);
}`;

/**
 * Temporal smoothing and feathering of the segmentation mask on the segmenter's WebGL2 context: blends the
 * new mask with the previous result (ping-pong textures). Restores the state the processor relies on
 * (framebuffer, vertex array, active texture unit).
 */
class MaskSmoother {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private textures: WebGLTexture[] = [];
  private framebuffers: WebGLFramebuffer[] = [];
  private size = [0, 0];
  private index = 0;
  private fresh = true;
  private u: Record<"current" | "previous" | "alpha" | "feather" | "texel", WebGLUniformLocation | null>;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly plan: QualityPlan,
  ) {
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`mask shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`mask program: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    this.vao = gl.createVertexArray()!;
    this.u = {
      current: gl.getUniformLocation(program, "current"),
      previous: gl.getUniformLocation(program, "previous"),
      alpha: gl.getUniformLocation(program, "alpha"),
      feather: gl.getUniformLocation(program, "feather"),
      texel: gl.getUniformLocation(program, "texel"),
    };
  }

  private ensure(width: number, height: number) {
    if (this.size[0] === width && this.size[1] === height) return;
    const gl = this.gl;
    this.release();
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.textures.push(tex);
      this.framebuffers.push(fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.size = [width, height];
    this.fresh = true;
  }

  /** Smooths `mask` (a texture of `width`×`height`) and returns the result texture. */
  apply(mask: WebGLTexture, width: number, height: number): WebGLTexture {
    const gl = this.gl;
    this.ensure(width, height);
    const write = this.index;
    const read = 1 - write;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[write]!);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mask);
    gl.uniform1i(this.u.current, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[read]!);
    gl.uniform1i(this.u.previous, 1);
    gl.uniform1f(this.u.alpha, this.fresh ? 1 : this.plan.alpha);
    gl.uniform1f(this.u.feather, this.plan.feather);
    gl.uniform2f(this.u.texel, 1 / width, 1 / height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!);
    gl.activeTexture(gl.TEXTURE0);
    this.fresh = false;
    this.index = read;
    return this.textures[write]!;
  }

  private release() {
    this.textures.forEach((t) => this.gl.deleteTexture(t));
    this.framebuffers.forEach((f) => this.gl.deleteFramebuffer(f));
    this.textures = [];
    this.framebuffers = [];
  }

  destroy() {
    this.release();
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}

interface MaskLike {
  width: number;
  height: number;
  getAsWebGLTexture(): WebGLTexture;
}

/** The parts of the processor's transformer the smoothing hooks into (private in its types). */
interface TransformerInternals {
  canvas?: OffscreenCanvas | HTMLCanvasElement;
  gl?: { updateMask(texture: WebGLTexture): void };
  updateMask(mask: MaskLike | undefined): Promise<void>;
  destroy(...args: unknown[]): Promise<void>;
}

/** Runs the mask through a {@link MaskSmoother} before the processor composites the frame. */
function smoothMasks(transformer: BackgroundTransformer, plan: QualityPlan): void {
  if (plan.alpha >= 1 && plan.feather === 0) return;
  const t = transformer as unknown as TransformerInternals;
  const original = t.updateMask.bind(t);
  let smoother: MaskSmoother | null = null;
  let failed = false;
  t.updateMask = async (mask) => {
    if (!mask || failed || !t.gl || !t.canvas) return original(mask);
    try {
      const gl = t.canvas.getContext("webgl2") as WebGL2RenderingContext | null;
      if (!gl) throw new Error("no WebGL2");
      smoother ??= new MaskSmoother(gl, plan);
      t.gl.updateMask(smoother.apply(mask.getAsWebGLTexture(), mask.width, mask.height));
    } catch (e) {
      // Never break the camera for the smoothing: fall back to the processor's own mask.
      console.warn("voice: mask smoothing off", e);
      failed = true;
      return original(mask);
    }
  };
  const destroy = t.destroy.bind(t);
  t.destroy = async (...args) => {
    smoother?.destroy();
    smoother = null;
    return destroy(...args);
  };
}

interface SegmenterLike {
  segmentForVideo(...args: unknown[]): void;
  close(): void;
}

const closedSegmenter: SegmenterLike = {
  segmentForVideo: () => {
    throw new Error("background segmenter closed");
  },
  close: () => undefined,
};

/**
 * Takes the segmenter away from the transformer as soon as it is destroyed. The processor's first frame waits for its
 * render before it segments; a frame resuming after the destroy would call MediaPipe's closed graph, which never
 * returns (it spins in the WebAssembly module and freezes the page: no input, no navigation). With the guard such a
 * frame fails fast instead (the processor logs it and drops the frame), and a second destroy closes nothing twice.
 */
export function guardSegmenter(transformer: BackgroundTransformer): void {
  const t = transformer as unknown as { imageSegmenter?: SegmenterLike; destroy(...args: unknown[]): Promise<void> };
  const destroy = t.destroy.bind(t);
  t.destroy = async (...args) => {
    const segmenter = t.imageSegmenter;
    // From here on no frame reaches the real segmenter; the destroy still closes it, once.
    t.imageSegmenter = segmenter && segmenter !== closedSegmenter ? { segmentForVideo: closedSegmenter.segmentForVideo, close: () => segmenter.close() } : closedSegmenter;
    try {
      return await destroy(...args);
    } finally {
      // A restart (`init` after the destroy) assigns a new segmenter.
      t.imageSegmenter = closedSegmenter;
    }
  };
}

export interface BackgroundHandle {
  stop: () => Promise<void>;
  /** Changes the blur strength live (blur mode). */
  setBlur: (strength: number) => Promise<void>;
}

/** Applies the configured effect to the camera track; `onSlow` fires once if frames take too long. */
export async function applyBackground(track: LocalVideoTrack, settings: VoiceSettings, onSlow: (slow: SlowFrames) => void): Promise<BackgroundHandle> {
  if (!backgroundSupported()) throw new Error("background effects are not supported in this browser");
  const capture = track.mediaStreamTrack.getSettings();
  const fps = capture.frameRate ?? settings.cameraFps;
  const detector = new SlowFrameDetector(fps);
  // A hidden tab gets fewer frames and GPU time: those samples say nothing about the device.
  const onVisibility = () => detector.reset(performance.now());
  document.addEventListener("visibilitychange", onVisibility);
  let fired = false;
  const onFrameProcessed = (stats: { processingTimeMs: number }) => {
    if (fired || document.visibilityState === "hidden") return;
    const slow = detector.push(stats.processingTimeMs, performance.now());
    if (slow) {
      fired = true;
      onSlow(slow);
    }
  };
  const plan = QUALITY[settings.backgroundQuality] ?? QUALITY.balanced;
  let imagePath: string | undefined;
  if (settings.background === "image" && settings.backgroundImage) {
    const width = capture.width ?? 1280;
    const height = capture.height ?? 720;
    imagePath = await coverImage(settings.backgroundImage, width, height).catch(() => settings.backgroundImage!);
  }
  const transformer = new BackgroundTransformer({
    ...(imagePath ? { imagePath } : { blurRadius: blurRadius(settings.blurStrength) }),
    segmenterOptions: { delegate: "GPU" },
    assetPaths: { tasksVisionFileSet: "/mediapipe", modelAssetPath: plan.model },
    onFrameProcessed,
  });
  smoothMasks(transformer, plan);
  guardSegmenter(transformer);
  const processor = new ProcessorWrapper(transformer, "background-processor");
  await track.setProcessor(processor);
  return {
    stop: async () => {
      document.removeEventListener("visibilitychange", onVisibility);
      await track.stopProcessor();
    },
    setBlur: async (strength) => {
      if (!imagePath) await processor.updateTransformerOptions({ blurRadius: blurRadius(strength) });
    },
  };
}
