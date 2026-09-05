import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VERSION } from "../src/shared/protocol";

const read = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const metadata = z
  .object({
    name: z.string(),
    version: z.string(),
    license: z.string(),
    repository: z.object({ url: z.string() }),
    files: z.array(z.string()),
  })
  .parse(JSON.parse(read("package.json")));

describe("release metadata", () => {
  it("uses the public project name in package and repository metadata", () => {
    expect(metadata.name).toBe("dolu_fivem_mcp");
    expect(metadata.repository.url).toBe(
      "git+https://github.com/DoluTattoo/dolu_fivem_mcp.git",
    );
    expect(JSON.parse(read("package-lock.json"))).toMatchObject({
      name: metadata.name,
      version: metadata.version,
      packages: {
        "": {
          name: metadata.name,
          version: metadata.version,
          license: metadata.license,
        },
      },
    });
  });

  it("keeps the package, manifest and protocol versions in sync", () => {
    expect(metadata.version).toBe(VERSION);
    expect(
      read("fxmanifest.lua").match(/^version ['"]([^'"]+)['"]/m)?.[1],
    ).toBe(VERSION);
  });

  it("includes project and dependency licenses in the runtime package", () => {
    expect(metadata.license).toBe("MIT");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 Dolu");
    expect(metadata.files).toEqual(
      expect.arrayContaining([
        "LICENSE",
        "THIRD_PARTY_NOTICES.txt",
        ".yarn.installed",
      ]),
    );
  });
});
