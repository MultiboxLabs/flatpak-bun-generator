#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { base64ToHex, splitOnce, stripJsoncTrailingCommas } from "./utils.ts";
import { bunCacheVersion } from "./wyhash.ts";

export interface BunPackage {
  identifier: string;
  name: string;
  version: string;
  integrity: string;
  os?: string;
  cpu?: string;
}

export interface GitBunPackage {
  identifier: string;
  owner: string;
  repo: string;
  commit: string;
}

export interface FlatpakSource {
  type: string;
  url?: string;
  dest: string;
  "dest-filename"?: string;
  "only-arches"?: string[];
  "strip-components"?: number;
  sha256?: string;
  sha512?: string;
}

export interface ElectronInfo {
  source: "npm" | "git";
  fullVersion: string;
  baseVersion: string;
  buildMeta: string | null;
  owner: string;
  repo: string;
  commit?: string;
}

export interface CliOptions {
  lockPath: string;
  outputPath: string;
  allOs: boolean;
  noDev: boolean;
  registry: string;
}

export function parseBunLockfile(text: string): {
  lockfileVersion: number;
  packages: Record<string, any[]>;
  workspaces: Record<string, any>;
} {
  const cleaned = stripJsoncTrailingCommas(text);
  const data = JSON.parse(cleaned);

  if (data.lockfileVersion !== 1) {
    throw new Error(
      `Unsupported bun lockfile version: ${data.lockfileVersion}. Only version 1 is supported.`
    );
  }

  return data;
}

export function extractPackages(
  packagesMap: Record<string, any[]>,
  options: { allOs: boolean; noDev: boolean; devPackageNames: Set<string> }
): BunPackage[] {
  const packages: BunPackage[] = [];
  const seen = new Set<string>();

  for (const [key, entry] of Object.entries(packagesMap)) {
    if (!Array.isArray(entry) || entry.length < 4) continue;

    const identifier: string = entry[0];

    if (!identifier) continue;

    if (typeof entry[1] !== "string") {
      continue;
    }

    const meta: Record<string, any> = entry[2] ?? {};
    const integrity: string = entry[3] ?? "";

    if (!integrity) continue;

    if (seen.has(identifier)) continue;
    seen.add(identifier);

    const parsed = parseIdentifier(identifier);
    if (!parsed) continue;

    const { name, version } = parsed;

    if (options.noDev && options.devPackageNames.has(key)) {
      continue;
    }

    const os = meta.os as string | undefined;
    if (!options.allOs && os !== undefined && os !== "linux") {
      continue;
    }

    const cpu = meta.cpu as string | undefined;

    packages.push({
      identifier,
      name,
      version,
      integrity,
      os,
      cpu,
    });
  }

  return packages;
}

export function parseIdentifier(
  identifier: string
): { name: string; version: string } | null {
  const atIdx = identifier.lastIndexOf("@");
  if (atIdx <= 0) return null;

  const name = identifier.slice(0, atIdx);
  const version = identifier.slice(atIdx + 1);

  if (!name || !version) return null;
  return { name, version };
}

export function parseGitIdentifier(
  identifier: string
): { owner: string; repo: string; commit: string } | null {
  const match = identifier.match(/@github:([^/]+)\/([^#]+)#(.+)$/);
  if (!match) return null;

  const [, owner, repo, commit] = match;
  if (!owner || !repo || !commit) return null;

  return { owner, repo, commit };
}

export function extractGitPackages(
  packagesMap: Record<string, any[]>
): GitBunPackage[] {
  const packages: GitBunPackage[] = [];
  const seen = new Set<string>();

  for (const [_key, entry] of Object.entries(packagesMap)) {
    if (!Array.isArray(entry) || entry.length < 3) continue;

    const identifier: string = entry[0];
    if (!identifier) continue;

    if (typeof entry[1] === "string") continue;

    if (seen.has(identifier)) continue;
    seen.add(identifier);

    const parsed = parseGitIdentifier(identifier);
    if (!parsed) {
      console.warn(
        `Skipping ${identifier}: unable to parse git dependency identifier. ` +
          `Only github: dependencies are supported.`
      );
      continue;
    }

    packages.push({
      identifier,
      ...parsed,
    });
  }

  return packages;
}

function mapCpuToArch(cpu: string): string | null {
  switch (cpu) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      return null;
  }
}

export function npmPkgToFlatpakSources(
  pkg: BunPackage,
  registry: string
): FlatpakSource[] {
  const [checksumType, checksumValue] = splitOnce(pkg.integrity, "-");
  if (!checksumValue) {
    console.warn(
      `Skipping ${pkg.name}@${pkg.version}: unable to parse integrity hash`
    );
    return [];
  }

  const basename = pkg.name.startsWith("@")
    ? pkg.name.split("/")[1]
    : pkg.name;
  const tarballUrl = `${registry}/${pkg.name}/-/${basename}-${pkg.version}.tgz`;

  const cacheVersion = bunCacheVersion(pkg.version);

  const hexChecksum = base64ToHex(checksumValue);
  const fileSource: FlatpakSource = {
    type: "file",
    url: tarballUrl,
    [checksumType]: hexChecksum,
    dest: "bun_cache",
    "dest-filename": `${pkg.name.replace("/", "--")}@${cacheVersion}.tgz`,
  };

  if (pkg.cpu) {
    const arch = mapCpuToArch(pkg.cpu);
    if (arch) {
      fileSource["only-arches"] = [arch];
    }
  }

  return [fileSource];
}

export function gitPkgToFlatpakSource(
  pkg: GitBunPackage,
  sha256Hash: string
): FlatpakSource {
  const url = `https://github.com/${pkg.owner}/${pkg.repo}/archive/${pkg.commit}.tar.gz`;
  const dest = `bun_cache/@GH@${pkg.owner}-${pkg.repo}-${pkg.commit}@@@1`;

  return {
    type: "archive",
    url,
    sha256: sha256Hash,
    dest,
    "strip-components": 1,
  };
}

export async function fetchSha256(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  const data = await response.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function collectDevDependencyNames(
  workspaces: Record<string, any>,
  packagesMap: Record<string, any[]>
): Set<string> {
  const prodRoots = new Set<string>();

  for (const ws of Object.values(workspaces)) {
    if (ws.dependencies) {
      for (const name of Object.keys(ws.dependencies)) {
        prodRoots.add(name);
      }
    }
    if (ws.devDependencies) {
      // Dev roots are inferred as anything not reachable from prod roots.
    }
    if (ws.optionalDependencies) {
      for (const name of Object.keys(ws.optionalDependencies)) {
        prodRoots.add(name);
      }
    }
    if (ws.peerDependencies) {
      for (const name of Object.keys(ws.peerDependencies)) {
        prodRoots.add(name);
      }
    }
  }

  function resolveDep(parentKey: string, depName: string): string | null {
    const nestedKey = `${parentKey}/${depName}`;
    if (nestedKey in packagesMap) return nestedKey;
    if (depName in packagesMap) return depName;
    return null;
  }

  const prodReachable = new Set<string>();
  const queue: string[] = [];

  for (const name of prodRoots) {
    if (name in packagesMap) {
      queue.push(name);
      prodReachable.add(name);
    }
  }

  while (queue.length > 0) {
    const key = queue.pop()!;
    const entry = packagesMap[key];
    if (!Array.isArray(entry) || entry.length < 3) continue;

    const meta = entry[2] ?? {};
    const deps = {
      ...meta.dependencies,
      ...meta.optionalDependencies,
      ...meta.peerDependencies,
    };

    for (const depName of Object.keys(deps)) {
      const resolvedKey = resolveDep(key, depName);
      if (resolvedKey && !prodReachable.has(resolvedKey)) {
        prodReachable.add(resolvedKey);
        queue.push(resolvedKey);
      }
    }
  }

  const devOnly = new Set<string>();
  for (const key of Object.keys(packagesMap)) {
    if (!prodReachable.has(key)) {
      devOnly.add(key);
    }
  }

  return devOnly;
}

export function filterPackagesMap(
  packagesMap: Record<string, any[]>,
  excludedKeys: Set<string>
): Record<string, any[]> {
  const filtered: Record<string, any[]> = {};

  for (const [key, value] of Object.entries(packagesMap)) {
    if (!excludedKeys.has(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}

const ELECTRON_ARCHES: { flatpak: string; electron: string }[] = [
  { flatpak: "x86_64", electron: "x64" },
  { flatpak: "aarch64", electron: "arm64" },
];

export type DetectedElectron =
  | { type: "npm"; version: string }
  | { type: "git"; owner: string; repo: string; commit: string };

export function detectElectronPackage(
  packagesMap: Record<string, any[]>
): DetectedElectron | null {
  const entry = packagesMap["electron"];
  if (!Array.isArray(entry) || entry.length < 2) return null;

  const identifier: string = entry[0];
  if (!identifier) return null;

  // Git dep: entry[1] is an object (not a string)
  if (typeof entry[1] !== "string") {
    const parsed = parseGitIdentifier(identifier);
    if (!parsed) return null;
    return { type: "git", ...parsed };
  }

  // npm dep: parse version from identifier
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;
  return { type: "npm", version: parsed.version };
}

export async function getElectronVersion(
  owner: string,
  repo: string,
  commit: string
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/package.json`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  const pkg = (await response.json()) as { version?: string };
  if (!pkg.version) {
    throw new Error(
      `No "version" field found in ${owner}/${repo}@${commit}/package.json`
    );
  }
  return pkg.version;
}

export async function resolveElectronInfo(
  detected: DetectedElectron
): Promise<ElectronInfo> {
  if (detected.type === "npm") {
    return parseElectronVersion(
      detected.version,
      "npm",
      "electron",
      "electron"
    );
  }

  const fullVersion = await getElectronVersion(
    detected.owner,
    detected.repo,
    detected.commit
  );
  return parseElectronVersion(
    fullVersion,
    "git",
    detected.owner,
    detected.repo,
    detected.commit
  );
}

export function splitElectronVersion(
  fullVersion: string
): { baseVersion: string; buildMeta: string | null } {
  const plusIdx = fullVersion.indexOf("+");
  const baseVersion = plusIdx !== -1 ? fullVersion.slice(0, plusIdx) : fullVersion;
  const buildMeta = plusIdx !== -1 ? fullVersion.slice(plusIdx + 1) : null;
  return { baseVersion, buildMeta };
}

export function parseElectronVersion(
  fullVersion: string,
  source: "npm" | "git",
  owner: string,
  repo: string,
  commit?: string
): ElectronInfo {
  const { baseVersion, buildMeta } = splitElectronVersion(fullVersion);

  return {
    source,
    fullVersion,
    baseVersion,
    buildMeta,
    owner,
    repo,
    commit,
  };
}

export async function computeElectronCacheKey(
  downloadDirUrl: string
): Promise<string> {
  const data = new TextEncoder().encode(downloadDirUrl);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function electronDownloadDirUrl(info: ElectronInfo): string {
  const versionTag = info.buildMeta
    ? `v${info.baseVersion}+${info.buildMeta}`
    : `v${info.baseVersion}`;
  return `https://github.com/${info.owner}/${info.repo}/releases/download/${versionTag}`;
}

export function electronBinaryUrl(
  info: ElectronInfo,
  electronArch: string
): string {
  const versionTag = info.buildMeta
    ? `v${info.baseVersion}%2B${info.buildMeta}`
    : `v${info.baseVersion}`;
  const filename = info.buildMeta
    ? `electron-v${info.baseVersion}+${info.buildMeta}-linux-${electronArch}.zip`
    : `electron-v${info.baseVersion}-linux-${electronArch}.zip`;
  return `https://github.com/${info.owner}/${info.repo}/releases/download/${versionTag}/${filename}`;
}

export async function electronBinarySources(
  info: ElectronInfo
): Promise<FlatpakSource[]> {
  const dirUrl = electronDownloadDirUrl(info);
  const cacheKey = await computeElectronCacheKey(dirUrl);

  const sources: FlatpakSource[] = [];
  for (const arch of ELECTRON_ARCHES) {
    const url = electronBinaryUrl(info, arch.electron);
    const filename = info.buildMeta
      ? `electron-v${info.baseVersion}+${info.buildMeta}-linux-${arch.electron}.zip`
      : `electron-v${info.baseVersion}-linux-${arch.electron}.zip`;

    try {
      const sha256 = await fetchSha256(url);
      sources.push({
        type: "file",
        url,
        sha256,
        dest: `electron-cache/${cacheKey}`,
        "dest-filename": filename,
        "only-arches": [arch.flatpak],
      });
    } catch (_err) {
      console.warn(
        `    Skipping ${filename}: binary not available for ${arch.electron}`
      );
    }
  }

  return sources;
}

export function nodeHeadersUrl(info: ElectronInfo): string {
  return `https://artifacts.electronjs.org/headers/dist/v${info.baseVersion}/node-v${info.baseVersion}-headers.tar.gz`;
}

export async function nodeHeadersSource(
  info: ElectronInfo
): Promise<FlatpakSource> {
  const url = nodeHeadersUrl(info);
  const sha256 = await fetchSha256(url);

  return {
    type: "archive",
    url,
    sha256,
    dest: "electron-headers",
    "strip-components": 1,
  };
}

export async function generateElectronSources(
  packagesMap: Record<string, any[]>
): Promise<FlatpakSource[]> {
  const detected = detectElectronPackage(packagesMap);
  if (!detected) return [];

  if (detected.type === "git") {
    console.log(
      `Detected Electron git dependency: ${detected.owner}/${detected.repo}@${detected.commit}`
    );
  } else {
    console.log(
      `Detected Electron npm dependency: electron@${detected.version}`
    );
  }

  const info = await resolveElectronInfo(detected);

  console.log(
    `  Electron version: ${info.fullVersion} (base: ${info.baseVersion})`
  );

  const sources: FlatpakSource[] = [];

  console.log(`  Fetching electron binary zip hashes...`);
  const binarySources = await electronBinarySources(info);
  sources.push(...binarySources);
  for (const src of binarySources) {
    console.log(`    ${src["dest-filename"]} (${src["only-arches"]}) OK`);
  }

  console.log(`  Fetching node headers hash...`);
  const headers = await nodeHeadersSource(info);
  sources.push(headers);
  console.log(`    node-v${info.baseVersion}-headers.tar.gz OK`);

  return sources;
}

export async function main(
  lockPath: string,
  outputPath: string = "generated-sources.json",
  options: {
    allOs?: boolean;
    noDev?: boolean;
    registry?: string;
  } = {}
): Promise<void> {
  const { allOs = false, noDev = false, registry = "https://registry.npmjs.org" } = options;
  const registryUrl = registry.replace(/\/$/, "");

  const lockText = readFileSync(lockPath, "utf-8");
  const lock = parseBunLockfile(lockText);

  const devPackageNames = noDev
    ? collectDevDependencyNames(lock.workspaces, lock.packages)
    : new Set<string>();
  const filteredPackagesMap = noDev
    ? filterPackagesMap(lock.packages, devPackageNames)
    : lock.packages;

  const packages = extractPackages(filteredPackagesMap, {
    allOs,
    noDev,
    devPackageNames,
  });

  console.log(`Processing ${packages.length} packages from ${lockPath}...`);

  const sourceArrays = packages.map((pkg) =>
    npmPkgToFlatpakSources(pkg, registryUrl)
  );

  const flatpakSources: FlatpakSource[] = sourceArrays.flat();

  const gitPackages = extractGitPackages(filteredPackagesMap);
  if (gitPackages.length > 0) {
    console.log(
      `Fetching hashes for ${gitPackages.length} git dependencies...`
    );
    for (const gitPkg of gitPackages) {
      const url = `https://github.com/${gitPkg.owner}/${gitPkg.repo}/archive/${gitPkg.commit}.tar.gz`;
      try {
        const hash = await fetchSha256(url);
        flatpakSources.push(gitPkgToFlatpakSource(gitPkg, hash));
        console.log(`  ${gitPkg.owner}/${gitPkg.repo}@${gitPkg.commit} OK`);
      } catch (err: any) {
        console.error(
          `  Failed to fetch hash for ${gitPkg.owner}/${gitPkg.repo}@${gitPkg.commit}: ${err.message}`
        );
      }
    }
  }

  const electronSources = await generateElectronSources(filteredPackagesMap);
  flatpakSources.push(...electronSources);

  writeFileSync(outputPath, JSON.stringify(flatpakSources, null, 2) + "\n");
  const electronCount = electronSources.length;
  console.log(
    `Wrote ${flatpakSources.length} sources (${packages.length} npm + ${gitPackages.length} git + ${electronCount} electron) to ${outputPath}`
  );
}

export function parseCliArgs(args: string[]): CliOptions {
  let outputPath = "generated-sources.json";
  let registry = "https://registry.npmjs.org";
  let allOs = false;
  let noDev = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--output") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --output");
      }
      outputPath = value;
      i++;
      continue;
    }

    if (arg === "--registry") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --registry");
      }
      registry = value;
      i++;
      continue;
    }

    if (arg === "--all-os") {
      allOs = true;
      continue;
    }

    if (arg === "--no-devel") {
      noDev = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length !== 1) {
    throw new Error(
      positional.length === 0
        ? "Missing lockfile path"
        : `Unexpected positional arguments: ${positional.slice(1).join(", ")}`
    );
  }

  return {
    lockPath: positional[0],
    outputPath,
    allOs,
    noDev,
    registry,
  };
}

if (import.meta.main || process.argv[1]?.endsWith("main.ts")) {
  const args = process.argv.slice(2);
  let cliOptions: CliOptions;

  try {
    cliOptions = parseCliArgs(args);
  } catch (err: any) {
    console.error(
      `Usage: flatpak-bun-generator <path-to-bun.lock> [--output <file>] [--all-os] [--no-devel] [--registry <url>]`
    );
    console.error(err.message);
    process.exit(1);
  }

  main(cliOptions.lockPath, cliOptions.outputPath, {
    allOs: cliOptions.allOs,
    noDev: cliOptions.noDev,
    registry: cliOptions.registry,
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
