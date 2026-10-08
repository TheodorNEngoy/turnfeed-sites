// Database connection and pool policy. Callers supply environment and app name;
// this module never reads process.env, opens a connection, or initializes a store.
import { readEnv, isLocalHostname } from "./runtime-config.mjs";

const DB_LOCK_TIMEOUT_MS = 3_000;
const DB_STATEMENT_TIMEOUT_MS = 15_000;
const DB_QUERY_TIMEOUT_MS = 20_000;
const DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
const DB_KEEP_ALIVE_INITIAL_DELAY_MS = 10_000;

function buildConnectionStringFromParts(parts = {}) {
  const host = String(parts.host ?? "").trim();
  const user = String(parts.user ?? "").trim();
  const password = String(parts.password ?? "").trim();
  const database = String(parts.database ?? "").trim();
  const port = String(parts.port ?? "5432").trim() || "5432";
  if (!host || !user || !database) return "";
  const url = new URL("postgresql://localhost");
  url.hostname = host;
  url.port = port;
  url.username = user;
  if (password) url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export function resolveDatabaseConnectionConfig(env = {}) {
  const directCandidates = [
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_INTERNAL_URL",
    "POSTGRES_PRISMA_URL",
    "RENDER_POSTGRES_INTERNAL_URL",
  ];
  for (const key of directCandidates) {
    const value = readEnv(env, key);
    if (value) return { connectionString: value, source: key };
  }

  const host = readEnv(env, "PGHOST") || readEnv(env, "POSTGRES_HOST");
  const port = readEnv(env, "PGPORT") || readEnv(env, "POSTGRES_PORT") || "5432";
  const user = readEnv(env, "PGUSER") || readEnv(env, "POSTGRES_USER");
  const password = readEnv(env, "PGPASSWORD") || readEnv(env, "POSTGRES_PASSWORD");
  const database =
    readEnv(env, "PGDATABASE") || readEnv(env, "POSTGRES_DATABASE") || readEnv(env, "POSTGRES_DB");
  const connectionString = buildConnectionStringFromParts({ host, port, user, password, database });
  if (connectionString) {
    return {
      connectionString,
      source: "PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE",
    };
  }

  return { connectionString: "", source: "" };
}

function sslModeFromConnectionString(connectionString = "") {
  try {
    return String(new URL(connectionString).searchParams.get("sslmode") || "").trim().toLowerCase();
  } catch {}
  return "";
}

export function stripConnectionStringSslMode(connectionString = "") {
  const raw = String(connectionString || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("sslmode")) return raw;
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {}
  return raw;
}

export function isRenderRuntime(env = {}) {
  return readEnv(env, "RENDER").toLowerCase() === "true"
    || Boolean(readEnv(env, "RENDER_SERVICE_ID"))
    || Boolean(readEnv(env, "RENDER_SERVICE_NAME"));
}

function isLikelyRenderPrivateDatabaseHost(hostname = "") {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (!host || isLocalHostname(host)) return false;
  if (host.endsWith(".internal")) return true;
  return !host.includes(".");
}

function databaseHostAllowsPlaintext(env = {}, hostname = "") {
  if (isLocalHostname(hostname)) return true;
  return isRenderRuntime(env) && isLikelyRenderPrivateDatabaseHost(hostname);
}

export function resolveDatabaseSslConfig(env = {}, connectionString = "") {
  const sslMode = readEnv(env, "PGSSLMODE").toLowerCase() || sslModeFromConnectionString(connectionString);
  let hostname = "";
  try {
    hostname = connectionString ? new URL(connectionString).hostname : "";
  } catch {}
  if (sslMode === "disable" || sslMode === "allow" || sslMode === "prefer") {
    return databaseHostAllowsPlaintext(env, hostname) ? undefined : { rejectUnauthorized: true };
  }
  if (sslMode === "require" || sslMode === "no-verify") return { rejectUnauthorized: false };
  if (sslMode === "verify-ca" || sslMode === "verify-full") return { rejectUnauthorized: true };
  if (!connectionString) return undefined;
  if (databaseHostAllowsPlaintext(env, hostname)) return undefined;
  return { rejectUnauthorized: true };
}

export function buildDatabaseConnectionAttempts(connectionString = "", sslConfig = undefined) {
  if (!connectionString) return [];
  return [{ label: sslConfig ? "ssl" : "plain", ssl: sslConfig }];
}

function databaseApplicationName(env, appName) {
  const configured = readEnv(env, "TURNFEED_DB_APPLICATION_NAME")
    || readEnv(env, "RENDER_SERVICE_NAME")
    || appName;
  return String(configured || "turnfeed")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "turnfeed";
}

export function buildDatabasePoolOptions(
  connectionString = "",
  ssl = undefined,
  env = {},
  appName = "Turnfeed"
) {
  return {
    connectionString,
    ssl,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: DB_KEEP_ALIVE_INITIAL_DELAY_MS,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    query_timeout: DB_QUERY_TIMEOUT_MS,
    application_name: databaseApplicationName(env, appName),
  };
}
