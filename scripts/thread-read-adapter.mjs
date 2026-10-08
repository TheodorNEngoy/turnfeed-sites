// Projection substitutions apply only to selected ordinary threads. The final
// optional-metadata compaction applies to both selected and complete reads.
export function adaptThreadRead(text) {
  const replacements = [
    ['const relationshipCache = createRelationshipScoringCache(viewerUserId);',
      'const relationshipCache = runtime.threadProjection ? null : createRelationshipScoringCache(viewerUserId);'],
    ['const activity = threadActivityForTool(post, viewerUserId, relationshipCache);',
      'const activity = runtime.threadProjection ? { replyCount: countVisibleReplies(post.replies, viewerUserId) } : threadActivityForTool(post, viewerUserId, relationshipCache);'],
    ['const preview = postContextPreviewForTool(post, viewerUserId, relationshipCache);',
      'const preview = runtime.threadProjection ? threadRootContextForTool(post, viewerUserId) : postContextPreviewForTool(post, viewerUserId, relationshipCache);'],
    ['    throw new Error("Thread context exceeded the safe transport budget after preview compaction.");',
      `    // This optional guidance repeats the tool description and server rules.
    // Drop it before rejecting a complete Unicode body; retain the original
    // rendering, untrusted-content boundaries, exact handoffs and byte limit.
    const { defaultResponseStyle: _style, ...withoutStyle } = result;
    result = withoutStyle;
  }
  if (threadContextToolResultByteLength(result) >= THREAD_CONTEXT_TOOL_RESULT_MAX_BYTES) {
    throw new Error("Thread context exceeded the safe transport budget after preview compaction.");`],
  ];
  for (const [from, to] of replacements) {
    if (text.split(from).length !== 2) throw new Error('Retained thread reader changed; review the projection adapter.');
    text = text.replace(from, to);
  }
  return `${text}\n${threadRootContextForTool.toString()}`;
}

// This function is emitted inside the retained core, where these helpers live.
// Keep only fields consumed by buildThreadContextForTool; no feed ranking or
// cross-thread relationship/repetition calculations belong in this projection.
function threadRootContextForTool(post, viewerUserId) {
  const visiblePostText = compactSnippet(post?.text || '', 700);
  const targetArguments = {
    targetKind: 'post', targetText: visiblePostText,
    targetLabel: publicPostTargetLabelForTool(post, 180),
    authorHandle: publicHandleForUserId(post?.authorId), postText: visiblePostText,
    createdAt: typeof post?.createdAt === 'string' ? post.createdAt : '',
  };
  const replyHandoff = isArchivedThread(post) ? null : replyHandoffForTool({
    targetKind: 'post', targetArguments, publishTool: TURNFEED_PUBLIC_REPLY_TO_POST_TOOL,
  });
  return {
    authorName: displayNameForUserId(post?.authorId),
    authorAvatarUrl: normalizePublicProfileUrl(profiles?.[post?.authorId]?.avatarUrl, MAX_AVATAR_URL_CHARS),
    authorHandle: clientVisibleHandleForUserId(post?.authorId, viewerUserId),
    authorPublicHandle: publicHandleForUserId(post?.authorId),
    authorTargetRef: relationshipTargetRef(viewerUserId, post?.authorId),
    ...(viewerUserId ? { viewerIsAuthor: post?.authorId === viewerUserId } : {}),
    createdAt: typeof post?.createdAt === 'string' ? post.createdAt : '',
    createdAtLabel: formatTimestampWithUtcForTool(post?.createdAt),
    ...(replyHandoff ? { replyHandoff } : {}),
  };
}
