// Carry public pictures and viewer social state through compact projections.
export * from '../vendor/turnfeed/lib/feed-presentation.mjs';
import { createFeedPresentation as retainedPresentation } from '../vendor/turnfeed/lib/feed-presentation.mjs';
export function createFeedPresentation(options) {
  const base = retainedPresentation(options);
  const avatar = item => ({ authorAvatarUrl: String(item?.authorAvatarUrl || '') });
  const quote = (item, now) => {
    const result = base.compactFeedQuotePreviewForTool(item, now);
    return result && !result.unavailable ? { ...result, ...avatar(item) } : result;
  };
  const reply = (item, now) => ({ ...base.compactDigestReplyPreviewForOpenTool(item, now), ...avatar(item) });
  return { ...base,
    compactFeedQuotePreviewForTool: quote,
    compactDigestReplyPreviewForOpenTool: reply,
    compactFeedDigestItemForTool(item, now) {
      return { ...base.compactFeedDigestItemForTool(item, now), ...avatar(item),
        likes: Math.max(0, Number(item?.likes || 0)),
        ...(typeof item?.viewerHasLiked === 'boolean' ? { viewerHasLiked: item.viewerHasLiked } : {}),
        ...(typeof item?.viewerIsAuthor === 'boolean' ? { viewerIsAuthor: item.viewerIsAuthor } : {}),
        quote: quote(item?.quote, now),
        recentReplies: Array.isArray(item?.recentReplies) ? item.recentReplies.slice(0, 1).map(value => reply(value, now)) : [] };
    },
  };
}
