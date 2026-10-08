import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from './sqlite-d1.mjs';
import { dispatchMcp } from '../worker/mcp.mjs';
import worker from '../worker/index.mjs';
import { readState } from '../worker/storage.mjs';
import { logoBase64 } from '../worker/brand.generated.mjs';
import { stageWebPhoto } from '../worker/photos.mjs';
import { accountKey } from '../worker/identity.mjs';

const origin='https://turnfeed.example';
const categories=Object.fromEntries(['harassment','harassment/threatening','hate','hate/threatening',
  'illicit','illicit/violent','self-harm','self-harm/intent','self-harm/instructions',
  'sexual','sexual/minors','violence','violence/graphic'].map(k=>[k,false]));
function fixture(t) {
  const db=database(), objects=new Map(), calls=[];
  t.after(()=>db.sql.close());
  let mode='allow';
  const env={DB:db,TURNFEED_SITE_SECRET:'screen-integration-012345678901234567890123456',OPENAI_API_KEY:'local-fixture',
    BUCKET:{async put(key,bytes){objects.set(key,Buffer.from(bytes));return{key};},
      async get(key){return objects.has(key)?{body:objects.get(key)}:null;},async delete(key){objects.delete(key);}}};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/moderations');
    const body=JSON.parse(options.body); calls.push(body);
    if(mode==='unavailable') return new Response('',{status:429});
    const inputs=body.input;
    const hasImage=inputs.some(x=>x?.type==='image_url');
    const rejected=mode==='reject' || (mode==='image'&&hasImage);
    return Response.json({results:Array.from({length:hasImage?1:inputs.length},()=>({flagged:rejected,categories:{...categories}}))});
  });
  const call=async(name,args={},subject='alice',displayName='')=>dispatchMcp(new Request(origin+'/mcp',{headers:{
    'oai-authenticated-user-id':subject,...(displayName?{'oai-authenticated-user-full-name':displayName}:{})
  }}),env,{method:'tools/call',params:{name,arguments:args}});
  return {db,env,objects,calls,call,set mode(value){mode=value;}};
}
const postArgs=text=>({text,visibility:'public',clientId:randomUUID()});
const state=async f=>(await readState(f.db)).value?.snapshot;
const rejected=result=>assert.equal(result.result?.structuredContent?.code,'moderation_rejected',JSON.stringify(result));

test('rejected creates and edits leave stored posts, replies and profile unchanged',async t=>{
  const f=fixture(t), text='Which walking route would you recommend near the coast?';
  const created=await f.call('create_post',postArgs(text));
  assert.equal(created.result.structuredContent.published,true);
  const target=created.result.structuredContent.replyHandoff.targetArguments;
  const replied=await f.call('publish_public_reply_to_post',{...target,...postArgs('The short trail past the lighthouse is worth a visit.')});
  assert.equal(replied.result.structuredContent.published,true);
  const profile=await f.call('set_profile',{displayName:'Alice',bio:'Walking and reading.',visibility:'public'});
  assert.equal(profile.result.structuredContent.saved,true);
  const before=JSON.stringify(await state(f));
  f.mode='reject';
  rejected(await f.call('create_post',postArgs('Another candidate post to check.')));
  rejected(await f.call('edit_post',{targetLabel:'My coastal question',postText:text,text:'A changed coastal question for everyone.'}));
  rejected(await f.call('publish_public_reply_to_post',{...target,...postArgs('A second candidate reply to check.')}));
  rejected(await f.call('edit_reply',{targetLabel:'My walking reply',replyText:'The short trail past the lighthouse is worth a visit.',parentPostText:text,text:'A different walking route to suggest.'}));
  rejected(await f.call('set_profile',{displayName:'Changed name',bio:'Changed public biography.',visibility:'public'}));
  assert.equal(JSON.stringify(await state(f)),before);
});

test('identical durable retry does not rescreen; changed text is screened',async t=>{
  const f=fixture(t),args=postArgs('A quiet afternoon spent reading by the window.');
  assert.equal((await f.call('create_post',args)).result.structuredContent.published,true);
  assert.equal(f.calls.length,1);
  f.mode='unavailable';
  assert.equal((await f.call('create_post',args)).result.structuredContent.published,true);
  assert.equal(f.calls.length,1);
  const result=await f.call('create_post',postArgs('Another afternoon spent outside in the garden.'));
  assert.equal(result.result.structuredContent.status,503);
  assert.equal((await state(f)).posts.length,1);
});

test('missing key blocks public writes; private settings and feed reads remain available',async t=>{
  const f=fixture(t); delete f.env.OPENAI_API_KEY;
  const result=await f.call('create_post',postArgs('This should stay unpublished without the safety service.'));
  assert.equal(result.result.structuredContent.status,503);
  assert.equal((await state(f))?.posts?.length||0,0); assert.equal(f.calls.length,0);
  const feed=await f.call('open_turnfeed_feed',{},'alice','Alice Example');
  assert.equal(feed.result?.isError,undefined);
  assert.ok(!(await state(f))?.profiles || !Object.values((await state(f)).profiles).some(p=>p.displayName==='Alice Example'));
  const settings=await f.call('get_my_settings',{});
  assert.equal(settings.result?.isError,undefined);
  assert.equal(f.calls.length,0);
});

test('unsafe profile URLs cannot bypass the unavailable avatar upload path',async t=>{
  const f=fixture(t);
  const result=await f.call('set_profile',{avatarUrl:'https://example.com/photo.png',visibility:'public'});
  assert.equal(result.error?.code,-32602); assert.equal(f.calls.length,0);
});

test('rejected public writes still consume the durable screening allowance',async t=>{
  const f=fixture(t),actor=accountKey('alice',f.env.TURNFEED_SITE_SECRET);
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  f.db.sql.prepare('INSERT INTO turnfeed_moderation_limits (bucket,minute,count) VALUES (?,?,?)')
    .run('actor:'+actor,Math.floor(now/60000),29);
  f.mode='reject';
  rejected(await f.call('create_post',postArgs('A rejected candidate for the bounded attempt check.')));
  const limited=await f.call('create_post',postArgs('A second candidate beyond the current allowance.'));
  assert.equal(limited.result.structuredContent.code,'moderation_rate_limited');
  assert.equal(limited.result.structuredContent.status,429);
  assert.equal(f.calls.length,1);
  assert.equal((await state(f))?.posts?.length||0,0);
  assert.equal(f.db.sql.prepare("SELECT count FROM turnfeed_moderation_limits WHERE bucket='global'").get().count,1);
});

test('website photo rejection and unavailable screening never store or publish the image',async t=>{
  const f=fixture(t);
  const headers={'oai-authenticated-user-id':'alice',origin};
  const page=await worker.fetch(new Request(origin,{headers}),f.env);
  const html=await page.text();
  const token=html.match(/<form[^>]*action="\/web\/post"[^>]*>([\s\S]*?)<\/form>/)[1].match(/name="token" value="([^"]+)"/)[1];
  for (const mode of ['image','unavailable']) {
    f.mode=mode;
    const form=new FormData();form.set('token',token);form.set('text','A photo of a little orange bookmark.');
    form.append('photo',new Blob([Buffer.from(logoBase64,'base64')],{type:'image/png'}),'bookmark.png');
    const response=await worker.fetch(new Request(origin+'/web/post',{method:'POST',headers,body:form}),f.env);
    assert.equal(response.status,mode==='image'?422:503);
    assert.match(await response.text(),/A photo of a little orange bookmark/);
    assert.equal(f.objects.size,0);
    assert.equal((await state(f))?.posts?.length||0,0);
    assert.equal(f.db.sql.prepare('SELECT count(*) AS n FROM turnfeed_photos').get().n,0);
  }
  assert.ok(f.calls.some(c=>c.input.some(x=>x?.type==='image_url')));
});

test('an identical published website photo retry uses its receipt during a moderation outage',async t=>{
  const f=fixture(t),headers={'oai-authenticated-user-id':'alice',origin};
  const html=await (await worker.fetch(new Request(origin,{headers}),f.env)).text();
  const token=html.match(/<form[^>]*action="\/web\/post"[^>]*>([\s\S]*?)<\/form>/)[1].match(/name="token" value="([^"]+)"/)[1];
  const send=()=>{
    const form=new FormData(); form.set('token',token);form.set('text','An orange bookmark for a good book.');
    form.append('photo',new Blob([Buffer.from(logoBase64,'base64')],{type:'image/png'}),'bookmark.png');
    return worker.fetch(new Request(origin+'/web/post',{method:'POST',headers,body:form}),f.env);
  };
  const first=await send(); assert.equal(first.status,303);
  const count=f.calls.length; f.mode='unavailable';
  const retry=await send(); assert.equal(retry.status,303);
  assert.equal(retry.headers.get('location'),first.headers.get('location'));
  assert.equal(f.calls.length,count);assert.equal(f.objects.size,1);
  assert.equal((await state(f)).posts.length,1);
});

test('an unpublished ready image from an older version still needs screening',async t=>{
  const f=fixture(t),headers={'oai-authenticated-user-id':'alice',origin};
  const html=await (await worker.fetch(new Request(origin,{headers}),f.env)).text();
  const token=html.match(/<form[^>]*action="\/web\/post"[^>]*>([\s\S]*?)<\/form>/)[1].match(/name="token" value="([^"]+)"/)[1];
  const clientId=JSON.parse(Buffer.from(token.split('.')[0],'base64url')).clientId;
  const bytes=Buffer.from(logoBase64,'base64');
  await stageWebPhoto({db:f.db,bucket:f.env.BUCKET,owner:accountKey('alice',f.env.TURNFEED_SITE_SECRET),
    secret:f.env.TURNFEED_SITE_SECRET,bytes,mime:'image/png',clientId});
  assert.equal(f.objects.size,1); f.mode='image';
  const form=new FormData();form.set('token',token);form.set('text','A bookmark waiting to be shared.');
  form.append('photo',new Blob([bytes],{type:'image/png'}),'bookmark.png');
  const response=await worker.fetch(new Request(origin+'/web/post',{method:'POST',headers,body:form}),f.env);
  assert.equal(response.status,422); assert.equal((await state(f))?.posts?.length||0,0);
  assert.ok(f.calls.some(c=>c.input.some(x=>x?.type==='image_url')));
});
