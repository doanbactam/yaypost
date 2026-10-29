// Plugins the person installs from the UI or API, like `pi install`: npm packages (or git URLs, or uploaded .tgz files)
// installed with the npm CLI into <DATA_DIR>/plugin-packages, a private npm project whose package.json lists them
// (pinned to exact versions). Install scripts never run (--ignore-scripts): a plugin's code only runs when
// Yaypost loads it, and the person is told before installing that it gets full access. One npm operation at a time.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env.ts";
import { BadInputError, ConflictError } from "./repo.ts";

const PREFIX = path.join(env.dataDir, "plugin-packages");
const PACKAGE_JSON = path.join(PREFIX, "package.json");
const REGISTRY = (process.env.YAYPOST_NPM_REGISTRY?.trim() || "https://registry.npmjs.org").replace(/\/+$/, "");
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
/** The keyword that lists a package in the catalog (as pi uses "pi-package"). */
export const PLUGIN_KEYWORD = "yaypost-plugin";

function dependencies(): Record<string, string> {
  if (!existsSync(PACKAGE_JSON)) return {};
  return (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
}

function ensurePrefix(): void {
  mkdirSync(PREFIX, { recursive: true });
  if (!existsSync(PACKAGE_JSON)) {
    writeFileSync(PACKAGE_JSON, JSON.stringify({ name: "yaypost-installed-plugins", private: true, dependencies: {} }, null, 2) + "\n");
  }
}

/** Directories of the installed plugin packages, in install order. */
export function installedPackageDirs(): string[] {
  return Object.keys(dependencies())
    .map((name) => path.join(PREFIX, "node_modules", ...name.split("/")))
    .filter((dir) => existsSync(path.join(dir, "package.json")));
}

export const installedPackageDir = (name: string) => path.join(PREFIX, "node_modules", ...name.split("/"));
export const installedSpec = (name: string): string | null => dependencies()[name] ?? null;

let npmVersion: Promise<string | null> | undefined;

/** The npm CLI's version, or null when there is none (installing is then unavailable; loading still works). */
export function npmAvailable(): Promise<string | null> {
  npmVersion ??= new Promise((resolve) => execFile("npm", ["--version"], { timeout: 15_000 }, (err, out) => resolve(err ? null : out.trim())));
  return npmVersion;
}

let queue: Promise<unknown> = Promise.resolve();

/** Run npm in the plugin project, one call at a time; errors carry npm's own last lines. */
function npm(args: string[]): Promise<void> {
  const run = queue.then(
    () =>
      new Promise<void>((resolve, reject) => {
        ensurePrefix();
        execFile(
          "npm",
          // --legacy-peer-deps: plugins name "yaypost" as a peer; the host provides it, npm must not fetch it.
          [...args, "--prefix", PREFIX, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error"],
          { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
          (err, _stdout, stderr) => {
            if (!err) return resolve();
            const tail = stderr
              .split("\n")
              .map((l) => l.replace(/^npm (ERR!|error) ?/, "").trim())
              .filter((l) => l && !/complete log of this run|^A complete log/.test(l))
              .slice(0, 3)
              .join(" ");
            reject(
              new ConflictError(
                /\bE404\b|404 Not Found/.test(tail)
                  ? `There is no package "${args.at(-1)}" on the npm registry. Check the name (and version).`
                  : `npm ${args[0]} failed: ${tail || err.message}`,
              ),
            );
          },
        );
      }),
  );
  queue = run.catch(() => undefined);
  return run;
}

// npm names (optionally @version or @tag), github:user/repo, git+https://…, https://….tgz, or a local .tgz file we saved.
const SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*|-]+)?$|^github:[\w.-]+\/[\w.-]+(#[\w./-]+)?$|^git\+https:\/\/\S+$|^https:\/\/\S+\.tgz$/i;

const nameFromSpec = (spec: string) => (/^(@[^/]+\/[^@]+|[^@]+)/.exec(spec)?.[1] ?? spec);

/**
 * Install a plugin package and return its name and directory. Refused (and rolled back) when the package isn't a
 * Yaypost plugin. The caller loads it.
 */
export async function installPackage(spec: string, validate: (dir: string) => void, knownName?: string): Promise<{ name: string; dir: string }> {
  spec = spec.trim();
  if (!SPEC.test(spec) && !spec.startsWith(path.join(PREFIX, "tarballs") + path.sep)) {
    throw new BadInputError(`"${spec}" isn't something to install: use an npm package name (optionally @version), github:user/repo, a git+https:// URL or an https://….tgz link.`);
  }
  if (!(await npmAvailable())) throw new ConflictError("npm isn't available on this server, so plugins can't be installed from here. Copy the plugin folder into <DATA_DIR>/plugins/ instead.");
  const before = dependencies();
  await npm(["install", "--save", "--save-exact", spec]);
  const after = dependencies();
  const added = Object.keys(after).filter((n) => before[n] !== after[n]);
  const name = knownName ?? (added.length === 1 ? added[0]! : nameFromSpec(spec));
  if (!after[name]) throw new ConflictError(`npm installed something, but not a package named ${name}.`);
  const dir = installedPackageDir(name);
  try {
    validate(dir);
  } catch (err) {
    if (!before[name]) await npm(["uninstall", "--save", name]).catch(() => undefined);
    else await npm(["install", "--save", "--save-exact", `${name}@${before[name]}`]).catch(() => undefined);
    throw new BadInputError(`${name}: ${(err as Error).message}`);
  }
  return { name, dir };
}

/** Save an uploaded .tgz (e.g. from `npm pack`) and install it like any other spec. */
export async function installTarball(file: File, validate: (dir: string) => void): Promise<{ name: string; dir: string }> {
  if (file.size > MAX_TARBALL_BYTES) throw new BadInputError("That file is larger than 20 MB.");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new BadInputError("Upload a .tgz package (made with `npm pack`).");
  const dir = path.join(PREFIX, "tarballs");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${Date.now()}-${path.basename(file.name).replace(/[^\w.-]/g, "_") || "plugin.tgz"}`);
  writeFileSync(target, bytes);
  return installPackage(target, validate);
}

export async function uninstallPackage(name: string): Promise<void> {
  if (!dependencies()[name]) throw new ConflictError(`${name} wasn't installed from the UI.`);
  await npm(["uninstall", "--save", name]);
}

/** Install the latest version from the registry (packages installed from git or a file are re-fetched as they were). */
export async function updatePackage(name: string, validate: (dir: string) => void): Promise<{ name: string; dir: string }> {
  const spec = dependencies()[name];
  if (!spec) throw new ConflictError(`${name} wasn't installed from the UI.`);
  const fromRegistry = /^[\d^~<>=*.x-]+$/i.test(spec) || /^\d/.test(spec);
  // A file install is recorded as file:tarballs/…, relative to the plugin project.
  return installPackage(fromRegistry ? `${name}@latest` : spec.startsWith("file:") ? path.resolve(PREFIX, spec.slice(5)) : spec, validate, name);
}

export interface CatalogEntry {
  name: string;
  version: string;
  description: string | null;
  date: string | null;
  publisher: string | null;
  npmUrl: string;
  repositoryUrl: string | null;
}

/** npm packages with the yaypost-plugin keyword, optionally matching `query`. */
export async function searchCatalog(query = ""): Promise<CatalogEntry[]> {
  const text = encodeURIComponent(`keywords:${PLUGIN_KEYWORD} ${query}`.trim());
  const res = await fetch(`${REGISTRY}/-/v1/search?text=${text}&size=50`, { signal: AbortSignal.timeout(15_000) }).catch((err: Error) => {
    throw new ConflictError(`Couldn't reach the npm registry: ${err.message}`);
  });
  if (!res.ok) throw new ConflictError(`The npm registry answered ${res.status}.`);
  const data = (await res.json()) as {
    objects: { package: { name: string; version: string; description?: string; date?: string; publisher?: { username?: string }; links?: { npm?: string; repository?: string } } }[];
  };
  return data.objects.map(({ package: p }) => ({
    name: p.name,
    version: p.version,
    description: p.description ?? null,
    date: p.date ?? null,
    publisher: p.publisher?.username ?? null,
    npmUrl: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
    repositoryUrl: p.links?.repository ?? null,
  }));
}
