import { mkdir, readFile, rm, writeFile, stat, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bundler = vi.hoisted(() => vi.fn());
vi.mock("esbuild", () => ({ build: bundler }));
const modulePath = "../scripts/build.mjs";
const { computeBuildId, buildAll } = (await import(modulePath)) as {
  computeBuildId(root: string): Promise<string>;
  buildAll(root: string): Promise<string | null>;
};

describe("deterministic shared build identity", () => {
  let root: string;
  const inputs = [
    "package.json",
    "package-lock.json",
    "fxmanifest.lua",
    "scripts/build.mjs",
    "scripts/notices.mjs",
    "src/server/index.ts",
    "src/client/index.ts",
    "src/nui/index.ts",
    "lua/executor.lua",
    "web/index.html",
  ];
  beforeEach(async () => {
    root = resolve("tests", `.build-fixture-${randomUUID()}`);
    for (const path of inputs) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `fixture ${path}`);
    }
    await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "fixture", "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", license: "MIT" }),
    );
    await writeFile(
      join(root, "node_modules", "fixture", "LICENSE"),
      "Fixture license text",
    );
    bundler.mockReset().mockImplementation(async (options) => ({
      metafile: {
        outputs: {
          [options.outfile]: {
            inputs: { "node_modules/fixture/index.js": { bytesInOutput: 10 } },
          },
        },
      },
      outputFiles: [
        {
          path: join(root, options.outfile),
          contents: options.define.__DOLU_FIVEM_MCP_BUILD_ID__,
        },
      ],
    }));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("is stable and changes for source, manifest, package, Lua and bridge inputs", async () => {
    let previous = await computeBuildId(root);
    expect(previous).toMatch(/^[a-f0-9]{64}$/);
    expect(await computeBuildId(root)).toBe(previous);
    for (const path of inputs) {
      await writeFile(join(root, path), `changed ${path}`);
      const next = await computeBuildId(root);
      expect(next).not.toBe(previous);
      previous = next;
    }
  });
  it("ignores local config, generated bundles, environment files and logs", async () => {
    const previous = await computeBuildId(root);
    for (const path of [
      "config.cfg",
      ".env",
      "src/.env",
      "src/trace.log",
      "dist/server.js",
      ".yarn.installed",
      "THIRD_PARTY_NOTICES.txt",
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "private configuration excluded");
    }
    expect(await computeBuildId(root)).toBe(previous);
  });
  it("refreshes all targets coherently without generating source files", async () => {
    const first = await buildAll(root);
    expect(bundler).toHaveBeenCalledTimes(3);
    for (const [options] of bundler.mock.calls)
      expect(options).toMatchObject({ write: false, metafile: true });
    const notices = await readFile(
      join(root, "THIRD_PARTY_NOTICES.txt"),
      "utf8",
    );
    expect(notices).toContain("fixture@1.0.0\nLicense: MIT");
    expect(notices).toContain("Fixture license text");
    for (const target of ["server", "client", "nui"])
      expect(await readFile(join(root, `dist/${target}.js`), "utf8")).toBe(
        JSON.stringify(first),
      );
    await writeFile(join(root, "lua/executor.lua"), "changed Lua");
    const second = await buildAll(root);
    expect(second).not.toBe(first);
    expect(await readFile(join(root, "THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
      notices,
    );
    for (const target of ["server", "client", "nui"])
      expect(await readFile(join(root, `dist/${target}.js`), "utf8")).toBe(
        JSON.stringify(second),
      );
    expect(await readFile(join(root, "src/server/index.ts"), "utf8")).toBe(
      "fixture src/server/index.ts",
    );
  });
  it("marks bundled dependencies as installed, including future package timestamps", async () => {
    const future = new Date(Date.now() + 120_000);
    await utimes(join(root, "package.json"), future, future);
    await buildAll(root);
    const marker = join(root, ".yarn.installed");
    expect(await readFile(marker, "utf8")).toBe("");
    expect((await stat(marker)).mtimeMs).toBeGreaterThanOrEqual(
      (await stat(join(root, "package.json"))).mtimeMs,
    );
    const old = new Date(1000);
    await utimes(marker, old, old);
    await buildAll(root);
    expect((await stat(marker)).mtimeMs).toBeGreaterThanOrEqual(
      (await stat(join(root, "package.json"))).mtimeMs,
    );
  });
  it("does not create an installation marker when the first build fails", async () => {
    bundler.mockRejectedValue(new Error("compile failed"));
    await expect(buildAll(root)).rejects.toThrow("compile failed");
    await expect(stat(join(root, ".yarn.installed"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not publish bundles, notices or a marker when a license is missing", async () => {
    const license = join(root, "node_modules", "fixture", "LICENSE");
    await rm(license);
    await expect(buildAll(root)).rejects.toThrow("Missing license file");
    for (const path of [
      "dist/server.js",
      "THIRD_PARTY_NOTICES.txt",
      ".yarn.installed",
    ])
      await expect(stat(join(root, path))).rejects.toMatchObject({
        code: "ENOENT",
      });

    await writeFile(license, "Fixture license text");
    const first = await buildAll(root);
    const notices = await readFile(
      join(root, "THIRD_PARTY_NOTICES.txt"),
      "utf8",
    );
    await writeFile(join(root, ".yarn.installed"), "previous build");
    await writeFile(join(root, "src/server/index.ts"), "changed source");
    await rm(license);
    await expect(buildAll(root)).rejects.toThrow("Missing license file");
    expect(await readFile(join(root, ".yarn.installed"), "utf8")).toBe(
      "previous build",
    );
    expect(await readFile(join(root, "THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
      notices,
    );
    for (const target of ["server", "client", "nui"])
      expect(await readFile(join(root, `dist/${target}.js`), "utf8")).toBe(
        JSON.stringify(first),
      );
  });
  it("does not publish any target when inputs change while bundling or one target fails", async () => {
    const first = await buildAll(root);
    const notices = await readFile(
      join(root, "THIRD_PARTY_NOTICES.txt"),
      "utf8",
    );
    const marker = join(root, ".yarn.installed");
    await writeFile(marker, "previous build");
    bundler.mockImplementation(async (options) => {
      if (options.platform === "node")
        await writeFile(
          join(root, "src/server/index.ts"),
          "edited during build",
        );
      return {
        metafile: { outputs: {} },
        outputFiles: [
          { path: join(root, options.outfile), contents: "not published" },
        ],
      };
    });
    expect(await buildAll(root)).toBeNull();
    expect(await readFile(marker, "utf8")).toBe("previous build");
    expect(await readFile(join(root, "THIRD_PARTY_NOTICES.txt"), "utf8")).toBe(
      notices,
    );
    bundler.mockRejectedValue(new Error("compile failed"));
    await expect(buildAll(root)).rejects.toThrow("compile failed");
    expect(await readFile(marker, "utf8")).toBe("previous build");
    for (const target of ["server", "client", "nui"])
      expect(await readFile(join(root, `dist/${target}.js`), "utf8")).toBe(
        JSON.stringify(first),
      );
  });
});
