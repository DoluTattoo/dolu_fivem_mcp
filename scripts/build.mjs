import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
  mkdir,
  writeFile,
  stat,
  utimes,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateThirdPartyNotices } from "./notices.mjs";

// Explicit inputs only: never hash environment variables or local configuration.
export async function computeBuildId(root = process.cwd()) {
  const files = [
    "package.json",
    "package-lock.json",
    "fxmanifest.lua",
    "scripts/build.mjs",
    "scripts/notices.mjs",
  ];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /^tsconfig(?:\.[^.]+)?\.json$/.test(entry.name))
      files.push(entry.name);
  }
  async function collect(directory) {
    const entries = await readdir(join(root, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith("."))
        await collect(path);
      else if (
        entry.isFile() &&
        /\.(?:ts|tsx|js|mjs|css|html|lua)$/.test(entry.name)
      )
        files.push(path);
    }
  }
  await collect("src");
  await collect("lua");
  await collect("web");
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    const bytes = await readFile(join(root, path));
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function buildAll(root = process.cwd()) {
  const buildId = await computeBuildId(root);
  const targets = [
    {
      entryPoints: ["src/server/index.ts"],
      outfile: "dist/server.js",
      platform: "node",
      format: "cjs",
      banner: { js: "(() => {" },
      footer: { js: "})();" },
      target: "node22",
      external: ["bufferutil", "utf-8-validate"],
    },
    {
      entryPoints: ["src/client/index.ts"],
      outfile: "dist/client.js",
      platform: "neutral",
      format: "iife",
      target: "es2020",
    },
    {
      entryPoints: ["src/nui/index.ts"],
      outfile: "dist/nui.js",
      platform: "browser",
      format: "iife",
      target: "chrome91",
    },
  ];
  const results = await Promise.all(
    targets.map((target) =>
      build({
        ...target,
        absWorkingDir: root,
        bundle: true,
        sourcemap: false,
        legalComments: "eof",
        logLevel: "info",
        write: false,
        metafile: true,
        define: { __DOLU_FIVEM_MCP_BUILD_ID__: JSON.stringify(buildId) },
      }),
    ),
  );
  // Resolve every license before publishing any bundle or installation marker.
  const notices = await generateThirdPartyNotices(
    results.map((result) => result.metafile),
    root,
  );
  // Discard a build if a watched input changed while bundling. All targets are
  // rebuilt together with one identity, including targets unaffected by edits.
  if (buildId !== (await computeBuildId(root))) return null;
  await writeFile(join(root, "THIRD_PARTY_NOTICES.txt"), notices);
  for (const result of results) {
    for (const file of result.outputFiles) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents);
    }
  }
  // Cfx's Yarn builder skips installation only when this marker is not older than package.json.
  const marker = join(root, ".yarn.installed");
  const packageStat = await stat(join(root, "package.json"));
  await writeFile(marker, "");
  const timestamp = new Date(
    Math.ceil(Math.max(Date.now(), packageStat.mtimeMs)),
  );
  await utimes(marker, timestamp, timestamp);
  return buildId;
}

async function main() {
  const watch = process.argv.includes("--watch");
  let previous;
  do {
    try {
      if ((await computeBuildId()) !== previous) previous = await buildAll();
    } catch (error) {
      if (!watch) throw error;
      console.error(
        "[dolu_fivem_mcp] Build failed; retaining last successful bundles:",
        error,
      );
    }
    if (watch) await new Promise((done) => setTimeout(done, 500));
  } while (watch || !previous);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
