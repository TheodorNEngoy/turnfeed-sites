// Explicit projection additions leave the retained server source immutable.
export function adaptAvatars(name, text) {
  const edits = {
    compactThreadQuoteForTool: [['compactQuote.authorName = String(quote?.authorName || "");', 'compactQuote.authorAvatarUrl = String(quote?.authorAvatarUrl || "");']],
    digestReplyPreviewsForTool: [['authorName: String(reply?.authorName || ""),', 'authorAvatarUrl: String(reply?.authorAvatarUrl || ""),']],
    replyContextItemsForTool: [['id: reply.id,', 'authorAvatarUrl: normalizePublicProfileUrl(profiles?.[reply.authorId]?.avatarUrl, MAX_AVATAR_URL_CHARS),']],
    postContextPreviewForTool: [['authorName: displayNameForUserId(post?.authorId),', 'authorAvatarUrl: normalizePublicProfileUrl(profiles?.[post?.authorId]?.avatarUrl, MAX_AVATAR_URL_CHARS),']],
    buildProfileContextForTool: [['displayName: String(profile.displayName || ""),', 'avatarUrl: String(profile.avatarUrl || ""),']],
    buildThreadContextForTool: [
      ['authorName: rootAuthorName,', 'authorAvatarUrl: String(preview?.authorAvatarUrl || ""),'],
      ['id: String(reply?.id || ""),', 'authorAvatarUrl: String(reply?.authorAvatarUrl || ""),'],
      ['authorName: String(reply?.authorName || ""),', 'authorAvatarUrl: String(reply?.authorAvatarUrl || ""),'],
    ],
    compactInboxNotificationForTool: [['actorPublicHandle: publicHandle,', 'actorAvatarUrl: String(notification?.actorAvatarUrl || ""),']],
  };
  for (const [anchor, addition] of edits[name] || []) {
    if (text.split(anchor).length !== 2) throw new Error(`Avatar projection changed: ${name}`);
    text = text.replace(anchor, anchor + '\n    ' + addition);
  }
  return text;
}
