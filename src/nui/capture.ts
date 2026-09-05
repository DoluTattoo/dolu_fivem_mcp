/// <reference lib="dom" />
import type { GameCaptureImage, GameCaptureOptions } from "../shared/capture";

let busy = false;
const MAX_VIEWPORT = 16384;
const MAX_OVERLAY_BYTES = 32 * 1024 * 1024;
const PLACEHOLDER = new Uint8Array([
  251, 3, 197, 255, 7, 239, 61, 255, 31, 67, 241, 255, 229, 181, 13, 255,
]);

function dimensions(width: number, height: number, maxWidth: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_VIEWPORT ||
    height > MAX_VIEWPORT
  )
    throw new Error("Invalid game capture viewport dimensions");
  const scale = Math.min(1, maxWidth / width, 2160 / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function validate(options: GameCaptureOptions) {
  if (
    !options ||
    !Number.isInteger(options.maxWidth) ||
    options.maxWidth < 160 ||
    options.maxWidth > 1920 ||
    !["jpeg", "png"].includes(options.format) ||
    !Number.isFinite(options.quality) ||
    options.quality < 0.1 ||
    options.quality > 1 ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 2147483647 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  )
    throw new Error("Invalid game capture options");
}

function overlayDimensions(data: string) {
  if (
    typeof data !== "string" ||
    data.length > Math.ceil(MAX_OVERLAY_BYTES / 3) * 4 ||
    data.length < 44 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    throw new Error("Invalid PNG overlay base64");
  const header = atob(data.slice(0, 44));
  const signature = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  ];
  if (!signature.every((byte, index) => header.charCodeAt(index) === byte))
    throw new Error("Overlay must be a PNG image");
  const size = (offset: number) =>
    header.charCodeAt(offset) * 16777216 +
    header.charCodeAt(offset + 1) * 65536 +
    header.charCodeAt(offset + 2) * 256 +
    header.charCodeAt(offset + 3);
  const width = size(16);
  const height = size(20);
  dimensions(width, height, 1920);
  return { width, height };
}

function compatibleAspect(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
) {
  return (
    Math.abs(width * targetHeight - height * targetWidth) <=
    Math.max(targetWidth, targetHeight)
  );
}

/** A private, detached WebGL target samples FiveM's game-only texture hook. */
export async function captureGame(
  options: GameCaptureOptions,
): Promise<GameCaptureImage> {
  if (busy) throw new Error("Game capture is busy");
  validate(options);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const { width, height } = dimensions(
    viewportWidth,
    viewportHeight,
    options.maxWidth,
  );
  busy = true;
  const cleanups: Array<() => void> = [];
  let operationError: unknown;
  let failed = false;
  let outcome: GameCaptureImage | undefined;
  const cleanupFailures: unknown[] = [];
  const deadline = performance.now() + options.timeoutMs;
  let fail!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // The rejection may precede the first asynchronous stage (context loss).
  void interrupted.catch(() => undefined);
  const timeoutError = () => new Error("Game capture timed out");
  const timer = setTimeout(() => fail(timeoutError()), options.timeoutMs);
  cleanups.push(() => clearTimeout(timer));
  function checkDeadline() {
    if (performance.now() >= deadline) throw timeoutError();
  }
  async function wait<T>(promise: Promise<T>): Promise<T> {
    const result = await Promise.race([promise, interrupted]);
    checkDeadline();
    return result;
  }
  function canvas() {
    const target = document.createElement("canvas");
    cleanups.push(() => {
      target.width = 0;
      target.height = 0;
      target.remove();
    });
    target.hidden = true;
    target.tabIndex = -1;
    target.width = width;
    target.height = height;
    return target;
  }
  async function nextFrame() {
    let frame: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
    };
    try {
      await wait(
        new Promise<void>((resolve) => {
          frame = requestAnimationFrame(() => resolve());
          // Hidden NUI pages can throttle RAF indefinitely.
          fallback = setTimeout(resolve, 100);
        }),
      );
    } finally {
      cancel();
    }
  }
  try {
    const source = canvas();
    const gl = source.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error("Game capture WebGL is unavailable");
    cleanups.push(() => gl.getExtension("WEBGL_lose_context")?.loseContext());
    const contextLost = () =>
      fail(new Error("Game capture WebGL context lost"));
    source.addEventListener("webglcontextlost", contextLost);
    cleanups.push(() =>
      source.removeEventListener("webglcontextlost", contextLost),
    );
    function checkGl() {
      checkDeadline();
      if (gl!.isContextLost())
        throw new Error("Game capture WebGL context lost");
      const error = gl!.getError();
      if (error !== gl!.NO_ERROR)
        throw new Error(`Game capture WebGL error: ${error}`);
    }
    const program = gl.createProgram();
    if (!program) throw new Error("Game capture program allocation failed");
    cleanups.push(() => gl.deleteProgram(program));
    for (const [type, text] of [
      [
        gl.VERTEX_SHADER,
        "attribute vec2 position; varying vec2 uv; void main() { uv = (position + 1.0) * 0.5; gl_Position = vec4(position, 0.0, 1.0); }",
      ],
      [
        gl.FRAGMENT_SHADER,
        "precision mediump float; varying vec2 uv; uniform sampler2D game; void main() { gl_FragColor = texture2D(game, uv); }",
      ],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Game capture shader allocation failed");
      cleanups.push(() => gl.deleteShader(shader));
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(
          `Game capture shader failed: ${gl.getShaderInfoLog(shader)}`,
        );
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(
        `Game capture link failed: ${gl.getProgramInfoLog(program)}`,
      );
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Game capture buffer allocation failed");
    cleanups.push(() => gl.deleteBuffer(buffer));
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    if (position < 0) throw new Error("Game capture shader position missing");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture();
    if (!texture) throw new Error("Game capture texture allocation failed");
    cleanups.push(() => gl.deleteTexture(texture));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      2,
      2,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      PLACEHOLDER,
    );
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    // FiveM CEF recognizes this exact wrap-T sequence as the game texture hook.
    for (const wrap of [
      gl.CLAMP_TO_EDGE,
      gl.MIRRORED_REPEAT,
      gl.REPEAT,
      gl.CLAMP_TO_EDGE,
    ])
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.uniform1i(gl.getUniformLocation(program, "game"), 0);
    gl.viewport(0, 0, width, height);
    checkGl();

    function isPlaceholder() {
      const pixel = new Uint8Array(4);
      for (const [x, y] of [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1],
      ] as const) {
        gl!.readPixels(x, y, 1, 1, gl!.RGBA, gl!.UNSIGNED_BYTE, pixel);
        const u = Math.min(1, Math.max(0, ((x + 0.5) / width) * 2 - 0.5));
        const v = Math.min(1, Math.max(0, ((y + 0.5) / height) * 2 - 0.5));
        for (let channel = 0; channel < 3; channel++) {
          const bottom =
            PLACEHOLDER[channel]! * (1 - u) + PLACEHOLDER[channel + 4]! * u;
          const top =
            PLACEHOLDER[channel + 8]! * (1 - u) +
            PLACEHOLDER[channel + 12]! * u;
          if (Math.abs(pixel[channel]! - (bottom * (1 - v) + top * v)) > 3)
            return false;
        }
      }
      return true;
    }
    function isBlack() {
      const pixel = new Uint8Array(4);
      for (const x of [0.25, 0.5, 0.75]) {
        for (const y of [0.25, 0.5, 0.75]) {
          gl!.readPixels(
            Math.floor(width * x),
            Math.floor(height * y),
            1,
            1,
            gl!.RGBA,
            gl!.UNSIGNED_BYTE,
            pixel,
          );
          if (pixel[0]! + pixel[1]! + pixel[2]! > 12) return false;
        }
      }
      return true;
    }
    await nextFrame();
    let initialized = false;
    let blackAttempts = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      await nextFrame();
      checkGl();
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      initialized = !isPlaceholder();
      checkGl();
      if (initialized) {
        // The hook can briefly expose a black texture before its first game frame.
        // Retry a few frames, but allow a genuinely black scene.
        if (blackAttempts < 3 && isBlack()) {
          blackAttempts++;
          continue;
        }
        break;
      }
    }
    if (!initialized)
      throw new Error("FiveM game texture hook did not initialize");
    const capturedAt = new Date().toISOString();
    const output = canvas();
    const context = output.getContext("2d");
    if (!context) throw new Error("Game capture 2D context is unavailable");
    context.drawImage(source, 0, 0);
    if (options.overlay !== undefined) {
      const overlaySize = overlayDimensions(options.overlay);
      if (
        !compatibleAspect(
          overlaySize.width,
          overlaySize.height,
          viewportWidth,
          viewportHeight,
        ) &&
        !compatibleAspect(overlaySize.width, overlaySize.height, width, height)
      )
        throw new Error(
          "PNG overlay aspect ratio does not match game viewport",
        );
      const image = new Image();
      cleanups.push(() => {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
      });
      await wait(
        new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("PNG overlay decode failed"));
          image.src = `data:image/png;base64,${options.overlay}`;
        }),
      );
      if (
        image.naturalWidth !== overlaySize.width ||
        image.naturalHeight !== overlaySize.height
      )
        throw new Error("PNG overlay decoded dimensions do not match header");
      context.globalCompositeOperation = "source-over";
      context.drawImage(image, 0, 0, width, height);
    }
    checkGl();
    const mimeType = options.format === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await wait(
      new Promise<Blob>((resolve, reject) => {
        output.toBlob(
          (result) => {
            if (result) resolve(result);
            else reject(new Error("Game capture image encoding failed"));
          },
          mimeType,
          options.quality,
        );
      }),
    );
    if (blob.type !== mimeType)
      throw new Error(
        "Game capture encoder returned an unexpected image format",
      );
    if (blob.size === 0)
      throw new Error("Game capture encoder returned an empty image");
    if (blob.size > options.maxBytes)
      throw new Error(
        `Game capture image exceeds maxBytes (${options.maxBytes})`,
      );
    const reader = new FileReader();
    cleanups.push(() => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
    });
    const encoded = await wait(
      new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          if (typeof reader.result === "string") resolve(reader.result);
          else reject(new Error("Game capture base64 encoding failed"));
        };
        reader.onerror = () =>
          reject(new Error("Game capture base64 encoding failed"));
        reader.onabort = () =>
          reject(new Error("Game capture base64 encoding aborted"));
        reader.readAsDataURL(blob);
      }),
    );
    const prefix = `data:${mimeType};base64,`;
    if (!encoded.startsWith(prefix))
      throw new Error("Game capture base64 encoding returned an invalid image");
    checkGl();
    outcome = {
      data: encoded.slice(prefix.length),
      mimeType,
      width,
      height,
      capturedAt,
    };
  } catch (error) {
    operationError = error;
    failed = true;
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    busy = false;
  }
  if (cleanupFailures.length) {
    if (failed) cleanupFailures.unshift(operationError);
    throw new Error(
      `Game capture cleanup failed: ${cleanupFailures.map(String).join("; ")}`,
    );
  }
  if (failed) throw operationError;
  if (!outcome) throw new Error("Game capture produced no result");
  return outcome;
}
