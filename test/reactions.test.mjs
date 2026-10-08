import test from 'node:test';
import assert from 'node:assert/strict';
import { startReactions } from '../worker/reactions.mjs';

function setup(fetch) {
  const form=new EventTarget(), attrs=new Map(), calls=[], timers=new Map();
  form.dataset={reaction:'post'};
  form.getAttribute=()=>'/web/like-post';
  form.setAttribute=(k,v)=>attrs.set(k,v);form.removeAttribute=k=>attrs.delete(k);
  const button={disabled:false,setAttribute:(k,v)=>attrs.set(k,v),classList:{toggle:(k,v)=>attrs.set(k,v)}};
  const token={value:'original-token'}, label={textContent:'Like'}, count={textContent:'0'}, status={textContent:''}, icon={setAttribute:(k,v)=>attrs.set(k,v)};
  const nodes={'button[type="submit"]':button,'input[name="token"]':token,'[data-reaction-label]':label,'.reaction-count':count,'svg':icon,'[data-reaction-status]':status};
  form.querySelector=s=>nodes[s];
  const win={URLSearchParams,AbortController,setTimeout:fn=>{timers.set(1,fn);return 1;},clearTimeout:id=>timers.delete(id),
    fetch:async(...args)=>{calls.push(args);return fetch(...args);}};
  startReactions(win,{querySelectorAll:()=>[form]});
  const submit=()=>{const event=new Event('submit',{cancelable:true});form.dispatchEvent(event);return event;};
  return {submit,button,token,label,count,status,attrs,calls,timers};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const response=data=>({ok:true,json:async()=>({ok:true,liked:true,count:1,token:'undo-token',...data})});

test('one signed request updates only confirmed reaction and undo token; repeated clicks are suppressed',async()=>{
  let finish;const s=setup(()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(s.submit().defaultPrevented,true);s.submit();
  assert.equal(s.calls.length,1);assert.equal(s.button.disabled,true);
  assert.equal(s.label.textContent,'Like');assert.equal(s.count.textContent,'0');
  const [url,options]=s.calls[0];assert.equal(url,'/web/like-post');assert.equal(options.body.get('token'),'original-token');
  assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');
  finish(response());await flush();
  assert.equal(s.count.textContent,'1');assert.equal(s.token.value,'undo-token');assert.equal(s.attrs.get('aria-pressed'),'true');
  assert.equal(s.button.disabled,false);assert.equal(s.timers.size,0);
  s.submit();assert.equal(s.calls[1][1].body.get('token'),'undo-token');
  finish(response({liked:false,count:0,token:'like-again'}));await flush();
  assert.equal(s.label.textContent,'Like');assert.equal(s.attrs.get('fill'),'none');
});

test('errors and invalid responses preserve the last confirmed state without replaying the write',async()=>{
  for(const fetch of [async()=>{throw Error('network');},async()=>({ok:false}),async()=>response({count:-1})]) {
    const s=setup(fetch);s.submit();await flush();
    assert.equal(s.calls.length,1);assert.equal(s.token.value,'original-token');assert.equal(s.count.textContent,'0');
    assert.equal(s.button.disabled,false);assert.match(s.status.textContent,/not confirmed/);
  }
});

test('timeout cancels the wait without automatic retry or navigation',async()=>{
  const s=setup((url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')))));
  s.submit();[...s.timers.values()][0]();await flush();
  assert.equal(s.calls.length,1);assert.equal(s.button.disabled,false);assert.equal(s.token.value,'original-token');
  assert.match(s.status.textContent,/not confirmed/);
});
