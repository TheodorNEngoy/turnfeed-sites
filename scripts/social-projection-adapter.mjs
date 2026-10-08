// Add native social controls to projections without modifying retained source.
export function adaptSocialProjection(name, text) {
  const edits = {
    postContextPreviewForTool: [[
      '    likes: Math.max(0, Number(post?.likes || 0)),',
      '    ...(viewerUserId ? { viewerHasLiked: Array.isArray(post?.likedBy) && post.likedBy.includes(viewerUserId) } : {}),',
    ]],
    buildProfileContextForTool: [[
      '      ...(viewerIdentityKnown ? { viewerIsSelf } : {}),',
      '      ...(viewerIdentityKnown ? { viewerFollows: profile.viewerFollows === true, viewerHasBlocked: profile.viewerHasBlocked === true } : {}),',
    ]],
    buildThreadContextForTool: [
      ['    text: String(post?.text || ""),', '    likes: Math.max(0, Number(post?.likes || 0)),'],
      ['        text: String(reply?.text || ""),', '        likes: Math.max(0, Number(reply?.likes || 0)),'],
    ],
  };
  for (const [anchor, addition] of edits[name] || []) {
    if (text.split(anchor).length !== 2) throw new Error(`Social projection changed: ${name}`);
    text = text.replace(anchor, anchor + '\n' + addition);
  }
  return text;
}

export function adaptSocialOutputSchemas(schemas) {
  const fields = {
    threadPost: '  likes: z.number().min(0),',
    threadReply: '  likes: z.number().min(0),',
    feedDigestItem: [
      '  likes: z.number().min(0),',
      '  viewerHasLiked: z.boolean().optional().describe("Whether the verified viewer has liked this post; omitted for anonymous reads."),',
      '  viewerIsAuthor: z.boolean().optional().describe("Whether the verified viewer wrote this post; omitted for anonymous reads."),',
    ].join('\n'),
  };
  for (const [name, addition] of Object.entries(fields)) {
    const anchor = `const ${name}OutputSchema = z.object({`;
    if (schemas.split(anchor).length !== 2) throw new Error(`Social output schema changed: ${name}`);
    schemas = schemas.replace(anchor, anchor + '\n' + addition);
  }
  return schemas;
}
