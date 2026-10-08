// Isolated, ephemeral browser preview. No live credentials or database are used.
import { createServer } from 'node:http';
import { siteOrigin } from '../worker/site-config.mjs';
const worker = (await import(process.argv.includes('--built') ? '../dist/server/index.js' : '../worker/index.mjs')).default;
import { invoke, MODERATION_KEY, allowModerationFetch } from '../test/moderation-fixture.mjs';
// This preview uses only synthetic content and mocked screening.
globalThis.fetch = allowModerationFetch;
import { database } from '../test/sqlite-d1.mjs';

const db = database();
const previewObjects = new Map();
const bucket = { async put(key, bytes) { previewObjects.set(key, Buffer.from(bytes)); return { key }; }, async get(key) { return previewObjects.has(key) ? { body: previewObjects.get(key) } : null; }, async delete(key) { previewObjects.delete(key); } };
const workerOrigin = siteOrigin;
const secret = 'local-preview-only-012345678901234567890123456789';
const server = createServer(async (req, res) => {
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = new Headers(req.headers);
    if (headers.get('origin') === origin) headers.set('origin', workerOrigin);
    headers.set('oai-authenticated-user-id', 'preview-avery');
    headers.set('oai-authenticated-user-full-name', 'Avery Lane');
    const request = new Request(workerOrigin + req.url, { method: req.method, headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: req, duplex: 'half' } : {}) });
    const response = await worker.fetch(request, { DB: db, BUCKET: bucket, TURNFEED_SITE_SECRET: secret, OPENAI_API_KEY: MODERATION_KEY });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.headers.get('content-type')?.includes('text/html')) {
      const body = (await response.text()).replace('<body>', '<body><div style="text-align:center;background:#fff0c9;padding:7px;font:12px system-ui">Local preview · sample data · simulated safety checks · changes disappear when this server stops</div>');
      res.end(body);
    } else res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Local preview unavailable.'); }
});
server.listen(0, '127.0.0.1', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (subject, name, args) => (await invoke({ db, subject, name, args, origin: workerOrigin, secret, callerKey: subject })).result.structuredContent;
  await call('preview-avery', 'set_profile', { displayName: 'Avery Lane', handle: 'averylane', bio: 'Small discoveries, good books and everyday ideas.', visibility: 'public' });
  await call('preview-maya', 'set_profile', { displayName: 'Maya Chen', handle: 'mayachen', bio: 'Reading, walking, making things.', visibility: 'public' });
  await call('preview-avery', 'follow_user', { handle: 'mayachen', targetLabel: 'Maya Chen', action: 'follow' });
  await call('preview-maya', 'follow_user', { handle: 'averylane', targetLabel: 'Avery Lane', action: 'follow' });
  const book = await call('preview-maya', 'create_post', { text: 'What is a book you would happily read twice?\n\nLooking for something that feels different the second time around.', visibility: 'public', clientId: 'preview-book' });
  await call('preview-avery', 'publish_public_reply_to_post', { ...book.replyHandoff.targetArguments, text: 'A Wizard of Earthsea. Short enough for a weekend, with plenty to think about afterwards.', visibility: 'public', clientId: 'preview-book-reply' });
  const walk = await call('preview-avery', 'create_post', { text: 'A small thing that made today better: leaving my phone at home for a walk. What has worked for you lately?', visibility: 'public', clientId: 'preview-walk' });
  await call('preview-maya', 'publish_public_reply_to_post', { ...walk.replyHandoff.targetArguments, text: 'A short walk after lunch always helps me reset.', visibility: 'public', clientId: 'preview-walk-reply' });
  if (process.argv.includes('--many')) {
    for (const [index,text] of [
      'A drawing challenge for the weekend: sketch something you pass every day without really looking at it.',
      'What makes a shared workspace feel welcoming? Natural light and somewhere quiet to think matter most to me.',
      'Learning a new recipe is easier when I make notes about what changed from the last attempt.',
      'A video worth discussing after a long day: https://youtu.be/hJxUBxvbGvA',
      'Which small local museum would you recommend to someone visiting your town for the first time?',
    ].entries()) await call('preview-maya','create_post',{text,visibility:'public',clientId:'preview-extra-'+index});
  }
  // Local QA only: a signal adds one reply from the second fixture account.
  // This never reaches the deployed Worker or a real member's account.
  process.on('SIGUSR1', async () => {
    try {
      await call('preview-maya', 'publish_public_reply_to_post', { ...walk.replyHandoff.targetArguments,
        text: 'Another small discovery: taking a different route home.', visibility: 'public', clientId: 'preview-new-activity' });
      console.log('Added one local activity fixture.');
    } catch { console.log('Could not add the local activity fixture.'); }
  });
  console.log(`Local: ${origin}`);
});
process.on('SIGINT', () => server.close(() => { db.sql.close(); process.exit(0); }));
