import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const LOCAL_RUNTIME_EVIDENCE_SCHEMA = "turnfeed-local-runtime-evidence-v1";
export const LOCAL_SOURCE_MANIFEST_SCHEMA = "turnfeed-local-source-manifest-v1";

// An explicit set catches files omitted from BOTH a copied runtime and its
// manifest. Additions to the shipped runtime must update this list deliberately.
export const LOCAL_RUNTIME_SOURCE_PATHS = Object.freeze([
  "compat/candidate-turnfeed-v4-input-schema-hashes.json",
  "compat/published-turnfeed-v2-catalog.json",
  "lib/database-config.mjs",
  "lib/feed-presentation.mjs",
  "lib/feed-time-range.mjs",
  "lib/local-runtime-evidence.mjs",
  "lib/mcp-schemas.mjs",
  "lib/mcp-events-state.mjs",
  "lib/mcp-events-webhook.mjs",
  "lib/mcp-events-service.mjs",
  "lib/mcp-events-transport.mjs",
  "lib/moderation-history.mjs",
  "lib/operator-erasure.mjs",
  "lib/public-pages.mjs",
  "lib/public-write-receipts.mjs",
  "lib/request-timing.mjs",
  "lib/runtime-config.mjs",
  "package-lock.json",
  "package.json",
  "public/openai-apps-challenge.txt",
  "public/turnfeed-app-confirm-post.png",
  "public/turnfeed-app-read-feed.png",
  "public/turnfeed-app-thread-context.png",
  "public/turnfeed-dev-app-icon.png",
  "public/turnfeed-directory-icon-dark-192.png",
  "public/turnfeed-directory-icon-dark.png",
  "public/turnfeed-directory-icon-light-192.png",
  "public/turnfeed-directory-icon-light.png",
  "public/turnfeed-directory-screenshot-1.png",
  "public/turnfeed-favicon-192.png",
  "public/turnfeed-favicon-transparent.png",
  "public/turnfeed-logo-180.png",
  "public/turnfeed-logo-192.png",
  "public/turnfeed-logo.png",
  "public/turnfeed-widget-v2.html",
  "public/turnfeed-widget.html",
  "server.js",
  "turnfeed-widget.html",
].sort());

const SOURCE_DIRECTORIES = ["lib", "compat", "public"];
const SOURCE_ROOT_FILES = LOCAL_RUNTIME_SOURCE_PATHS.filter((path) => !path.includes("/"));
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (reason) => { throw new Error(`Local OAuth runtime refused: ${reason}`); };
function optionalStat(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function resolveLocalOAuthRuntimeConfig({ env = process.env, publicOrigin, port, oauthConfigured, testNoAuthEnabled = false }) {
  const localKeys = ["TURNFEED_LOCAL_OAUTH", "TURNFEED_LISTEN_HOST", "TURNFEED_LOCAL_SOURCE_MANIFEST"];
  if (!localKeys.some((key) => own(env, key))) return null;
  if (env.TURNFEED_LOCAL_OAUTH !== "1") fail("explicit TURNFEED_LOCAL_OAUTH=1 is required");
  if (env.TURNFEED_LISTEN_HOST !== "127.0.0.1") fail("TURNFEED_LISTEN_HOST must be 127.0.0.1");
  if (!["test", "development"].includes(env.NODE_ENV) || env.TURNFEED_TEST_SAFE !== "1") {
    fail("development/test mode and TURNFEED_TEST_SAFE=1 are required");
  }
  // Presence is rejected, including empty cloud/database markers: the launcher
  // must start with a deliberately isolated environment, not inherited hosting.
  if (Object.keys(env).some((key) => /^(?:RENDER(?:_|$)|FLY_|DATABASE_|POSTGRES_|PG[A-Z_]+$|TURNFEED_DB_)/.test(key)
    || key === "TURNFEED_REQUIRE_POSTGRES" || key === "TURNFEED_TEST_POSTGRES_URL")) {
    fail("cloud and database configuration must be absent");
  }
  if (testNoAuthEnabled || !oauthConfigured || Object.keys(env).some((key) =>
    /NOAUTH/.test(key) && !["", "0", "false"].includes(String(env[key]).toLowerCase()))) {
    fail("configured OAuth is required and no-auth bypasses must be disabled");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || publicOrigin !== `http://127.0.0.1:${port}` || env.PUBLIC_ORIGIN !== publicOrigin) {
    fail("PUBLIC_ORIGIN must exactly match the loopback HTTP listener");
  }
  const manifestPath = env.TURNFEED_LOCAL_SOURCE_MANIFEST;
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) fail("an absolute source manifest path is required");
  return Object.freeze({ host: "127.0.0.1", publicOrigin, manifestPath });
}

function requireRegularFile(path, maxBytes = MAX_SOURCE_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxBytes) fail("source files must be bounded regular files, without symlinks");
  return stat;
}

function discoveredSourcePaths(runtimeRoot) {
  const paths = [...SOURCE_ROOT_FILES];
  function walk(relative) {
    const absolute = join(runtimeRoot, relative);
    if (!lstatSync(absolute).isDirectory()) fail("source directories must be regular directories, without symlinks");
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) paths.push(child);
      else fail("source symlinks and special files are forbidden");
    }
  }
  for (const directory of SOURCE_DIRECTORIES) walk(directory);
  // Operator JSON manifests/data are allowed; extra executable entrypoints,
  // package-manager hooks/config and alternate dependency locks are not.
  for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (/\.(?:[cm]?js|html|node)$/.test(entry.name) || /^(?:\.npmrc|\.pnp\..*|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(entry.name)) {
      if (!SOURCE_ROOT_FILES.includes(entry.name)) fail("unexpected top-level runtime source");
    }
  }
  return paths.sort();
}

function assertIsolatedRuntimeDirectory(runtimeRoot) {
  if (optionalStat(join(runtimeRoot, ".git"))) fail("use a separate copied runtime, not a Git checkout");
  const dataPath = join(runtimeRoot, "data");
  const dataStat = optionalStat(dataPath);
  if (dataStat && !dataStat.isDirectory()) fail("the local data directory must not be a symlink");
  for (const name of ["store.json", "admin.key"]) {
    const path = join(dataPath, name);
    const stat = optionalStat(path);
    if (stat && (!stat.isFile() || stat.nlink !== 1)) fail("local data files must be separate regular files");
  }
}

// This verifies copied bytes. Git/CI authority remains the launcher's job: it
// must obtain these hashes from the pinned Git objects and independently compare
// commit, tree and manifest hash when consuming the evidence endpoint.
export function verifyLocalRuntimeSourceManifest({ runtimeRoot, manifestPath }) {
  const root = realpathSync(runtimeRoot);
  assertIsolatedRuntimeDirectory(root);
  requireRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!manifest || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(",") !== "files,schemaVersion,sourceCommitSha,sourceTreeSha"
    || manifest.schemaVersion !== LOCAL_SOURCE_MANIFEST_SCHEMA
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceCommitSha || "")
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceTreeSha || "")
    || manifest.sourceCommitSha.length !== manifest.sourceTreeSha.length
    || !Array.isArray(manifest.files)
    || manifest.files.length !== LOCAL_RUNTIME_SOURCE_PATHS.length) {
    fail("invalid complete source manifest");
  }
  if (JSON.stringify(discoveredSourcePaths(root)) !== JSON.stringify(LOCAL_RUNTIME_SOURCE_PATHS)) {
    fail("runtime source file set does not match the expected complete set");
  }
  let totalBytes = 0;
  for (const [index, expectedPath] of LOCAL_RUNTIME_SOURCE_PATHS.entries()) {
    const entry = manifest.files[index];
    if (!entry || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "path,sha256"
      || entry.path !== expectedPath || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) {
      fail("source manifest files must exactly match the sorted expected set");
    }
    const path = join(root, expectedPath);
    totalBytes += requireRegularFile(path).size;
    if (totalBytes > MAX_SOURCE_BYTES || sha256(readFileSync(path)) !== entry.sha256) {
      fail("source bytes do not match the launch manifest");
    }
  }
  return Object.freeze({
    sourceCommitSha: manifest.sourceCommitSha,
    sourceTreeSha: manifest.sourceTreeSha,
    sourceManifestSha256: sha256(manifestBytes),
    sourceFileCount: manifest.files.length,
  });
}

export function createLocalRuntimeEvidenceReader({ runtimeRoot, config }) {
  const launchSource = verifyLocalRuntimeSourceManifest({ runtimeRoot, manifestPath: config.manifestPath });
  return () => {
    try {
      const currentSource = verifyLocalRuntimeSourceManifest({ runtimeRoot, manifestPath: config.manifestPath });
      if (currentSource.sourceManifestSha256 !== launchSource.sourceManifestSha256) fail("launch manifest changed");
      return {
        ok: true,
        schemaVersion: LOCAL_RUNTIME_EVIDENCE_SCHEMA,
        provenance: "isolated-local-source-manifest",
        ...launchSource,
        runtimeSourceVerified: true,
        sourceMetadataAuthority: "launcher-attested",
        publicOrigin: config.publicOrigin,
      };
    } catch {
      return { ok: false, schemaVersion: LOCAL_RUNTIME_EVIDENCE_SCHEMA, code: "local_runtime_source_unverified" };
    }
  };
}
