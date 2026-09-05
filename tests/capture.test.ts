import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureGame } from "../src/nui/capture";
import type { GameCaptureOptions } from "../src/shared/capture";

const options: GameCaptureOptions = {
  maxWidth: 1280,
  format: "jpeg",
  quality: 0.8,
  timeoutMs: 2000,
  maxBytes: 100000,
};

function png(width: number, height: number) {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

function browser() {
  const state = {
    rafStalled: false,
    encodeStalled: false,
    decodeStalled: false,
    readerStalled: false,
    encodeNull: false,
    decodeError: false,
    placeholder: false,
    blackFrames: 0,
    draws: 0,
    contextLost: false,
    shaderOk: true,
    linkOk: true,
    webglAvailable: true,
    twoDAvailable: true,
    blobSize: 4,
    blobType: "",
    imageWidth: 1920,
    imageHeight: 1080,
    viewport: [0, 0],
    glError: 0,
    allocationFailure: "",
  };
  const loseContext = vi.fn();
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE0: 8,
    TEXTURE_2D: 9,
    RGBA: 10,
    UNSIGNED_BYTE: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    LINEAR: 14,
    TEXTURE_WRAP_S: 15,
    TEXTURE_WRAP_T: 16,
    CLAMP_TO_EDGE: 17,
    MIRRORED_REPEAT: 18,
    REPEAT: 19,
    TRIANGLE_STRIP: 20,
    NO_ERROR: 0,
    createProgram: vi.fn(() =>
      state.allocationFailure === "program" ? null : {},
    ),
    createShader: vi.fn(() =>
      state.allocationFailure === "shader" ? null : {},
    ),
    createBuffer: vi.fn(() =>
      state.allocationFailure === "buffer" ? null : {},
    ),
    createTexture: vi.fn(() =>
      state.allocationFailure === "texture" ? null : {},
    ),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteTexture: vi.fn(),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    useProgram: vi.fn(),
    getShaderParameter: vi.fn(() => state.shaderOk),
    getProgramParameter: vi.fn(() => state.linkOk),
    getShaderInfoLog: vi.fn(() => "compile error"),
    getProgramInfoLog: vi.fn(() => "link error"),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameterf: vi.fn(),
    uniform1i: vi.fn(),
    getUniformLocation: vi.fn(() => ({})),
    viewport: vi.fn((_x: number, _y: number, w: number, h: number) => {
      state.viewport = [w, h];
    }),
    drawArrays: vi.fn(() => {
      state.draws++;
    }),
    readPixels: vi.fn(
      (
        x: number,
        y: number,
        _w: number,
        _h: number,
        _format: number,
        _type: number,
        target: Uint8Array,
      ) => {
        const colors = [
          [251, 3, 197, 255],
          [7, 239, 61, 255],
          [31, 67, 241, 255],
          [229, 181, 13, 255],
        ];
        target.set(
          state.placeholder
            ? colors[(x > 0 ? 1 : 0) + (y > 0 ? 2 : 0)]!
            : state.draws <= state.blackFrames
              ? [0, 0, 0, 255]
              : [20, 30, 40, 255],
        );
      },
    ),
    getError: vi.fn(() => state.glError),
    isContextLost: vi.fn(() => state.contextLost),
    getExtension: vi.fn(() => ({ loseContext })),
  };
  const context = {
    drawImage: vi.fn(),
    globalCompositeOperation: "",
  };
  const canvases: ReturnType<typeof makeCanvas>[] = [];
  function makeCanvas() {
    return {
      width: 0,
      height: 0,
      hidden: false,
      tabIndex: 0,
      remove: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getContext: vi.fn((type: string) =>
        type === "webgl"
          ? state.webglAvailable
            ? gl
            : null
          : state.twoDAvailable
            ? context
            : null,
      ),
      toBlob: vi.fn((callback: (blob: Blob | null) => void, type: string) => {
        if (!state.encodeStalled)
          callback(
            state.encodeNull
              ? null
              : new Blob([new Uint8Array(state.blobSize)], {
                  type: state.blobType || type,
                }),
          );
      }),
    };
  }
  const images: MockImage[] = [];
  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = state.imageWidth;
    naturalHeight = state.imageHeight;
    removeAttribute = vi.fn();
    constructor() {
      images.push(this);
    }
    set src(_value: string) {
      if (!state.decodeStalled)
        queueMicrotask(() =>
          state.decodeError ? this.onerror?.() : this.onload?.(),
        );
    }
  }
  const readers: MockReader[] = [];
  class MockReader {
    static LOADING = 1;
    readyState = 0;
    result = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    abort = vi.fn(() => {
      this.readyState = 2;
    });
    constructor() {
      readers.push(this);
    }
    readAsDataURL(blob: Blob) {
      this.readyState = 1;
      if (!state.readerStalled) {
        this.result = `data:${blob.type};base64,AAAAAA==`;
        this.readyState = 2;
        queueMicrotask(() => this.onload?.());
      }
    }
  }
  let frameId = 0;
  vi.stubGlobal("window", { innerWidth: 1920, innerHeight: 1080 });
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      const target = makeCanvas();
      canvases.push(target);
      return target;
    }),
  });
  vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("FileReader", MockReader);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: () => void) => {
      if (!state.rafStalled) queueMicrotask(callback);
      return ++frameId;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { state, gl, loseContext, context, canvases, images, readers };
}

let env: ReturnType<typeof browser>;
beforeEach(() => {
  env = browser();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function expectDisposed() {
  for (const canvas of env.canvases) {
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(canvas.hidden).toBe(true);
    expect(canvas.tabIndex).toBe(-1);
  }
  expect(env.gl.deleteProgram).toHaveBeenCalledTimes(
    env.gl.createProgram.mock.results.filter((result) => result.value).length,
  );
  expect(env.gl.deleteShader).toHaveBeenCalledTimes(
    env.gl.createShader.mock.results.filter((result) => result.value).length,
  );
  expect(env.gl.deleteBuffer).toHaveBeenCalledTimes(
    env.gl.createBuffer.mock.results.filter((result) => result.value).length,
  );
  expect(env.gl.deleteTexture).toHaveBeenCalledTimes(
    env.gl.createTexture.mock.results.filter((result) => result.value).length,
  );
}

describe("NUI game capture", () => {
  it("captures a black game scene, registers the exact hook and disposes all allocations", async () => {
    env.state.blackFrames = Infinity;
    const result = await captureGame(options);
    expect(result).toMatchObject({
      data: "AAAAAA==",
      mimeType: "image/jpeg",
      width: 1280,
      height: 720,
    });
    expect(Number.isFinite(Date.parse(result.capturedAt))).toBe(true);
    expect(
      env.gl.texParameterf.mock.calls
        .filter((call) => call[1] === env.gl.TEXTURE_WRAP_T)
        .map((call) => call[2]),
    ).toEqual([
      env.gl.CLAMP_TO_EDGE,
      env.gl.MIRRORED_REPEAT,
      env.gl.REPEAT,
      env.gl.CLAMP_TO_EDGE,
    ]);
    expect(env.canvases[1]!.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      0.8,
    );
    expect(env.context.drawImage).toHaveBeenCalledTimes(1);
    expect(env.loseContext).toHaveBeenCalledOnce();
    expect(env.state.draws).toBe(4);
    expectDisposed();
  });

  it("waits through cold black frames before returning the game", async () => {
    env.state.blackFrames = 2;
    await expect(captureGame(options)).resolves.toMatchObject({ width: 1280 });
    expect(env.state.draws).toBe(3);
    expectDisposed();
  });

  it("surfaces cleanup failures while still disposing other resources and releasing busy", async () => {
    env.gl.deleteTexture.mockImplementationOnce(() => {
      throw new Error("texture disposal failed");
    });
    await expect(captureGame(options)).rejects.toThrow(
      "texture disposal failed",
    );
    expectDisposed();
    await expect(captureGame(options)).resolves.toMatchObject({ width: 1280 });
  });

  it("preserves the capture error when cleanup also fails", async () => {
    env.state.encodeNull = true;
    env.gl.deleteTexture.mockImplementationOnce(() => {
      throw new Error("texture disposal failed");
    });
    const outcome = captureGame(options);
    await expect(outcome).rejects.toThrow("encoding failed");
    await expect(outcome).rejects.toThrow("texture disposal failed");
    expectDisposed();
  });

  it.each([
    [3840, 2160, 1920, 1920, 1080],
    [1000, 10000, 1920, 216, 2160],
    [320, 200, 1920, 320, 200],
    [1920, 1080, 1000, 1000, 563],
    [16384, 16384, 160, 160, 160],
  ])(
    "preserves bounded sizing for %ix%i",
    async (w, h, maxWidth, width, height) => {
      window.innerWidth = w;
      window.innerHeight = h;
      await expect(
        captureGame({ ...options, maxWidth }),
      ).resolves.toMatchObject({ width, height });
      expect(env.state.viewport).toEqual([width, height]);
      expectDisposed();
    },
  );

  it.each([
    { maxWidth: 159 },
    { maxWidth: 1921 },
    { maxWidth: NaN },
    { quality: -0.1 },
    { quality: 0 },
    { quality: 1.1 },
    { quality: Infinity },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { maxBytes: 0 },
    { maxBytes: 1.5 },
    { format: "gif" },
  ])("rejects invalid options %j before allocation", async (invalid) => {
    await expect(
      captureGame({ ...options, ...invalid } as GameCaptureOptions),
    ).rejects.toThrow("Invalid");
    expect(env.canvases).toHaveLength(0);
  });

  it.each([0, -1, 16385, Infinity, NaN, 1.5])(
    "rejects invalid viewport %s",
    async (width) => {
      window.innerWidth = width;
      await expect(captureGame(options)).rejects.toThrow("viewport");
      expect(env.canvases).toHaveLength(0);
    },
  );

  it("rejects concurrent capture and releases busy after success", async () => {
    const first = captureGame(options);
    await expect(captureGame(options)).rejects.toThrow("busy");
    await first;
    await expect(captureGame(options)).resolves.toMatchObject({
      mimeType: "image/jpeg",
    });
    expectDisposed();
  });

  it("allows throttled RAF through its bounded timer fallback", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    env.state.rafStalled = true;
    const pending = captureGame(options);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ width: 1280 });
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expectDisposed();
  });

  it("rejects the unchanged placeholder instead of returning a fake game image", async () => {
    env.state.placeholder = true;
    await expect(captureGame(options)).rejects.toThrow("did not initialize");
    expect(env.gl.drawArrays).toHaveBeenCalledTimes(12);
    expectDisposed();
  });

  it.each([
    "rafStalled",
    "encodeStalled",
    "decodeStalled",
    "readerStalled",
  ] as const)(
    "times out stalled %s, cleans up and releases busy",
    async (stage) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
      });
      env.state[stage] = true;
      const pending = expect(
        captureGame({
          ...options,
          timeoutMs: 50,
          overlay: stage === "decodeStalled" ? png(1920, 1080) : undefined,
        }),
      ).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(60);
      await pending;
      expectDisposed();
      expect(vi.getTimerCount()).toBe(0);
      if (stage === "readerStalled")
        expect(env.readers[0]!.abort).toHaveBeenCalledOnce();
      if (stage === "decodeStalled")
        expect(env.images[0]!.removeAttribute).toHaveBeenCalledWith("src");
      env.state[stage] = false;
      await expect(captureGame(options)).resolves.toMatchObject({
        width: 1280,
      });
    },
  );

  it.each([
    ["shaderOk", false, "shader failed"],
    ["linkOk", false, "link failed"],
    ["webglAvailable", false, "WebGL is unavailable"],
    ["twoDAvailable", false, "2D context"],
    ["contextLost", true, "context lost"],
    ["encodeNull", true, "encoding failed"],
    ["glError", 1282, "WebGL error"],
    ["blobType", "image/webp", "unexpected image format"],
    ["blobSize", 0, "empty image"],
  ] as const)("cleans up on %s errors", async (key, value, error) => {
    Object.assign(env.state, { [key]: value });
    await expect(captureGame(options)).rejects.toThrow(error);
    expectDisposed();
  });

  it.each(["program", "shader", "buffer", "texture"])(
    "cleans up after %s allocation fails",
    async (allocation) => {
      env.state.allocationFailure = allocation;
      await expect(captureGame(options)).rejects.toThrow("allocation failed");
      expectDisposed();
      expect(env.loseContext).toHaveBeenCalledOnce();
    },
  );

  it("rejects context loss during an asynchronous stage without waiting for timeout", async () => {
    env.state.encodeStalled = true;
    const pending = expect(captureGame(options)).rejects.toThrow(
      "context lost",
    );
    for (let i = 0; i < 20 && !env.canvases[1]; i++) await Promise.resolve();
    const listener = env.canvases[0]!.addEventListener.mock
      .calls[0]![1] as () => void;
    listener();
    await pending;
    expectDisposed();
  });

  it("rejects oversized encoded bytes explicitly", async () => {
    env.state.blobSize = 1001;
    await expect(captureGame({ ...options, maxBytes: 1000 })).rejects.toThrow(
      "exceeds maxBytes",
    );
    expect(env.readers).toHaveLength(0);
    expectDisposed();
  });

  it.each([
    [1920, 1080],
    [3840, 2160],
    [1280, 720],
    [1280, 721],
    [1280, 719],
  ])(
    "composites a compatible %ix%i transparent PNG without clearing the game",
    async (width, height) => {
      env.state.imageWidth = width;
      env.state.imageHeight = height;
      await expect(
        captureGame({
          ...options,
          format: "png",
          overlay: png(width, height),
        }),
      ).resolves.toMatchObject({ mimeType: "image/png" });
      expect(env.context.globalCompositeOperation).toBe("source-over");
      expect(env.context.drawImage).toHaveBeenNthCalledWith(
        2,
        env.images[0],
        0,
        0,
        1280,
        720,
      );
      expect(env.images[0]!.removeAttribute).toHaveBeenCalledWith("src");
      expectDisposed();
    },
  );

  it.each([
    ["", "base64"],
    ["not png!", "base64"],
    ["A".repeat(44), "PNG image"],
    [png(0, 1080), "dimensions"],
    [png(16385, 1080), "dimensions"],
    [png(1000, 1000), "aspect ratio"],
    [png(1280, 722), "aspect ratio"],
  ])(
    "rejects invalid overlays rather than dropping them",
    async (overlay, error) => {
      await expect(captureGame({ ...options, overlay })).rejects.toThrow(error);
      expectDisposed();
    },
  );

  it("rejects overlay decode errors and releases its source", async () => {
    env.state.decodeError = true;
    await expect(
      captureGame({ ...options, overlay: png(1920, 1080) }),
    ).rejects.toThrow("decode failed");
    expect(env.images[0]!.removeAttribute).toHaveBeenCalledWith("src");
    expectDisposed();
  });

  it("rejects overlay decoded dimensions inconsistent with the PNG header", async () => {
    env.state.imageWidth = 100;
    await expect(
      captureGame({ ...options, overlay: png(1920, 1080) }),
    ).rejects.toThrow("decoded dimensions");
    expectDisposed();
  });

  it("registers the versioned global bridge and build identity before the readiness handshake", async () => {
    vi.stubGlobal("doluMcpCapture", undefined);
    vi.stubGlobal("doluMcpBuild", undefined);
    vi.stubGlobal("GetParentResourceName", () => "dolu_fivem_mcp");
    const fetchReady = vi.fn(() => {
      expect(globalThis.doluMcpCapture.version).toBe(1);
      expect(globalThis.doluMcpCapture.capture).toBe(captureGame);
      expect(globalThis.doluMcpBuild).toBe("development");
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal("fetch", fetchReady);
    await import("../src/nui/index");
    expect(fetchReady).toHaveBeenCalledWith("https://dolu_fivem_mcp/mcp_ready", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buildId: "development" }),
    });
  });
});
