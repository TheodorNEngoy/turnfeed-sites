// Build-time extraction only. The original server has process and filesystem side effects.
// Preserve reachable declarations, replace explicit platform boundaries, omit top-level effects.
import { parse } from 'acorn';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { adaptThreadRead } from './thread-read-adapter.mjs';
import { adaptCreatePostReceipt } from './create-post-adapter.mjs';
import { adaptAvatars } from './avatar-adapter.mjs';
import { adaptSocialProjection, adaptSocialOutputSchemas } from './social-projection-adapter.mjs';
import { adaptPrivateAccounts, adaptPrivateSchemaDescriptions, privateAccountHelpers, privateAccountApi } from './private-accounts-adapter.mjs';
import { profileConnectionsHelpers, profileConnectionsApi } from './profile-connections-adapter.mjs';

const source = readFileSync(new URL('../vendor/turnfeed/server.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const overrides = JSON.parse(readFileSync(new URL('./core-overrides.json', import.meta.url), 'utf8'));
const declarations = new Map();
const imports = new Map();
function bindings(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'Property') return bindings(node.value);
  if (node.type === 'RestElement') return bindings(node.argument);
  if (node.type === 'AssignmentPattern') return bindings(node.left);
  return (node.properties || node.elements || []).flatMap(bindings);
}
for (const node of ast.body) {
  if (node.type === 'ImportDeclaration') {
    for (const specifier of node.specifiers) imports.set(specifier.local.name, { node, specifier });
  } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    declarations.set(node.id.name, { node, text: source.slice(node.start, node.end), names: [node.id.name] });
  } else if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) {
      const entry = { node: d, text: `${node.kind} ${source.slice(d.start, d.end)};`, names: bindings(d.id) };
      for (const name of entry.names) declarations.set(name, entry);
    }
  }
}
function identifiers(node, result = new Set(), parent = null, key = '') {
  if (!node || typeof node !== 'object') return result;
  if (node.type === 'Identifier') {
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return result;
    if (parent?.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) return result;
    result.add(node.name);
  }
  for (const [k, value] of Object.entries(node)) {
    if (k === 'start' || k === 'end') continue;
    if (Array.isArray(value)) value.forEach(child => identifiers(child, result, node, k));
    else if (value && typeof value === 'object') identifiers(value, result, node, k);
  }
  return result;
}

const roots = ['createSocialServer', 'applyStore', 'buildInitialStore', 'buildStoreSnapshot',
  'rateState', 'recentRequests', 'recentSocialSignalSuccesses', 'pendingProfileUpdates',
  'publicWriteConfirmationClaims', 'TURNFEED_MCP_INSTRUCTIONS', 'buildAdminReportsJsonExport',
  'adminModerationHistoryExport', 'buildAdminPostVisibilityActionResult', 'buildAdminReplyVisibilityActionResult',
  'clearUserAccountData', 'eraseOwnerWriteReceipts', 'displayNameForUserId',
  'handleMuteUser', 'handleUpdateSettings', 'getNotificationPrefs', 'getHiddenWords', 'getMuteList',
  'relationshipTargetForViewer', 'relationshipTargetMatchesReadableLabel', 'getUserId', 'getCallerKey', 'mcpAuthorizationError'];
const selected = new Set();
const imported = new Set();
function include(name) {
  if (selected.has(name) || imported.has(name)) return;
  if (Object.hasOwn(overrides, name)) {
    selected.add(name);
    const code = parse(overrides[name], { ecmaVersion: 'latest', sourceType: 'module' });
    for (const ref of identifiers(code)) if (ref !== name) include(ref);
  } else if (declarations.has(name)) {
    const entry = declarations.get(name);
    entry.names.forEach(n => selected.add(n));
    for (const ref of identifiers(entry.node)) if (!entry.names.includes(ref)) include(ref);
  } else if (imports.has(name)) imported.add(name);
}
roots.forEach(include);
const groupedImports = new Map();
for (const name of imported) {
  const { node, specifier } = imports.get(name);
  const path = node.source.value;
  if (!groupedImports.has(path)) groupedImports.set(path, []);
  groupedImports.get(path).push(source.slice(specifier.start, specifier.end));
}
console.log('Runtime imports:', [...groupedImports.keys()].join(', '));
const allowedModules = new Set(['node:crypto', 'node:async_hooks', 'node:net', 'zod']);
const importLines = [...groupedImports].map(([path, names]) => {
  if (!path.startsWith('./lib/') && !allowedModules.has(path)) throw new Error(`Unadapted runtime dependency: ${path} (${names.join(', ')})`);
  const destination = path === './lib/public-write-receipts.mjs' ? './public-write-receipts.mjs' : path === './lib/mcp-schemas.mjs' ? './mcp-schemas.generated.mjs' : path === './lib/feed-presentation.mjs' ? './feed-presentation.mjs' : path === './lib/moderation-history.mjs' ? './moderation-history.mjs'
    : path.startsWith('./lib/') ? `../vendor/turnfeed/${path.slice(2)}` : path;
  const statement = names.some(n => n.startsWith('*')) ? names.join(', ') : `{ ${names.join(', ')} }`;
  return `import ${statement} from ${JSON.stringify(destination)};`;
});
const emitted = new Set();
const lines = [];
for (const [name, entry] of declarations) {
  if (!selected.has(name) || emitted.has(entry)) continue;
  emitted.add(entry);
  let text = Object.hasOwn(overrides, name) ? overrides[name] : entry.text;
  if (name === 'createSocialServer') text = adaptCreatePostReceipt(text);
  if (name === 'buildThreadContextForTool') text = adaptThreadRead(text);
  text = adaptAvatars(name, text);
  text = adaptSocialProjection(name, text);
  text = adaptPrivateAccounts(name, text);
  if (name === 'contentQualityIssue') {
    const anchor = '  if (!cleanText) return "Missing text.";';
    if (text.split(anchor).length !== 2) throw new Error('Native abuse-check insertion point changed.');
    text = text.replace(anchor, `${anchor}
  const nativeAbuse = nativeAbuseIssue({ posts, text: cleanText, kind, userId, targetPostId, excludeId });
  if (nativeAbuse) return nativeAbuse;`);
  }
  if (name === 'buildTurnfeedAgentProtocolBrief') text = text.replace(
    'Turnfeed resolves the connected account from verified OAuth sign-in through Auth0.',
    'Turnfeed resolves the connected account from the authenticated ChatGPT user supplied by Sites.'
  ).replace('The user chooses their public display name and handle with set_profile.', 'ChatGPT may provide an initial account name for an unnamed profile; it can differ from the public ChatGPT profile name. Users can change or clear their Turnfeed name and choose a handle with set_profile. Chosen names are preserved.');
  if (name === 'buildTurnfeedAgentProtocolForTool') text = text.replace(
    'Use read-only tools until the user asks for a public mutation.',
    'Use read-only tools until the user explicitly asks to change Turnfeed data.'
  );
  if (name === 'handleMuteUser') {
    text = text.replace('resolutionCallerKey = callerKey })', 'resolutionCallerKey = callerKey, targetLabel, requireReadableTarget = false })')
      .replace('if (targetId === userId)', `if (requireReadableTarget && !relationshipTargetMatchesReadableLabel(targetLabel, targetId, userId)) return { ok: false, code: 'target_mismatch', message: 'The selected person does not match the name shown. Read their profile or your muted list again before retrying.' };
  if (targetId === userId)`);
  }
  if (name === 'handleUpdateSettings') {
    // Desired-state settings are already idempotent. Payload-only deduplication
    // would incorrectly suppress A -> B -> A changes made within five seconds.
    text = text.replace(/  const duplicatePayload = \{ notificationPrefs, hiddenWords \};\n  if \(isRecentDuplicate\("update_settings", callerKey, duplicatePayload, 5_000\)\) \{\n    return \{ ok: true, message: "" \};\n  \}\n/, '')
      .replace('    forgetRecentDuplicate("update_settings", callerKey, duplicatePayload);\n', '');
  }
  lines.push(text);
}
for (const name of selected) if (!declarations.has(name) && Object.hasOwn(overrides, name)) lines.unshift(overrides[name]);
const header = `// GENERATED by scripts/extract-core.mjs. Edit explicit adapters, then regenerate.\n// Retained source SHA256 ${createHash('sha256').update(source).digest('hex')}\n`;
const footer = `
  ${privateAccountHelpers}
  ${profileConnectionsHelpers}
  applyStore(runtime.snapshot || buildInitialStore(), { force: true });
  createSocialServer({ serverOverride: registry, mcpWriteCallerKey: runtime.callerKey || '', modernMcp: false });
  return {
    instructions: TURNFEED_MCP_INSTRUCTIONS,
    tools,
    ${privateAccountApi}
    ${profileConnectionsApi}
    accountData: userId => buildAccountExportResponse(userId, { includeViewerToken: false }),
    activityEvents: userId => buildNotifications(userId).sort(compareNewDescByCreatedAtThenId).slice(0, 20).map(({ id, createdAt }) => ({ id, createdAt })),
    privatePreferences: {
      identity: ctx => ({ userId: getUserId(ctx), callerKey: getCallerKey(ctx) }),
      authorizationError: ctx => mcpAuthorizationError(ctx),
      read: userId => ({ notificationPrefs: getNotificationPrefs(userId), hiddenWords: getHiddenWords(userId), mutedUserIds: getMuteList(userId) }),
      member: (targetId, viewerId) => relationshipTargetForViewer(targetId, viewerId),
      update: args => mutateStore(() => handleUpdateSettings(args)),
      mute: args => mutateStore(() => handleMuteUser({ ...args, requireReadableTarget: true })),
    },
    hasProfileName: userId => Boolean(profiles[userId]?.displayName || profiles[userId]?.handle),
    initializeProfileName: (userId, fullName) => mutateStore(() => {
      if (!userId || profiles[userId]?.displayName || profiles[userId]?.handle) return false;
      if (/\\S+@\\S+\\.\\S+/.test(String(fullName || ''))) return false;
      const displayName = cleanDisplayName(fullName);
      if (/\\S+@\\S+\\.\\S+/.test(displayName)) return false;
      if (!displayName || reservedDisplayNameMessage(displayName) || publicProfileTextSafetyIssue(displayName)) return false;
      return storeProfileRecord(userId, { ...normalizeProfile(profiles[userId]), displayName, updatedAt: nowIso() });
    }),
    operator: {
      reports: () => buildAdminReportsJsonExport(),
      history: () => adminModerationHistoryExport(),
      users: () => [...new Set([...users, ...Object.keys(profiles)])].map(userId => ({userId, displayName: displayNameForUserId(userId), handle: profiles[userId]?.handle || ''})),
      setPostHidden: input => mutateStore(() => buildAdminPostVisibilityActionResult(input)),
      setReplyHidden: input => mutateStore(() => buildAdminReplyVisibilityActionResult(input)),
      eraseAccount: userId => mutateStore(() => { clearUserAccountData(userId); writeReceipts = eraseOwnerWriteReceipts(writeReceipts, userId); return {ok: true}; }),
    },
    snapshot() { return buildStoreSnapshot(); },
    controls() { return {
      rateState: [...rateState].map(([k, v]) => [k, [...v]]),
      recentRequests: [...recentRequests], recentSocialSignalSuccesses: [...recentSocialSignalSuccesses],
      pendingProfileUpdates: [...pendingProfileUpdates], publicWriteConfirmationClaims: [...publicWriteConfirmationClaims],
    }; },
  };
}
`;
mkdirSync(new URL('../worker', import.meta.url), { recursive: true });
let schemas = readFileSync(new URL('../vendor/turnfeed/lib/mcp-schemas.mjs', import.meta.url), 'utf8');
for (const name of ['threadQuote', 'threadPost', 'threadReply', 'feedReplyPreview', 'feedQuotePreview', 'feedDigestItem', 'inboxNotification']) {
  const anchor = `const ${name}OutputSchema = z.object({`;
  if (schemas.split(anchor).length !== 2) throw new Error(`Avatar output schema changed: ${name}`);
  const field = name === 'inboxNotification' ? 'actorAvatarUrl' : 'authorAvatarUrl';
  schemas = schemas.replace(anchor, `${anchor}\n  ${field}: z.string().max(MAX_AVATAR_URL_CHARS).optional(),`);
}
schemas = adaptSocialOutputSchemas(schemas);
schemas = adaptPrivateSchemaDescriptions(schemas);
writeFileSync(new URL('../worker/mcp-schemas.generated.mjs', import.meta.url), '// GENERATED by scripts/extract-core.mjs from retained schemas with native avatar and social output fields.\n' + schemas);
writeFileSync(new URL('../worker/core.generated.mjs', import.meta.url), header + importLines.join('\n') + `
import { Buffer } from 'node:buffer';
import { nativeAbuseIssue } from './abuse.mjs';
export function createTurnfeedCore(runtime) {
  const process = { env: runtime.config || {}, stderr: { write() {} } };
  const tools = new Map();
  const registry = { registerTool(name, descriptor, handler) { tools.set(name, { descriptor, handler }); } };
` + lines.join('\n\n') + footer);
writeFileSync(new URL('../worker/extraction-manifest.json', import.meta.url), JSON.stringify({
  sourceCommit: '1e1aa821f983f4e8234a16f68fe15915dc5aef26',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  declarations: [...selected].sort(), imports: [...groupedImports.keys()], overrides: Object.keys(overrides).sort(),
}, null, 2) + '\n');
console.log(`Extracted ${selected.size} declarations with ${Object.keys(overrides).length} explicit platform adapters.`);
