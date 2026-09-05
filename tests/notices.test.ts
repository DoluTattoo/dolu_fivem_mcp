import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Metafile = {
  inputs?: Record<string, unknown>;
  outputs: Record<
    string,
    { inputs: Record<string, { bytesInOutput: number }> }
  >;
};
const modulePath = "../scripts/notices.mjs";
const { generateThirdPartyNotices } = (await import(modulePath)) as {
  generateThirdPartyNotices(
    metafiles: Metafile[],
    root?: string,
  ): Promise<string>;
};

describe("bundled dependency notices", () => {
  let root: string;
  beforeEach(async () => {
    root = resolve("tests", `.notices-fixture-${randomUUID()}`);
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function file(path: string, contents: string) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  async function dependency(
    path: string,
    name = path.split("node_modules/").at(-1),
    version = "1.0.0",
  ) {
    await file(
      `${path}/package.json`,
      JSON.stringify({ name, version, license: "MIT" }),
    );
    await file(
      `${path}/LICENSE`,
      "Copyright (c) Fixture Authors\r\n\r\nComplete permission grant.\r\nComplete disclaimer.\r\n",
    );
  }
  function metafile(...inputs: string[]): Metafile {
    return {
      outputs: {
        "dist/bundle.js": {
          inputs: Object.fromEntries(
            inputs.map((input) => [input, { bytesInOutput: 10 }]),
          ),
        },
      },
    };
  }

  it("includes complete licenses and supplemental notices only for output contributors", async () => {
    await dependency("node_modules/used");
    await file(
      "node_modules/used/NOTICE.txt",
      "Supplemental attribution\nAll rights reserved.\n",
    );
    await file("node_modules/used/docs/COPYRIGHT", "Another copyright owner\n");
    await file("node_modules/used/index.js", "IMPLEMENTATION MUST NOT APPEAR");
    const meta = metafile("src/index.ts", "node_modules/used/index.js");
    meta.inputs = {
      "node_modules/type-only/index.d.ts": {},
      "node_modules/tree-shaken/index.js": {},
    };
    for (const output of Object.values(meta.outputs))
      output.inputs["node_modules/zero/index.js"] = { bytesInOutput: 0 };
    const result = await generateThirdPartyNotices([meta], root);
    expect(result).toContain("used@1.0.0\nLicense: MIT");
    expect(result).toContain(
      (
        await readFile(join(root, "node_modules/used/LICENSE"), "utf8")
      ).replaceAll("\r\n", "\n"),
    );
    expect(result).toContain(
      "Supplemental attribution\nAll rights reserved.\n",
    );
    expect(result).toContain(
      "--- docs/COPYRIGHT ---\nAnother copyright owner\n",
    );
    expect(result).not.toMatch(/type-only|tree-shaken|zero|IMPLEMENTATION/);
    expect(result).not.toContain(root);
    expect(result).not.toContain("\r");
  });

  it("finds scoped owners above module-type manifests and handles nested installations", async () => {
    await dependency("node_modules/@scope/pkg");
    await file(
      "node_modules/@scope/pkg/dist/package.json",
      '{"type":"module"}',
    );
    await dependency("node_modules/outer/node_modules/inner", "inner", "2.0.0");
    const result = await generateThirdPartyNotices(
      [
        metafile(
          "node_modules/@scope/pkg/dist/index.js",
          "node_modules/outer/node_modules/inner/index.js",
        ),
      ],
      root,
    );
    expect(result).toContain("@scope/pkg@1.0.0");
    expect(result).toContain("inner@2.0.0");
    expect(result).not.toContain("outer@");
  });

  it("is deterministic across input order, targets, duplicate installations and absolute paths", async () => {
    await dependency("node_modules/z");
    await dependency("node_modules/a");
    await dependency("node_modules/outer/node_modules/a", "a");
    await dependency("node_modules/older/node_modules/a", "a", "0.9.0");
    const inputs = [
      "node_modules/z/index.js",
      "node_modules/a/index.js",
      "node_modules/outer/node_modules/a/index.js",
      "node_modules/older/node_modules/a/index.js",
    ];
    const first = await generateThirdPartyNotices([metafile(...inputs)], root);
    const second = await generateThirdPartyNotices(
      [
        metafile(...[...inputs].reverse().map((input) => resolve(root, input))),
        metafile("node_modules/a/another.js"),
      ],
      root,
    );
    expect(second).toBe(first);
    expect(first.match(/a@1\.0\.0/g)).toHaveLength(1);
    expect(first.indexOf("a@0.9.0")).toBeLessThan(first.indexOf("a@1.0.0"));
    expect(first.indexOf("a@1.0.0")).toBeLessThan(first.indexOf("z@1.0.0"));
  });

  it("collects license directories but never copies nested dependencies", async () => {
    await dependency("node_modules/used");
    await rm(join(root, "node_modules/used/LICENSE"));
    await file("node_modules/used/LICENSES/MIT.txt", "Full MIT license");
    await file("node_modules/used/licenses/BSD.txt", "Full BSD license");
    await dependency("node_modules/used/node_modules/unbundled");
    const result = await generateThirdPartyNotices(
      [metafile("node_modules/used/index.js")],
      root,
    );
    expect(result).toContain("Full MIT license");
    expect(result).toContain("Full BSD license");
    expect(result).not.toContain("Fixture Authors");
    expect(result).not.toContain("unbundled");
  });

  it("fails explicitly for missing licenses, even when supplemental notices exist", async () => {
    await dependency("node_modules/used");
    await rm(join(root, "node_modules/used/LICENSE"));
    await file("node_modules/used/NOTICE", "Attribution is not a license");
    await expect(
      generateThirdPartyNotices([metafile("node_modules/used/index.js")], root),
    ).rejects.toThrow("Missing license file for bundled dependency used@1.0.0");
  });

  it("rejects missing package metadata and empty license text", async () => {
    await expect(
      generateThirdPartyNotices(
        [metafile("node_modules/missing/index.js")],
        root,
      ),
    ).rejects.toThrow("Cannot find package.json");
    await dependency("node_modules/used");
    await file(
      "node_modules/used/package.json",
      '{"name":"used","version":"1.0.0"}',
    );
    await expect(
      generateThirdPartyNotices([metafile("node_modules/used/index.js")], root),
    ).rejects.toThrow("Missing version or license metadata for used");
    await dependency("node_modules/used");
    await file("node_modules/used/LICENSE", " \r\n");
    await expect(
      generateThirdPartyNotices([metafile("node_modules/used/index.js")], root),
    ).rejects.toThrow("Empty notice file for used");
  });

  it("allows dependency-free bundles", async () => {
    const result = await generateThirdPartyNotices(
      [metafile("src/index.ts")],
      root,
    );
    expect(result).toContain("THIRD-PARTY NOTICES FOR dolu_fivem_mcp");
    expect(result).not.toContain("License:");
  });
});
