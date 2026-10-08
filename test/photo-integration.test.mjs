import { MODERATION_KEY, installModerationFixture, MODERATION_ENDPOINT, allowModerationFetch } from './moderation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from './sqlite-d1.mjs';
import { dispatchMcp, makeCore, catalog } from '../worker/mcp.mjs';
import { readState } from '../worker/storage.mjs';
import { logoBase64 } from '../worker/brand.generated.mjs';
import { accountKey } from '../worker/identity.mjs';
import { operatorAction } from '../worker/operator.mjs';
import worker from '../worker/index.mjs';

installModerationFixture();

const origin='https://turnfeed.example';
const secret='photo-integration-local-012345678901234567890';
const file={download_url:'https://files.oaiusercontent.com/photo?token=secret-source',file_id:'file-selected',mime_type:'image/png'};
const text='A photo from my afternoon walk.';
function fixture(t) {
  const db=database(), objects=new Map(); let downloads=0, writes=0;
  const bucket={async put(key,bytes){writes++;objects.set(key,Buffer.from(bytes));return{key};},
    async get(key){return objects.has(key)?{body:objects.get(key)}:null;},async delete(key){objects.delete(key);}};
  const env={DB:db,BUCKET:bucket,OPENAI_API_KEY: MODERATION_KEY, TURNFEED_SITE_SECRET:secret,TURNFEED_OPERATOR_ACCOUNT_KEYS:accountKey('operator',secret)};
  t.after(()=>db.sql.close());
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if (url===MODERATION_ENDPOINT) return allowModerationFetch(url,options);
    assert.equal(url,file.download_url,'Unexpected photo download in test');
    downloads++;return new Response(Buffer.from(logoBase64,'base64'),{headers:{'content-type':'image/png'}});
  });
  const call=(subject,name,args={})=>dispatchMcp(new Request(origin+'/mcp',{headers:subject?{'oai-authenticated-user-id':subject}: {}}),env,{method:'tools/call',params:{name,arguments:args}});
  const get=(path,subject='')=>worker.fetch(new Request(new URL(path,origin),{headers:subject?{'oai-authenticated-user-id':subject}:{}}),env);
  return{db,env,objects,call,get,get downloads(){return downloads;},get writes(){return writes;}};
}
async function publish(f,id='photo-post-1') {
  const result=await f.call('alice','create_post',{text,visibility:'public',clientId:id,photo:file});
  assert.equal(result.result?.structuredContent?.published,true,JSON.stringify(result));
  return (await readState(f.db)).value.snapshot.posts.at(-1);
}
const target=post=>({targetLabel:'My afternoon walk photo',postText:post.text});

test('chat file schema declares the documented file input and a staged photo persists once',async t=>{
  const entry=catalog(makeCore({origin,secret})).find(t=>t.name==='create_post');
  assert.deepEqual(entry._meta['openai/fileParams'],['photo']);
  assert.deepEqual(entry.inputSchema.properties.photo.required,['download_url','file_id']);
  const f=fixture(t),post=await publish(f);
  await publish(f);
  assert.equal(f.downloads,1);assert.equal(f.writes,1);
  assert.equal((await readState(f.db)).value.snapshot.posts.length,1);
  assert.match(post.media[0].url,/\/photos\/[a-f0-9]{64}\.png$/);
  assert.doesNotMatch(JSON.stringify((await readState(f.db)).value),/secret-source|oaiusercontent/);
  const response=await f.get(post.media[0].url);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.ok((await response.arrayBuffer()).byteLength>0);
  assert.match(await(await f.get('/')).text(),/class="post-photo"/);
});

test('anonymous and invalid photo writes never download; raw media cannot reuse a stored photo',async t=>{
  const f=fixture(t),args={text,visibility:'public',clientId:'denied',photo:file};
  assert.equal((await f.call('','create_post',args)).status,401);
  assert.equal((await f.call('alice','create_post',{...args,text:''})).error.code,-32602);
  assert.equal(f.downloads,0);
  const post=await publish(f);
  const copied=await f.call('bob','create_post',{text:'Copied photo',visibility:'public',clientId:'copy',media:post.media});
  assert.equal(copied.result.structuredContent.ok,false);
  assert.equal((await readState(f.db)).value.snapshot.posts.length,1);
});

test('blocked viewers and hidden posts cannot fetch photo bytes; deletion removes the object',async t=>{
  const f=fixture(t);
  await f.call('alice','set_profile',{displayName:'Alice',handle:'alice',visibility:'public'});
  const post=await publish(f), url=post.media[0].url;
  await f.call('bob','block_user',{handle:'alice',action:'block',targetLabel:'Alice'});
  assert.equal((await f.get(url,'bob')).status,404);
  assert.equal((await f.get(url,'alice')).status,200);
  const base={db:f.db,bucket:f.env.BUCKET,origin,secret,actor:accountKey('operator',secret)};
  const planned=await operatorAction({...base,action:'visibility-plan',input:{targetType:'post',targetId:post.id,hide:true,reason:'Reviewing the attached photo.',targetCreatedAt:post.createdAt,parentCreatedAt:'',expectedHidden:'false',requestId:randomUUID()}});
  assert.equal((await operatorAction({...base,action:'visibility',token:planned.token})).ok,true);
  assert.equal((await f.get(url)).status,404);
  assert.equal((await f.get(url,'operator')).status,200);
});

test('post deletion and reset remove their photo objects',async t=>{
  const f=fixture(t),post=await publish(f);
  const deleted=await f.call('alice','delete_post',target(post));
  assert.equal(deleted.result.structuredContent.ok,true,JSON.stringify(deleted));
  assert.equal(f.objects.size,0);
  assert.equal((await f.get(post.media[0].url)).status,404);
  const next=await publish(f,'photo-post-2');
  assert.equal(f.objects.size,1);
  const reset=await f.call('alice','reset_me');
  assert.equal(reset.result.structuredContent.ok,true);
  assert.equal(f.objects.size,0);
  assert.equal((await f.get(next.media[0].url)).status,404);
});

test('reported photos remain restricted evidence after deletion and account erasure',async t=>{
  const f=fixture(t),post=await publish(f);
  const report=await f.call('bob','report_post',{...target(post),reason:'other'});
  assert.equal(report.result.structuredContent.ok,true);
  assert.equal(Object.keys((await readState(f.db)).value.operator.photoEvidence).length,1);
  const page=await f.get('/operator','operator');
  assert.match(await page.text(),/Photo for moderation review/);
  assert.match(page.headers.get('content-security-policy'),/img-src 'self'/);
  await f.call('alice','delete_post',target(post));
  assert.equal(f.objects.size,1);
  assert.equal((await f.get(post.media[0].url)).status,404);
  assert.equal((await f.get(post.media[0].url,'operator')).status,200);
  const base={db:f.db,bucket:f.env.BUCKET,origin,secret,actor:accountKey('operator',secret)};
  const planned=await operatorAction({...base,action:'erasure-plan',input:{userId:accountKey('alice',secret),caseId:'local-erase',retainedRecordsReason:'Retain reported photo evidence.'}});
  assert.equal((await operatorAction({...base,action:'erasure',token:planned.token,confirmation:planned.plan.confirmation})).ok,true);
  assert.equal(f.objects.size,1);
  assert.equal((await f.get(post.media[0].url,'alice')).status,404);
});

test('definite rejected publication cleans its unattached photo without deleting the existing post photo',async t=>{
  const f=fixture(t),post=await publish(f);
  const rejected=await f.call('alice','create_post',{text:'Changed caption for an already-used request.',visibility:'public',clientId:'photo-post-1',photo:{...file,file_id:'different-file'}});
  assert.notEqual(rejected.result?.structuredContent?.published,true,JSON.stringify(rejected));
  assert.equal(f.objects.size,1);
  assert.equal((await f.get(post.media[0].url)).status,200);
  assert.equal(f.db.sql.prepare("SELECT COUNT(*) AS n FROM turnfeed_photos WHERE status='deleted'").get().n,1);
});

test('photo retirement prevents a stale publication from attaching deleted bytes',async t=>{
  const {commitState}=await import('../worker/storage.mjs');
  const f=fixture(t),post=await publish(f);
  const saved=await readState(f.db), row=f.db.sql.prepare('SELECT * FROM turnfeed_photos').get();
  // Model an unlinked ready object and two concurrent decisions against one revision.
  saved.value.snapshot.posts=[];
  assert.equal(await commitState(f.db,saved.revision,saved.value,undefined,saved),true);
  const before=await readState(f.db),guard={id:row.id,owner:row.owner};
  assert.equal(await commitState(f.db,before.revision,before.value,undefined,before,{...guard,retire:true}),true);
  const fresh=await readState(f.db);fresh.value.snapshot.posts=[post];
  assert.equal(await commitState(f.db,fresh.revision,fresh.value,undefined,fresh,guard),false);
  assert.equal((await readState(f.db)).value.snapshot.posts.length,0);
});
