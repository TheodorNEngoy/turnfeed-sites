// Shared publication checks. Derive the burst window from committed content so
// independent Worker requests see the same history without a new tracking store.
const REPLY_WINDOW_MS = 10 * 60_000;
const MIN_REPEATED_REPLY_CHARS = 80;
const MAX_MENTION_HANDLES = 5;
const comparable = text => String(text || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

export function nativeAbuseIssue({ posts = [], text = '', kind = 'post', userId = '',
  targetPostId = '', excludeId = '', now = Date.now() } = {}) {
  // Count syntactically valid handles, including unregistered handles, using
  // the retained inbox boundaries and profile length limits. Ordinary email
  // addresses do not match. A punctuation-ending email localpart can match
  // because the retained inbox also treats that boundary as a mention.
  const mentions = new Set([...String(text).matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/g)]
    .map(match => match[1].toLowerCase()));
  if (mentions.size > MAX_MENTION_HANDLES) {
    return 'A post or reply can mention at most five different @handles. Nothing was published.';
  }
  const signature = comparable(text);
  if (kind !== 'reply' || !userId || !targetPostId || signature.length < MIN_REPEATED_REPLY_CHARS) return '';

  const matchingThreads = new Map();
  for (const post of posts) {
    if (!post?.id || post.id === targetPostId) continue;
    const pending = [...(post.replies || [])];
    while (pending.length) {
      const reply = pending.pop();
      if (!reply) continue;
      if (Array.isArray(reply.replies)) pending.push(...reply.replies);
      if (reply.authorId !== userId || reply.id === excludeId || comparable(reply.text) !== signature) continue;
      const createdAt = Date.parse(reply.createdAt || '');
      const editedAt = Date.parse(reply.editedAt || '');
      const at = Number.isFinite(editedAt) ? Math.max(createdAt, editedAt) : createdAt;
      if (!Number.isFinite(at) || at > now || now - at >= REPLY_WINDOW_MS) continue;
      // Include hidden authored content: moderation should not reopen this
      // short publication window. No other user's history affects the limit.
      matchingThreads.set(post.id, Math.max(at, matchingThreads.get(post.id) || 0));
    }
  }
  if (matchingThreads.size < 2) return '';
  const secondNewest = [...matchingThreads.values()].sort((a, b) => b - a)[1];
  const minutes = Math.max(1, Math.ceil((secondNewest + REPLY_WINDOW_MS - now) / 60_000));
  return `This reply was already posted in two conversations recently. Wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} before repeating it in another conversation. Nothing was published.`;
}
