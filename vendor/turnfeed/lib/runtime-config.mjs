// Shared configuration parsing only; importing this module performs no I/O.

export function readEnv(env, key) {
  return String(env?.[key] ?? "").trim();
}

export function readEnvFlag(env, key, defaultValue = false) {
  const raw = readEnv(env, key).toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return Boolean(defaultValue);
}

export function isLocalHostname(hostname) {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
}
