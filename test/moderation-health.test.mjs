import test from 'node:test';
import assert from 'node:assert/strict';
const {default:worker} = await import(process.env.TURNFEED_TEST_BUILT === '1' ? '../dist/server/index.js' : '../worker/index.mjs');
import { accountKey } from '../worker/identity.mjs';
import { readState, commitState } from '../worker/storage.mjs';
import { database } from './sqlite-d1.mjs';
import { allowModerationFetch, MODERATION_KEY } from './moderation-fixture.mjs';
import { makeCore } from '../worker/mcp.mjs';

const origin = 'https://native.example';
function fixture(t) {
  const db = database(), calls = [];
  t.after(() => db.sql.close());
  const secret = 'local-screening-health-012345678901234567890';
  const actor = accountKey('operator',secret);
  const env = {DB:db,TURNFEED_SITE_SECRET:secret,TURNFEED_OPERATOR_ACCOUNT_KEYS:actor,OPENAI_API_KEY:MODERATION_KEY};
  t.mock.method(globalThis,'fetch',async (...args) => { calls.push(JSON.parse(args[1].body)); return allowModerationFetch(...args); });
  const request = (subject='operator', options={}) => new Request(origin+'/operator/check-screening',{
    method:'POST',headers:{'oai-authenticated-user-id':subject,origin,'content-type':'application/x-www-form-urlencoded',...options.headers},
    body:'',...options,
  });
  return {db,env,actor,calls,request};
}

test('screening health check is operator-only, same-origin POST and refuses revoked operators',async t=>{
  const f=fixture(t);
  const home=await worker.fetch(new Request(origin+'/operator',{headers:{'oai-authenticated-user-id':'operator'}}),f.env);
  assert.equal(home.headers.get('referrer-policy'),'same-origin');
  assert.match(await home.text(),/action="\/operator\/check-screening"/);
  for (const subject of ['', 'member']) assert.equal((await worker.fetch(f.request(subject),f.env)).status,403);
  assert.equal((await worker.fetch(f.request('operator',{headers:{'oai-authenticated-user-id':'operator',origin:'https://other.example','content-type':'application/x-www-form-urlencoded'}}),f.env)).status,403);
  assert.equal((await worker.fetch(new Request(origin+'/operator/check-screening',{headers:{'oai-authenticated-user-id':'operator'}}),f.env)).status,405);
  assert.equal(f.calls.length,0);
  const loaded=await readState(f.db);
  const core=makeCore({origin,secret:f.env.TURNFEED_SITE_SECRET});
  await commitState(f.db,loaded.revision,{format:1,snapshot:core.snapshot(),controls:core.controls(),operator:{revoked:{[f.actor]:true}}},undefined,loaded);
  assert.equal((await worker.fetch(f.request(),f.env)).status,403);
  assert.equal(f.calls.length,0);
});

test('fixed text and logo use live screening path without changing social state or storing images',async t=>{
  const f=fixture(t), before=await readState(f.db);
  const response=await worker.fetch(f.request(),f.env);
  assert.equal(response.status,200);
  assert.match(await response.text(),/Live text and image screening both passed/);
  assert.deepEqual(f.calls[0].input,['Turnfeed connection check.','Reading and conversation.']);
  assert.equal(f.calls[1].input[0].type,'image_url');
  assert.match(f.calls[1].input[0].image_url.url,/^data:image\/png;base64,/);
  assert.deepEqual(await readState(f.db),before);
  assert.equal(f.db.sql.prepare('SELECT COUNT(*) AS n FROM turnfeed_photos').get().n,0);
  assert.equal(f.db.sql.prepare("SELECT count FROM turnfeed_moderation_limits WHERE bucket='global'").get().count,2);
});

test('screening health check reports failure and never claims success after provider failure',async t=>{
  const f=fixture(t);
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:401}));
  t.mock.method(console,'error',()=>{});
  const response=await worker.fetch(f.request(),f.env);
  assert.equal(response.status,503);
  assert.equal((await response.json()).code,'moderation_unavailable');
  assert.equal((await readState(f.db)).value,null);
});
