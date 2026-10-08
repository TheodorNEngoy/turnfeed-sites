// Runs inside the extracted core so all reads use its actual viewer and privacy rules.
function nativeProfileConnections({ profileHandle, targetRef, kind }, viewerId) {
  const ownerId = resolveRelationshipTargetForViewer({ handle: profileHandle, targetRef }, viewerId);
  const unavailable = new Set(runtime.unavailableUserIds || []);
  const available = id => Boolean(id && !unavailable.has(id)
    && ((users || []).includes(id) || Object.hasOwn(profiles || {}, id)));
  if (!available(ownerId) || !nativeProfileVisible(viewerId, ownerId)
      || (profiles?.[ownerId]?.privateAccount && viewerId !== ownerId)) {
    return { ok: false, code: 'profile_unavailable', message: 'This profile’s connections are unavailable.' };
  }
  const person = id => {
    const profile = publicProfileForUserId(id, viewerId);
    return { displayName: profile.displayName, publicHandle: profile.publicHandle,
      ...(viewerId && profile.targetRef ? { targetRef: profile.targetRef } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}) };
  };
  const candidates = kind === 'following' ? getFollowList(ownerId)
    : Object.entries(follows || {}).filter(([, list]) => Array.isArray(list) && list.includes(ownerId)).map(([id]) => id);
  const ids = [...new Set(candidates)].filter(id => id !== ownerId && available(id)
    && !isBlockedEitherWay(ownerId, id) && viewerCanSeeUserContent(viewerId, id)).sort();
  const items = ids.map(person);
  return { ok: true, ownerId, items,
    profile: { ...person(ownerId), viewerIsSelf: viewerId === ownerId, privateAccount: profiles?.[ownerId]?.privateAccount === true },
    fingerprint: createHash('sha256').update(JSON.stringify(ids.map((id, index) => [id, items[index]]))).digest('hex') };
}

export const profileConnectionsHelpers = nativeProfileConnections.toString();
export const profileConnectionsApi = 'profileConnections: nativeProfileConnections,';
