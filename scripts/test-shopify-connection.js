const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { storeDomain, exchangeCredentials, inspectShop } = require('../lib/shopify-auth');
const root = path.join(__dirname, '..');

test('store addresses accept mobile-pasted domains and reject paths, credentials and lookalikes', () => {
  assert.equal(storeDomain(' HTTPS://Example.myshopify.com/ '), 'example.myshopify.com');
  assert.equal(storeDomain('example'), 'example.myshopify.com');
  for (const value of ['', null, {}, 'example.myshopify.com.evil.test', 'example.myshopify.com/admin', 'me@example.myshopify.com', 'localhost:3000', 'example.myshopify.com?x=1']) assert.throws(() => storeDomain(value));
});
test('Shopify credentials exchange has bounded lifetime, no redirects and never echoes secrets on failure', async () => {
  let calls = 0;
  const tokens = await exchangeCredentials('example', 'client', 'secret', async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.myshopify.com/admin/oauth/access_token');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
    return { ok: true, json: async () => ({access_token:'token',expires_in:86400,scope:'read_orders'}) };
  });
  assert.equal(calls, 1); assert.ok(tokens.expires_at > Date.now() + 86000000);
  await assert.rejects(exchangeCredentials('example', 'client', 'secret', async () => ({ok:false,status:401,json:async()=>({error:'secret'})})), e => !e.message.includes('secret'));
  await assert.rejects(exchangeCredentials('example', 'client', 'secret', async () => ({ok:true,json:async()=>({access_token:'token'})})), /usable connection/);
});
test('connection records only Shopify-confirmed scopes, not assumed access', async () => {
  const shop = await inspectShop('example','token', async () => ({ok:true,json:async()=>({data:{shop:{name:'Fixture shop'},currentAppInstallation:{accessScopes:[{handle:'read_products'}]}}})}));
  assert.deepEqual(shop.scopes,['read_products']);
  await assert.rejects(inspectShop('example','token',async()=>({ok:true,json:async()=>({errors:[{message:'denied'}]})})), /permissions/);
});
test('Shopify connects through the shared own-app form: the store first, no callback address, a token in the app’s place', async () => {
  class El {
    constructor(tag){this.tag=tag;this.children=[];this.hidden=false;this.className='';this.attrs={};this.listeners={};this._text='';this.value='';this.classList=new Set();this.classList.remove=this.classList.delete;}
    set textContent(t){this._text=String(t);this.children=[];}
    get textContent(){return this.hidden?'':this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join(' ');}
    set innerHTML(h){this._html=h;}
    append(...xs){this.children.push(...xs);}
    replaceChildren(){this.children=[];}
    setAttribute(k,v){this.attrs[k]=v;}
    addEventListener(type,fn){this.listeners[type]=fn;}
    click(){(this.listeners.click||this.onclick||(()=>{}))();}
    focus(){} scrollIntoView(){}
    all(pred,out=[]){for(const c of this.children)if(c instanceof El){if(pred(c))out.push(c);c.all(pred,out);}return out;}
    get elements(){return new Proxy({}, {get:(_,name)=>this.all(e=>e.tag==='input'&&e.name===name)[0]});}
  }
  const ids={};for(const id of ['catalogue-status','catalogue-retry','connection-catalogue-list','catalogue-apps-heading','catalogue-setup','catalogue-browse','mcp-section','mcp-url-input'])ids[id]=new El('div');
  let ready;const posts=[],said=[],toasts=[];
  const fetch=async(url,init)=>{
    if(url==='/api/connection-catalogue')return {ok:true,json:async()=>({services:[{key:'shopify',name:'Shopify',description:'Orders and products',logoUrl:'/logos/shopify.svg',connected:false,mode:'shopify',scopes:['read_orders'],redirectUri:'http://localhost:3000/auth/shopify/callback'}]})};
    posts.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({shopName:'Example Shop'})};
  };
  const window={needsField:(field,text)=>said.push([field.name,text]),showToast:t=>toasts.push(t),loadStatus(){},mcpGrowInput(){}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'webapp/public/connection-catalogue.js'),'utf8'),{window,fetch,setTimeout,navigator:{},AbortSignal,
    document:{getElementById:id=>ids[id],createElement:tag=>new El(tag),querySelector:()=>null,addEventListener:(t,fn)=>{ready=fn;}}});
  ready();await new Promise(r=>setImmediate(r));
  const open=()=>{ids['connection-catalogue-list'].all(e=>e.className==='catalogue-tile')[0].click();const setup=ids['catalogue-setup'];
    return {setup,form:setup.all(e=>e.className==='catalogue-form')[0],input:name=>setup.all(e=>e.tag==='input'&&e.name===name)[0]};};
  let {setup,form,input}=open();
  assert.match(setup.textContent,/Make an app in Shopify’s Dev Dashboard[\s\S]*same Shopify organization\./);
  assert.doesNotMatch(setup.textContent,/callback address|Enable these permissions/i,'Shopify gives no callback address and its app chooses its own access');
  assert.equal(setup.all(e=>e.className==='catalogue-callback').length,0);
  assert.equal(setup.all(e=>e.className==='catalogue-deep')[0].href,'https://dev.shopify.com/dashboard');
  assert.deepEqual(form.all(e=>e.tag==='input').map(e=>e.name),['storeDomain','clientId','clientSecret','accessToken']);
  assert.equal(form.all(e=>e.className==='catalogue-action')[0].textContent,'Connect store');
  assert.match(form.all(e=>e.tag==='details')[0].textContent,/Use an existing access token instead/);

  // A store address that is not one is said at its box, and nothing is sent.
  input('storeDomain').value='example.com/admin';input('clientId').value='id';input('clientSecret').value='secret';
  await form.onsubmit({preventDefault(){}});
  assert.deepEqual(said,[['storeDomain','Enter your store’s myshopify.com address, without a page path.']]);assert.equal(posts.length,0);

  // The app's ID and secret, for the store by its short name.
  input('storeDomain').value=' Example-Shop ';
  await form.onsubmit({preventDefault(){}});
  assert.deepEqual(posts,[{url:'/api/connect-shopify-token',body:{storeDomain:'example-shop.myshopify.com',clientId:'id',clientSecret:'secret'}}]);
  assert.deepEqual(toasts,['Connected to Example Shop']);
  assert.equal(setup.hidden,true,'and the form closes on the connected store');

  // A token they already hold stands in for the app.
  await new Promise(r=>setImmediate(r));
  ({setup,form,input}=open());
  input('storeDomain').value='https://example-shop.myshopify.com/';input('accessToken').value='held-token';input('accessToken').oninput();
  assert.equal(input('clientId').required,false);assert.equal(input('clientSecret').required,false);
  const token=input('accessToken');
  await form.onsubmit({preventDefault(){}});
  assert.deepEqual(posts[1],{url:'/api/connect-shopify-token',body:{storeDomain:'example-shop.myshopify.com',accessToken:'held-token'}});
  assert.equal(token.value,'','the token leaves the page once sent');

  const html=fs.readFileSync(path.join(root,'webapp/views/dashboard.html'),'utf8');
  assert.doesNotMatch(html,/shopify-modal|openShopifyModal|shopify-client-id/,'no second own-app form of Shopify’s own');
});
test('expiring Shopify access renews once for concurrent reads and leaves other users untouched', async () => {
  let exchanges=0,saves=0;
  const auth={...require('../lib/shopify-auth'),exchangeCredentials:async()=>{exchanges++;return {access_token:'renewed',client_secret:'secret',client_id:'id',expires_at:Date.now()+86400000}}};
  const db={supabase:{from:()=>({update:()=>({eq:(key,id)=>{assert.equal(key,'user_id');assert.equal(id,'fixture-user');return {eq:async()=>{saves++;return {error:null}}}}})})}};
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'lib/services/shopify.js'),'utf8'),{module:mod,Date,URL,Buffer,require:n=>n==='../context'?{}:n==='../shopify-auth'?auth:n==='../db'?db:n==='../../crypto-tokens'?{encryptTokens:t=>t}:require(n)});
  const conn={tokens:{access_token:'expired',client_secret:'secret',client_id:'id',expires_at:1},metadata:{shopDomain:'example.myshopify.com'}};
  const store={userId:'fixture-user',connections:{shopify:conn},getConnection:()=>conn,saveConnectionTokens:async(_,t)=>{saves++;conn.tokens=t}};
  assert.deepEqual(Array.from(await Promise.all([mod.exports.freshShopifyToken(store),mod.exports.freshShopifyToken(store)])),['renewed','renewed']);
  assert.equal(exchanges,1);assert.equal(saves,1);
  const other={getConnection:()=>({tokens:{access_token:'other'}})};
  assert.equal(await mod.exports.freshShopifyToken(other),'other');assert.equal(exchanges,1);
});
test('Shopify app secret is encrypted in both service copies', () => {
  process.env.TOKEN_ENCRYPTION_KEY=require('node:crypto').randomBytes(32).toString('base64');
  for (const file of ['crypto-tokens.js','webapp/crypto-tokens.js']) {
    const crypto=require(path.join(root,file));const encoded=crypto.encryptTokens({client_secret:'fixture-secret',access_token:'token'});
    assert.ok(encoded.client_secret.startsWith('enc:v1:'));assert.equal(crypto.decryptTokens(encoded).client_secret,'fixture-secret');
  }
});
test('Shopify connection endpoint sits behind the login, persists encrypted data, and does not claim success on failed writes', async () => {
  const src=fs.readFileSync(path.join(root,'webapp/server.js'),'utf8');const start=src.indexOf('app.post("/api/connect-shopify-token",');
  let handler,code=200,payload,row,user='fixture-user',fail=false;
  const auth={storeDomain,exchangeCredentials:async()=>({access_token:'new',client_secret:'secret'}),inspectShop:async()=>({name:'Fixture',scopes:['read_orders']})};
  vm.runInNewContext(src.slice(start,src.indexOf('\n});',start)+4),{Date,app:{post:(_,fn)=>{handler=fn}},getUserIdFromRequest:()=>user,
    supabase:{from:()=>({upsert:async r=>{row=r;return {error:fail?{message:'failed'}:null}}})},mustWrite:async(_,q)=>{if((await q).error)throw Error('write failed')},
    require:n=>n==='./shopify-auth'?auth:{encryptTokens:t=>({access_token:'encrypted',client_secret:'encrypted'})}});
  const res={status(c){code=c;return this},json(v){payload=v}};
  await handler({body:{storeDomain:'example',clientId:'client',clientSecret:'secret'}},res);
  assert.equal(payload.success,true);assert.equal(row.user_id,user);assert.equal(row.tokens.client_secret,'encrypted');
  fail=true;await handler({body:{storeDomain:'example',accessToken:'token'}},res);assert.equal(code,400);assert.equal(payload.success,undefined);
  // Who may ask is the login gate's to decide, for every route registered after it.
  assert.ok(start>src.indexOf('const SIGNED_BY_BRIDGE'),'registered after the login gate');
});
