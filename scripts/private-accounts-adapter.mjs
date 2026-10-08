// Explicit native privacy adaptation; the retained upstream source stays immutable.
function replace(text, from, to, name) {
  if (text.split(from).length !== 2) throw new Error(`Private-account adapter changed: ${name}`);
  return text.replace(from, to);
}

export function adaptPrivateAccounts(name, text) {
  const edit = (from, to) => { text = replace(text, from, to, name); };
  if (name === 'normalizeProfile') edit('  displayName:', '  privateAccount: p?.privateAccount === true,\n  followRequests: nativePrivateRequests(p?.followRequests),\n  displayName:');
  if (name === 'profileHasContent') edit('    profile.displayName ||', '    profile.privateAccount || profile.followRequests?.length || profile.displayName ||');
  if (name === 'handleSetProfile') edit('  const nextProfile = {', '  const nextProfile = {\n    privateAccount: existing.privateAccount,\n    followRequests: existing.followRequests,');
  if (name === 'viewerCanSeeUserContent') return `function viewerCanSeeUserContent(viewerUserId, authorId) {
    if (!nativeProfileVisible(viewerUserId, authorId)) return false;
    return !profiles?.[authorId]?.privateAccount || Boolean(viewerUserId && (viewerUserId === authorId || isFollowing(viewerUserId, authorId)));
  }`;
  if (['graphConnectorVisibleToPair', 'scorePeopleMatches', 'scoreAuthorNameMatches', 'buildFollowersResponse', 'countFollowersVisibleToViewer', 'cachedVisibleFollowerCountsByTarget'].includes(name)) {
    text = text.replaceAll('viewerCanSeeUserContent(', 'nativeProfileVisible(');
    if (name === 'buildFollowersResponse') edit('    if (!p || p.hidden) continue;', '    if (!p || p.hidden || !viewerCanSeeUserContent(viewerId, p.authorId)) continue;');
  }
  if (name === 'profileIdentityQualityScoreForViewer') edit('  if (!userId) return 0;', '  if (!userId || !viewerCanSeeUserContent(viewerUserId, userId)) return 0;');
  if (name === 'publicProfileForUserId') {
    edit('  const raw = profiles?.[targetUserId] ?? {};', `  const raw = profiles?.[targetUserId] ?? {};
  const privacy = nativeProfilePrivacy(targetUserId, viewerUserId);
  if (!privacy.viewerCanReadContent) return {
    ...relationshipTargetForViewer(targetUserId, viewerUserId), ...privacy,
    bio: '', websiteUrl: '', avatarUrl: '', joinedAt: '', identityLabel: 'Private account',
    viewerRelationshipLabel: '', followingCount: 0, followerCount: 0,
    viewerFollows: isFollowing(viewerUserId, targetUserId), viewerIsFollowedBy: false,
    viewerHasBlocked: isBlocking(viewerUserId, targetUserId), viewerHasMuted: isMuting(viewerUserId, targetUserId), viewerIsSelf: false,
  };`);
    edit('    displayName: displayNameForUserId(targetUserId),', '    ...privacy,\n    displayName: displayNameForUserId(targetUserId),');
  }
  if (name === 'discoveryProfileForUserId') edit('  const relationship = relationshipSignalsForUserId(targetUserId, viewerUserId, relationshipCache);', '  if (!profile.viewerCanReadContent) return profile;\n  const relationship = relationshipSignalsForUserId(targetUserId, viewerUserId, relationshipCache);');
  if (name === 'buildProfileContextForTool') {
    edit('      displayName: String(profile.displayName || ""),', '      ...nativeProfilePrivacy(targetUserId, viewerUserId),\n      displayName: String(profile.displayName || ""),');
    edit('  const counts = [', '  const counts = !profile.viewerCanReadContent ? "Private account · Approved followers only" : [');
    edit('    : "#### No visible posts yet";', '    : !profile.viewerCanReadContent ? "#### Follow request required to see posts" : "#### No visible posts yet";');
  }
  if (name === 'buildOpenSocialFocusProfilePreview') {
    edit('  const publicHandle = publicHandleForUserId(resolvedUserId);', '  const publicHandle = publicHandleForUserId(resolvedUserId);\n  const profile = publicProfileForUserId(resolvedUserId, viewerUserId);');
    edit('    bio: compactSnippet(profiles?.[resolvedUserId]?.bio, 160),', '    ...nativeProfilePrivacy(resolvedUserId, viewerUserId),\n    bio: compactSnippet(profile.bio, 160),');
    edit('    identityLabel: identityLabelForUserId(resolvedUserId),', '    identityLabel: profile.identityLabel,');
  }
  if (name === 'viewerProfileForUserId') edit('    id: userId,', '    id: userId,\n    ...nativeProfilePrivacy(userId, userId),');
  if (name === 'viewerToolProfileForUserId') edit('    displayName: String(raw?.displayName ?? "").trim(),', '    ...nativeProfilePrivacy(userId, userId),\n    displayName: String(raw?.displayName ?? "").trim(),');
  if (name === 'handleFollowUser') {
    edit('  const current = getFollowList(userId);', `  const privateFollowResult = nativePrivateFollow({ targetId, action, userId, callerKey, extraRateLimitResult });
  if (privateFollowResult) return privateFollowResult;
  const current = getFollowList(userId);`);
    edit('!already && current.length >= MAX_FOLLOWS', '!already && nativeOutboundFollowCount(userId) >= MAX_FOLLOWS');
  }
  if (name === 'handleBlockUser') edit('    if (!wantsUnblock) {', '    if (!wantsUnblock) {\n      nativeRemoveFollowRequest(userId, targetId);\n      nativeRemoveFollowRequest(targetId, userId);');
  if (name === 'clearUserAccountData') edit('  mcpEvents = eraseEventsOwners(mcpEvents, [userId]);', `  for (const owner of Object.keys(profiles || {})) nativeRemoveFollowRequest(owner, userId);
  mcpEvents = eraseEventsOwners(mcpEvents, [userId]);`);
  if (name === 'createPostQuoteSourceSupportIssue') edit('  if (String(post.groupId || "").trim()) {', `  if (profiles?.[post.authorId]?.privateAccount === true) return createPostQuoteSourceIssue('quote_source_not_supported', 'Private-account posts cannot be quoted. Choose a public source.');
  if (String(post.groupId || "").trim()) {`);
  if (name === 'buildNotifications') {
    // Follow identity is public; its content/extended identity remains protected.
    edit('    if (!viewerCanSeeUserContent(viewerUserId, e.actorId)) continue;\n    if (isMuting(viewerUserId, e.actorId)) continue;\n    const previous = latestFollowEventByActorId.get(e.actorId);', '    if (!nativeProfileVisible(viewerUserId, e.actorId)) continue;\n    if (isMuting(viewerUserId, e.actorId)) continue;\n    const previous = latestFollowEventByActorId.get(e.actorId);');
    edit('    actorAvatarUrl: normalizePublicProfileUrl(profiles?.[authorId]?.avatarUrl, MAX_AVATAR_URL_CHARS),', '    actorAvatarUrl: viewerCanSeeUserContent(viewerUserId, authorId) ? normalizePublicProfileUrl(profiles?.[authorId]?.avatarUrl, MAX_AVATAR_URL_CHARS) : "",');
    edit('    actorIdentityLabel: identityLabelForUserId(authorId),', '    actorIdentityLabel: viewerCanSeeUserContent(viewerUserId, authorId) ? identityLabelForUserId(authorId) : "Private account",');
    edit('    actorJoinedAt: stableJoinedAtForUserId(authorId),', '    actorJoinedAt: viewerCanSeeUserContent(viewerUserId, authorId) ? stableJoinedAtForUserId(authorId) : "",');
  }
  if (name === 'buildAccountExportReportRow') {
    edit('  const target = storedSnapshot || liveSnapshot;', `  let target = storedSnapshot || liveSnapshot;
  if (!adminModerationView) {
    const post = (posts || []).find(p => p?.id === report.postId);
    const loc = targetType === 'reply' ? findReplyLocation(report.replyId) : null;
    // A historical receipt is not ongoing authorization. Missing targets and
    // sources cannot prove current access; only the operator keeps that evidence.
    const inaccessible = !post || !viewerCanReadPostObject(post, userId)
      || targetType === 'reply' && (!loc || !viewerCanReadReplyLocation(loc, userId));
    if (inaccessible) { target = null; matchingLiveTargetExists = false; }
    if (target?.quoteSource) {
      const source = (posts || []).find(p => p?.id === target.quoteSource.postId);
      if (!source || !viewerCanReadPostObject(source, userId)) target = { ...target, quoteSource: null };
    }
  }`);
  }
  if (name === 'buildAccountExportResponse') edit('    profile: {\n      displayName: profile.displayName,', '    profile: {\n      privateAccount: profile.privateAccount,\n      displayName: profile.displayName,');
  if (name === 'publicPostTargetLabelForTool') text = text.replace("'s public Turnfeed post", "'s Turnfeed post");
  if (name === 'createSocialServer') edit('message: "Posted on Turnfeed."', 'message: profiles?.[userId]?.privateAccount ? "Posted for your approved followers." : "Posted on Turnfeed."');
  if (name === 'replyPostedThreadResult') text = text.replaceAll('Public reply prepared; confirmation required.', 'Reply prepared; confirmation required.')
    .replaceAll('"Sent your reply."', '(profiles?.[userId]?.privateAccount ? "Sent your reply for approved followers who can read the thread." : "Sent your reply.")');
  return text;
}

export function adaptPrivateSchemaDescriptions(schemas) {
  let count = 0;
  const adapted = schemas.replace(/visibility: z\.enum\(\["public"\]\)\.describe\("[^"\n]*"\)/g, () => {
    count++;
    return 'visibility: z.enum(["public"]).describe("Required legacy write acknowledgement. This transport value does not override account privacy: private content requires approved-follower access and readable thread ancestors. Names and handles remain public; detailed profiles and pictures follow account privacy.")';
  });
  if (count !== 6) throw new Error(`Private-account visibility schema anchors changed: ${count}`);
  return adapted.replace('  publicVisibility: z.literal("public"),', '  publicVisibility: z.literal("public").describe("Legacy write transport acknowledgement; actual visibility follows account privacy and thread access."),');
}

function nativePrivateRequests(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).filter(row => {
    if (!row || !/^[a-f0-9]{40}$/.test(row.userId || '') || !/^[a-f0-9]{32}$/.test(row.requestId || '') || seen.has(row.userId)) return false;
    seen.add(row.userId); return true;
  }).slice(0, MAX_FOLLOWS).map(({ userId, requestId }) => ({ userId, requestId }));
}
function nativeProfileVisible(viewer, author) {
  return !viewer || !author || viewer === author || !isBlockedEitherWay(viewer, author);
}
function nativeProfilePrivacy(author, viewer) {
  return { privateAccount: profiles?.[author]?.privateAccount === true,
    viewerCanReadContent: viewerCanSeeUserContent(viewer, author),
    viewerHasRequested: Boolean(viewer && nativePrivateRequests(profiles?.[author]?.followRequests).some(row => row.userId === viewer)) };
}
function nativeRemoveFollowRequest(owner, requester) {
  const raw = profiles?.[owner];
  if (!raw) return;
  const current = nativePrivateRequests(raw.followRequests);
  const next = current.filter(row => row.userId !== requester);
  if (next.length !== current.length) profiles = { ...profiles, [owner]: { ...raw, followRequests: next } };
}
function nativeOutboundFollowCount(userId) {
  const targets = new Set(getFollowList(userId));
  if (targets.size >= MAX_FOLLOWS) return targets.size;
  for (const [owner, profile] of Object.entries(profiles || {})) {
    if (Array.isArray(profile?.followRequests) && profile.followRequests.some(row => row?.userId === userId)) targets.add(owner);
    if (targets.size >= MAX_FOLLOWS) return targets.size;
  }
  return targets.size;
}
function nativePrivacyRead(userId) {
  const member = target => {
    const value = relationshipTargetForViewer(target, userId);
    return { targetRef: value.targetRef, displayName: value.displayName, publicHandle: value.publicHandle };
  };
  const followers = Object.entries(follows || {}).filter(([id, list]) => id !== userId && Array.isArray(list) && list.includes(userId) && nativeProfileVisible(userId, id)).map(([id]) => member(id));
  const requests = nativePrivateRequests(profiles?.[userId]?.followRequests).filter(row => nativeProfileVisible(userId, row.userId)).map(row => ({ ...member(row.userId), requestId: row.requestId }));
  return { privateAccount: profiles?.[userId]?.privateAccount === true, followers, requests, followerCount: followers.length, requestCount: requests.length };
}
function nativePrivacyChange({ userId, callerKey, privateAccount, expectedPrivateAccount }) {
  const current = profiles?.[userId]?.privateAccount === true;
  if (typeof privateAccount !== 'boolean') return { ok: false, code: 'invalid_privacy', message: 'Choose public or private.' };
  if (typeof expectedPrivateAccount === 'boolean' && current !== expectedPrivateAccount) return { ok: false, status: 409, code: 'privacy_changed', message: 'Your privacy setting changed. Open privacy settings again.' };
  if (current === privateAccount) return { ok: true, privateAccount, message: privateAccount ? 'Your account is private.' : 'Your account is public.' };
  const limit = checkRateLimit('update_settings', callerKey);
  if (!limit.allowed) return rateLimitedActionResult('update_settings', limit);
  if (!ensureUserSeen(userId)) return accountCapacityFailure();
  profiles = { ...profiles, [userId]: { ...profiles[userId], privateAccount, followRequests: privateAccount ? nativePrivateRequests(profiles[userId].followRequests) : [], updatedAt: nowIso() } };
  return { ok: true, privateAccount, message: privateAccount ? 'Your account is private. Existing followers keep access; new followers need approval. You can remove followers in privacy settings.' : 'Your account is public. Pending follow requests were cleared; those people can follow again.' };
}
function nativeManageFollower({ userId, callerKey, targetRef, targetLabel, action, requestId }) {
  const target = resolveRelationshipTargetRefForViewer(targetRef, userId);
  if (!target || target === userId || !relationshipTargetMatchesReadableLabel(targetLabel, target, userId)) return { ok: false, code: 'target_mismatch', message: 'Read your followers or requests again and use the displayed person.' };
  const request = nativePrivateRequests(profiles?.[userId]?.followRequests).find(row => row.userId === target);
  if (!['accept', 'reject', 'remove'].includes(action)) return { ok: false, code: 'invalid_action', message: 'Choose accept, reject or remove.' };
  if (action !== 'remove' && (!request || request.requestId !== requestId)) return { ok: false, status: 409, code: 'request_changed', message: 'That follow request changed. Read your requests again.' };
  if (action === 'accept' && (!nativeProfileVisible(userId, target) || getFollowList(target).length >= MAX_FOLLOWS)) return { ok: false, code: 'follow_unavailable', message: 'This follow request cannot be accepted.' };
  const limit = checkRateLimit('follow_user', callerKey);
  if (!limit.allowed) return rateLimitedActionResult('follow_user', limit);
  if (action === 'accept') {
    if (numericIdCounterIsExhausted('follow_event')) return numericIdCapacityFailure('follow_event');
    if (!ensureUserSeen(userId) || !ensureUserSeen(target)) return accountCapacityFailure();
    const id = claimNumericId('follow_event');
    follows = { ...follows, [target]: uniqueStrings([...getFollowList(target), userId], MAX_FOLLOWS) };
    followEvents = [...(followEvents || []), { id, actorId: target, targetId: userId, createdAt: nowIso() }].slice(-MAX_FOLLOW_EVENTS);
  } else if (action === 'remove') {
    follows = { ...follows, [target]: getFollowList(target).filter(id => id !== userId) };
    followEvents = (followEvents || []).filter(e => !(e.actorId === target && e.targetId === userId));
  }
  nativeRemoveFollowRequest(userId, target);
  return { ok: true, message: action === 'accept' ? 'Follow request accepted.' : action === 'reject' ? 'Follow request declined.' : 'Follower removed.' };
}
function nativePrivateFollow({ targetId, action, userId, callerKey, extraRateLimitResult }) {
  const pending = nativePrivateRequests(profiles?.[targetId]?.followRequests);
  const requested = pending.some(row => row.userId === userId);
  const unfollow = String(action || '').toLowerCase() === 'unfollow';
  const already = isFollowing(userId, targetId);
  if (unfollow && requested) {
    const limit = combinedRateLimitResultForAction('follow_user', callerKey, extraRateLimitResult);
    if (limit) return limit;
    nativeRemoveFollowRequest(targetId, userId);
    if (already) follows = { ...follows, [userId]: getFollowList(userId).filter(id => id !== targetId) };
  } else if (!unfollow && !already && profiles?.[targetId]?.privateAccount === true) {
    if (!requested) {
      const limit = combinedRateLimitResultForAction('follow_user', callerKey, extraRateLimitResult);
      if (limit) return limit;
      if (pending.length >= MAX_FOLLOWS || nativeOutboundFollowCount(userId) >= MAX_FOLLOWS) return relationshipCapacityFailure('follow', MAX_FOLLOWS);
      if (!ensureUserSeen(userId) || !ensureUserSeen(targetId)) return accountCapacityFailure();
      profiles = { ...profiles, [targetId]: { ...profiles[targetId], followRequests: [...pending, { userId, requestId: randomBytes(16).toString('hex') }] } };
    }
  } else return null;
  return { ok: true, message: unfollow ? 'Follow request cancelled.' : 'Follow request sent. Their posts stay private until approval.', follow: {
    action: unfollow ? 'unfollow' : 'follow', targetHandle: clientVisibleHandleForUserId(targetId, userId), targetPublicHandle: publicHandleForUserId(targetId), targetDisplayName: displayNameForUserId(targetId), targetRef: relationshipTargetRef(userId, targetId),
  } };
}

export const privateAccountHelpers = [nativePrivateRequests, nativeProfileVisible, nativeProfilePrivacy, nativeRemoveFollowRequest, nativeOutboundFollowCount, nativePrivacyRead, nativePrivacyChange, nativeManageFollower, nativePrivateFollow].map(fn => fn.toString()).join('\n');
export const privateAccountApi = `privateAccounts: {
  read: nativePrivacyRead,
  change: args => mutateStore(() => nativePrivacyChange(args)),
  manage: args => mutateStore(() => nativeManageFollower(args)),
  signCursor: value => createHmac('sha256', runtime.secret).update('turnfeed-private-followers-v1|').update(value).digest('hex'),
},`;
