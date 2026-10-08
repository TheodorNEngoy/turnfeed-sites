import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

const v6Global = new BlockList();
v6Global.addSubnet("2000::", 3, "ipv6");
const v6Reserved = new BlockList();
for (const [address, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) v6Reserved.addSubnet(address, bits, "ipv6");
export function publicEventAddress(address, isPrivateIp) {
  const family = isIP(address);
  return family === 4 ? !isPrivateIp(address) : family === 6 && v6Global.check(address, "ipv6") && !v6Reserved.check(address, "ipv6") && !isPrivateIp(address);
}
export function validateEventCallback(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid callback URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("Invalid callback URL");
  return url.href;
}
export function decodeWebhookSecret(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("Invalid signing secret");
  const raw = secret.slice(6);
  const key = Buffer.from(raw, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) throw new Error("Invalid signing secret");
  return key;
}
const encryptionKey = (pepper) => {
  if (typeof pepper !== "string" || pepper.length < 32) throw new Error("Events encryption key unavailable");
  return createHmac("sha256", pepper).update("turnfeed-mcp-events-secrets-v1").digest();
};
export function encryptWebhookSecret(secret, pepper) {
  decodeWebhookSecret(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(pepper), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["ev1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
export function decryptWebhookSecret(secret, pepper) {
  const [version, iv, tag, body, extra] = String(secret).split(".");
  if (version !== "ev1" || extra || !iv || !tag || !body) throw new Error("Invalid stored signing secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(pepper), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const value = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  decodeWebhookSecret(value);
  return value;
}
export function signWebhook(body, eventId, secret, timestamp) {
  return `v1,${createHmac("sha256", decodeWebhookSecret(secret)).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`;
}

// Resolve afresh per connection and connect to the checked IP. The URL hostname
// is retained for both SNI and certificate verification. Redirects never follow.
export function createEventWebhookClient({ resolvePublicAddresses, isPrivateIp, transport = httpsRequest, timeoutMs = 10_000 }) {
  return async function send({ url: callback, id, subscriptionId, body, secrets, now = Date.now(), authorizeDelivery = async () => true }) {
    const url = new URL(validateEventCallback(callback));
    const bytes = Buffer.byteLength(body);
    if (bytes > 256 * 1024) throw new Error("Event payload too large");
    const deadline = Date.now() + Math.min(10_000, timeoutMs);
    const beforeDeadline = async (operation) => {
      let timer;
      try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Callback timeout")), Math.max(0, deadline - Date.now())); })]); }
      finally { clearTimeout(timer); }
    };
    const addresses = await beforeDeadline(() => resolvePublicAddresses(url.hostname));
    if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !publicEventAddress(entry.address, isPrivateIp))) throw new Error("Blocked callback address");
    if (!(await beforeDeadline(authorizeDelivery))) throw new Error("Event delivery cancelled");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Callback timeout");
    const address = addresses[0];
    const timestamp = Math.floor(now / 1000);
    return await new Promise((resolve, reject) => {
      let response;
      let timer;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const req = transport({ protocol: "https:", hostname: address.address, family: isIP(address.address), port: 443,
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ""), certificate),
        rejectUnauthorized: true, agent: false, method: "POST", path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, "Content-Type": "application/json", "Content-Length": bytes,
          "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": secrets.map((secret) => signWebhook(body, id, secret, timestamp)).join(" "), "X-MCP-Subscription-Id": subscriptionId },
      }, (res) => {
        response = res;
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16_384) { res.destroy(); req.destroy(); finish(new Error("Callback response too large")); }
          else chunks.push(chunk);
        });
        res.once("error", () => finish(new Error("Callback response failed")));
        res.once("aborted", () => finish(new Error("Callback response aborted")));
        res.once("end", () => finish(null, { status: Number(res.statusCode), body: Buffer.concat(chunks).toString("utf8") }));
      });
      timer = setTimeout(() => { response?.destroy(); req.destroy(); finish(new Error("Callback timeout")); }, remaining);
      req.once("error", () => finish(new Error("Callback connection failed")));
      req.end(body);
    });
  };
}
export async function verifyEventCallback(send, { url, id, secret }) {
  const challenge = randomBytes(32).toString("hex");
  const response = await send({ url, id: `verification_${randomBytes(16).toString("hex")}`, subscriptionId: id, body: JSON.stringify({ type: "verification", challenge }), secrets: [secret] });
  if (response.status < 200 || response.status >= 300) return false;
  let echoed;
  try { echoed = JSON.parse(response.body)?.challenge; } catch { return false; }
  return typeof echoed === "string" && Buffer.byteLength(echoed) === Buffer.byteLength(challenge) && timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
}
