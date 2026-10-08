function replaceOnce(text, from, to, name) {
  if (text.split(from).length !== 2) throw new Error(`Retained text-limit boundary changed: ${name}`);
  return text.replace(from, to);
}

// Runtime guards complement the MCP schemas; direct handlers must never trim
// an over-limit public write into a different, publishable message.
export function adaptTextLimits(name, text) {
  if (['buildFeedDigestForTool', 'buildFeedSearchDigestForTool', 'buildOwnPostsContextForTool', 'buildProfileContextForTool'].includes(name)) {
    // Feed rows retain their prior preview size and structured byte budget.
    // Full conversations and stored text use the larger post limit.
    text = replaceOnce(text, 'textLimit: MAX_POST_CHARS,', 'textLimit: Math.min(MAX_POST_CHARS, 600),', name);
  }
  const post = ['handleCreatePost', 'handleEditPost'].includes(name);
  const reply = ['handleReplyToPost', 'handleReplyToReply', 'handleEditReply'].includes(name);
  if (post || reply) {
    const limit = post ? 'MAX_POST_CHARS' : 'MAX_REPLY_CHARS';
    const kind = post ? 'post' : 'reply';
    const from = post ? '  const cleanText = String(text ?? "").trim();'
      : '  const cleanText = String(text ?? "").trim().slice(0, MAX_REPLY_CHARS);';
    text = replaceOnce(text, from, `  if (String(text ?? "").length > ${limit}) return { ok: false, message: \`Keep ${kind} text within \${${limit}} characters.\` };\n  const cleanText = String(text ?? "").trim();`, name);
    if (name === 'handleEditPost') text = replaceOnce(text,
      '  const nextText = cleanText.slice(0, MAX_POST_CHARS);', '  const nextText = cleanText;', name);
  }
  if (name === 'buildThreadContextForTool') {
    // Keep the existing envelope for short threads without edit history. Extra
    // full root/quote text and immutable edit history appear in both the MCP
    // message and structured object; reserve their UTF-8 size twice. Budget
    // for one reply's complete history; the existing compactor can paginate
    // remaining reply rows without shortening any message. Two
    // readable handoffs may now contain a 700-character source excerpt; reserve
    // another 1,200 bytes for those selectors and their envelope.
    const anchor = '  let retainedReplies = candidateDisplayReplies;';
    const budget = `  const longPostCharacters = [thread.text, thread.quote?.text]
    .reduce((total, value) => total + Math.max(0, String(value || '').length - 600), 0);
  const historyCharacters = history => (history || []).reduce((total, entry) => total + String(entry.text || '').length + String(entry.reason || '').length + 128, 0);
  const completeHistoryCharacters = historyCharacters(thread.correctionHistory)
    + Math.max(0, ...candidateDisplayReplies.map(reply => historyCharacters(reply.correctionHistory)));
  const threadContextBudget = THREAD_CONTEXT_TOOL_RESULT_MAX_BYTES + (longPostCharacters + completeHistoryCharacters) * 6 + (longPostCharacters ? 1200 : 0);
${anchor}`;
    text = replaceOnce(text, anchor, budget, name);
    text = text.replaceAll('>= THREAD_CONTEXT_TOOL_RESULT_MAX_BYTES', '>= threadContextBudget');
  }
  return text;
}

export function adaptTextLimitSchemas(text) {
  for (const [limit, count] of [['MAX_POST_CHARS', 2], ['MAX_REPLY_CHARS', 6]]) {
    const from = `z.string().trim().min(1).max(${limit})`;
    if (text.split(from).length !== count + 1) throw new Error(`Retained text schemas changed: ${limit}`);
    text = text.replaceAll(from, `z.string().max(${limit}).trim().min(1)`);
  }
  return text;
}
