// An MCP server that signs people in only through an app they make with the
// service (it turns away an app that registers itself, as Slack's does). The
// whole way through, with the real MCP library against a stand-in server:
// Closedhand is turned away and says what the app needs, the pasted client
// ID starts the sign-in, and the sign-in comes back to a saved connection.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const vm=require('node:vm');
process.env.TOKEN_ENCRYPTION_KEY=crypto.randomBytes(32).toString('base64');
const mcp=require('../webapp/mcp-client');
const {createCatalogue}=require('../webapp/connection-catalogue');

const PERSONAL='https://example-name.closedhand.ai';
const CALLBACK=PERSONAL+'/auth/mcp-oauth/callback';
const catalogueWith=(personal,services={slack:{name:'Slack'}},fetchFn)=>createCatalogue({db:null,services,userId:()=>'person-1',baseUrl:'http://localhost:3000',personalUrl:async()=>personal,fetchFn});

// A server like Slack's: it names its sign-in pages and permissions, has no
// way for an app to register itself, and hands out a token only to the app
// whose secret it knows, for the callback address that app was given. With
// `registers`, one like most: any app may register itself, with the callback
// address it wants its sign-ins sent back to.
async function standIn({registers=false}={}){
  const state={challenge:null,tokenAsks:[],registered:[]};
  const server=http.createServer(async(req,res)=>{
    const base='http://127.0.0.1:'+server.address().port;
    const send=(code,body,headers={})=>{res.writeHead(code,{'Content-Type':'application/json',...headers});res.end(body===undefined?'':JSON.stringify(body));};
    let raw='';for await(const chunk of req)raw+=chunk;
    if(req.url==='/.well-known/oauth-protected-resource')return send(200,{resource:base,authorization_servers:[base],scopes_supported:['notes:read','notes:write']});
    if(req.url==='/.well-known/oauth-authorization-server')return send(200,{issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',
      response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],
      ...(registers?{registration_endpoint:base+'/register',token_endpoint_auth_methods_supported:['none']}:{token_endpoint_auth_methods_supported:['client_secret_post']})});
    if(req.url==='/register'&&registers){
      const asked=JSON.parse(raw);state.registered.push(asked.redirect_uris);
      return send(201,{...asked,client_id:'registered-'+state.registered.length});
    }
    if(req.url==='/token'){
      const form=Object.fromEntries(new URLSearchParams(raw));state.tokenAsks.push(form);
      const proved=crypto.createHash('sha256').update(form.code_verifier||'').digest('base64url')===state.challenge;
      if(form.client_id!=='app-1'||form.client_secret!=='app-secret'||form.code!=='code-1'||form.redirect_uri!==CALLBACK||!proved)return send(400,{error:'invalid_grant'});
      return send(200,{access_token:'token-1',token_type:'Bearer',expires_in:3600,refresh_token:'refresh-1',scope:'notes:read notes:write'});
    }
    if(req.url==='/mcp'&&req.method==='POST'){
      if(req.headers.authorization!=='Bearer token-1')return send(401,{error:'sign in'},{'WWW-Authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`});
      const call=JSON.parse(raw);
      if(call.method==='initialize')return send(200,{jsonrpc:'2.0',id:call.id,result:{protocolVersion:call.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Notes',version:'1'}}});
      if(call.method==='tools/list')return send(200,{jsonrpc:'2.0',id:call.id,result:{tools:[{name:'find_notes',inputSchema:{type:'object'}}]}});
      return call.id===undefined?send(202):send(200,{jsonrpc:'2.0',id:call.id,result:{}});
    }
    send(req.url==='/mcp'?405:404,{error:'not here'});
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  return {url:'http://127.0.0.1:'+server.address().port+'/mcp',state,close:()=>new Promise(done=>{server.closeAllConnections();server.close(done);})};
}

// The connect route, the sign-in callback and what opens a connection for
// them, as written in the webapp, around the real client and catalogue.
function webapp(catalogue){
  const src=fs.readFileSync(path.join(__dirname,'../webapp/server.js'),'utf8');
  const cut=(from,to)=>{const a=src.indexOf(from);assert.ok(a>=0,from);const b=src.indexOf(to,a);assert.ok(b>a,to);return src.slice(a,b);};
  const routes={},saved=[],oauthStates=new Map();
  const callbackRoute=cut('// What a sign-in that did not finish says','\n// OAuth callback for any service');
  const resolver=require('../webapp/mcp-input-resolver');
  vm.runInNewContext([
    cut('async function mcpOpenForDiscovery','\nasync function scanModelFor'),
    cut('async function connectMcpHandler','\n// Connecting Google or Microsoft through'),
    callbackRoute,
    'routes.connect=connectMcpHandler;routes.open=mcpOpenForDiscovery;',
  ].join('\n'),{
    routes,app:{get:(route,handler)=>{routes[route]=handler;}},console:{log(){},error(){}},crypto,URL,
    mcpClient:mcp,connectionCatalogue:catalogue,oauthStates,
    consumeOAuthState:key=>{const found=oauthStates.get(key);oauthStates.delete(key);return found||null;},
    getUserIdFromRequest:()=>'person-1',fromElsewhere:req=>!!req.elsewhere,apiKeys:{bareKey:()=>false},mcpHost:url=>new URL(url).hostname,
    require:name=>name==='./mcp-input-resolver'?{...resolver,resolveInput:async()=>null}:require(name),
    mcpDiscoverAndScan:async client=>({found:{tools:(await client.listTools()).tools,serverInfo:client.getServerVersion()},verdict:null}),
    mcpSaveRow:async(userId,row,found)=>{saved.push({userId,row:{...row},found});return {id:'row-1',name:found.serverInfo.name};},
  });
  const ask=async(body,elsewhere=false)=>{let reply;await routes.connect({body,elsewhere},{json(v){reply=v;return this;},status(){return this;}});return reply;};
  const comeBack=async query=>{let to;await routes['/auth/mcp-oauth/callback']({query},{redirect(v){to=decodeURIComponent(v);}});return to;};
  return {ask,comeBack,open:routes.open,routes,saved,oauthStates};
}

test('a server that turns Closedhand away is connected through an app the person made',async()=>{
  const server=await standIn(),app=webapp(catalogueWith(PERSONAL));
  try{
    // Turned away: the reply carries what the own-app form shows.
    const first=await app.ask({input:server.url});
    assert.equal(first.needs_credentials,true);
    assert.equal(first.own_app.redirectUri,CALLBACK,'the callback address to give the app is the personal URL');
    assert.deepEqual(first.own_app.scopes,['notes:read','notes:write'],'and the permissions are the ones the server names');
    assert.equal(first.own_app.serverUrl,server.url);
    assert.equal(first.own_app.secretOptional,true,'a server Closedhand has no steps for may take an app with no secret');
    assert.equal(app.oauthStates.size,0);

    // The app's client ID and secret start the sign-in at the service.
    const second=await app.ask({input:server.url,client_id:' app-1 ',client_secret:'app-secret'});
    assert.equal(second.auth_required,true);
    const signIn=new URL(second.redirect_url);
    assert.equal(signIn.pathname,'/authorize');
    assert.equal(signIn.searchParams.get('client_id'),'app-1');
    assert.equal(signIn.searchParams.get('redirect_uri'),CALLBACK,'the sign-in comes back to the address written into the app');
    assert.equal(signIn.searchParams.get('scope'),'notes:read notes:write');
    assert.equal(signIn.searchParams.get('code_challenge_method'),'S256');
    assert.equal(/app-secret/.test(second.redirect_url),false,'the secret never rides in the address');
    server.state.challenge=signIn.searchParams.get('code_challenge');

    // Back from the service: the code is swapped with the app's secret, and
    // the connection is saved signed in, marked as through the person's app.
    const landed=await app.comeBack({code:'code-1',state:signIn.searchParams.get('state')});
    assert.match(landed,/^\/dashboard\?mcp_connected=Notes/);
    assert.equal(server.state.tokenAsks.length,1);
    const {row,found,userId}=app.saved[0];
    assert.equal(userId,'person-1');
    assert.equal(row.auth_token,'token-1');assert.equal(row.oauth_refresh_token,'refresh-1');
    assert.equal(row.oauth_client_id,'app-1');assert.equal(row.oauth_client_secret,'app-secret');
    assert.equal(row.installed_via,'own_app','so signing in again later uses the same callback address');
    assert.equal(found.tools[0].name,'find_notes');

    // A reused sign-in saves nothing, and says so in words for the person.
    assert.equal(await app.comeBack({code:'code-1',state:signIn.searchParams.get('state')}),'/dashboard?mcp_error=That sign-in took too long or was already used. Start it again.');
    assert.equal(app.saved.length,1);
  }finally{await server.close();}
});

test('a sign-in that does not finish says what to do, never what the service or the library said',async()=>{
  const server=await standIn(),app=webapp(catalogueWith(PERSONAL));
  try{
    assert.equal(await app.comeBack({error:'access_denied',state:'any'}),'/dashboard?mcp_error=The sign-in was cancelled.');
    assert.equal(await app.comeBack({error:'server_error',state:'any'}),'/dashboard?mcp_error=The service turned the sign-in down. Try again.');
    // The app's secret was pasted wrong: the service refuses the swap.
    const started=await app.ask({input:server.url,client_id:'app-1',client_secret:'not-the-secret'});
    const signIn=new URL(started.redirect_url);server.state.challenge=signIn.searchParams.get('code_challenge');
    const landed=await app.comeBack({code:'code-1',state:signIn.searchParams.get('state')});
    assert.equal(landed,'/dashboard?mcp_error=The service did not accept your app’s client ID or secret. Check them and try again.');
    assert.equal(/invalid_grant|Error|400/.test(landed),false);
    assert.equal(app.saved.length,0);
  }finally{await server.close();}
});

test('a sign-in Closedhand registers for itself comes back to where it was started',async()=>{
  const LOCAL='http://localhost:3000/auth/mcp-oauth/callback';
  const server=await standIn({registers:true}),app=webapp(catalogueWith(PERSONAL));
  try{
    // On the computer itself: back to its own address.
    const here=new URL((await app.ask({input:server.url})).redirect_url);
    assert.equal(here.searchParams.get('redirect_uri'),LOCAL);
    // From a phone, through the personal URL: localhost opens nothing there.
    const away=new URL((await app.ask({input:server.url},true)).redirect_url);
    assert.equal(away.searchParams.get('redirect_uri'),CALLBACK);
    assert.deepEqual(server.state.registered,[[LOCAL],[CALLBACK]],'each registered with the address it then used');

    // Signing in again later, from the other place: the app registered then
    // knows only the old address, so Closedhand registers again for this one.
    const row={server_url:server.url,transport:'http',auth_type:'oauth',auth_token:'no-longer-taken',oauth_client_id:'registered-1',installed_via:'oauth'};
    const again=await app.open(row,{allowOAuth:true,state:'state-2',callback:CALLBACK}).then(()=>null,e=>e);
    const next=new URL(again.redirectUrl);
    assert.equal(next.searchParams.get('client_id'),'registered-3');
    assert.equal(next.searchParams.get('redirect_uri'),CALLBACK);
    assert.deepEqual(server.state.registered[2],[CALLBACK]);
    assert.equal(row.oauth_client_id,'registered-3');

    // An app the person made is theirs: never swapped for a registered one.
    const own={server_url:server.url,transport:'http',auth_type:'oauth',auth_token:'no-longer-taken',oauth_client_id:'app-1',oauth_client_secret:'app-secret',installed_via:'own_app'};
    const kept=await app.open(own,{allowOAuth:true,state:'state-3',callback:CALLBACK}).then(()=>null,e=>e);
    assert.equal(new URL(kept.redirectUrl).searchParams.get('client_id'),'app-1');
    assert.equal(server.state.registered.length,3);
  }finally{await server.close();}
});

test('the callback address: this computer for a sign-in Closedhand registered, the personal URL for the person’s own app',async()=>{
  const claimed=catalogueWith(PERSONAL+'/'),unclaimed=catalogueWith(null);
  assert.equal(await claimed.mcpCallback({installed_via:'oauth'}),'http://localhost:3000/auth/mcp-oauth/callback');
  assert.equal(await claimed.mcpCallback({installed_via:'oauth'},true),CALLBACK,'started away from this computer, the personal URL');
  assert.equal(await unclaimed.mcpCallback({},true),'http://localhost:3000/auth/mcp-oauth/callback');
  assert.equal(await claimed.mcpCallback({}),'http://localhost:3000/auth/mcp-oauth/callback');
  assert.equal(await claimed.mcpCallback({installed_via:'own_app'}),CALLBACK);
  assert.equal(await unclaimed.mcpCallback({installed_via:'own_app'}),'http://localhost:3000/auth/mcp-oauth/callback','with no personal URL yet, this computer');
});

test('Slack’s app is made by Closedhand from a token: its callback address, permissions and MCP server in one call',async()=>{
  const asked=[];
  let answer={ok:true,app_id:'A0FIXTURE',credentials:{client_id:'1111.2222',client_secret:'made-secret',verification_token:'v',signing_secret:'s'}};
  const fetchFn=async(url,init)=>{asked.push({url,init});return {status:200,json:async()=>answer};};
  const catalogue=catalogueWith(PERSONAL,undefined,fetchFn);
  const slack=await catalogue.ownApp('https://mcp.slack.com/mcp',{scopes_supported:['chat:write']});
  assert.equal(slack.name,'Slack');
  assert.equal(slack.steps.length,3);
  assert.match(slack.steps.join(' '),/“Generate Token”[\s\S]*“Copy” under “Access Token”[\s\S]*“Allow”/,'the buttons Slack shows, and the access token, not the refresh token beside it');
  assert.equal(slack.guide,'https://api.slack.com/apps','the app list, where its configuration tokens are made');
  assert.equal(slack.token,'Configuration token');
  assert.deepEqual([slack.redirectUri,slack.scopes],[null,[]],'nothing to copy across: Closedhand writes both into the app');

  const made=await catalogue.createOwnApp('https://mcp.slack.com/mcp','  xoxe.xoxp-1-fixture  ',{scopes_supported:['chat:write','search:read.public','not a scope',7]});
  assert.deepEqual(made,{clientId:'1111.2222',clientSecret:'made-secret'});
  assert.equal(asked.length,1);
  assert.equal(asked[0].url,'https://slack.com/api/apps.manifest.create');
  const form=new URLSearchParams(asked[0].init.body);
  assert.equal(form.get('token'),'xoxe.xoxp-1-fixture');
  assert.deepEqual(JSON.parse(form.get('manifest')),{display_information:{name:'Closedhand'},oauth_config:{redirect_urls:[CALLBACK],scopes:{user:['chat:write','search:read.public']}},settings:{is_mcp_enabled:true}},
    'the personal URL to come back to, only well-formed permissions from the server, and the MCP server on');

  // What Slack refuses is said in words the person can act on.
  answer={ok:false,error:'invalid_auth'};
  await assert.rejects(catalogue.createOwnApp('https://mcp.slack.com/mcp','xoxe.xoxp-1-old',{}),{plain:true,message:'Slack didn’t take that token. Generate a new one and paste it here.'});
  answer={ok:false,error:'invalid_manifest',errors:[{pointer:'/settings',message:'fixture'}]};
  await assert.rejects(catalogue.createOwnApp('https://mcp.slack.com/mcp','xoxe.xoxp-1-fixture',{}),{plain:true,message:'Slack couldn’t make the app. Try again.'});
  await assert.rejects(catalogue.createOwnApp('https://mcp.slack.com/mcp','',{}),{plain:true});
  await assert.rejects(catalogue.createOwnApp('https://mcp.example-crm.test/v1','token',{}),/no way for Closedhand to make the app/);
  assert.equal(asked.length,3,'no call to Slack without a token, nor for another service');

  // Any other server: the form for an app's client ID and secret, by its
  // address, with nothing invented.
  const other=await catalogue.ownApp('https://mcp.example-crm.test/v1',{scopes_supported:['crm.read']});
  assert.equal(other.name,'example-crm.test');
  assert.deepEqual([other.steps,other.token,other.guide,other.scopes,other.redirectUri],[[],null,null,['crm.read'],CALLBACK]);
});

test('a token pasted in the form makes the app, and the sign-in starts with it',async()=>{
  const server=await standIn(),real=catalogueWith(PERSONAL),tokens=[];
  const app=webapp({...real,createOwnApp:async(url,token,published)=>{tokens.push([url,token,published&&published.scopes_supported]);return {clientId:'app-1',clientSecret:'app-secret'};}});
  try{
    const started=await app.ask({input:server.url,app_token:'xoxe.xoxp-1-fixture'});
    assert.deepEqual(tokens,[[server.url,'xoxe.xoxp-1-fixture',['notes:read','notes:write']]],'with the permissions the server names');
    const signIn=new URL(started.redirect_url);
    assert.equal(signIn.searchParams.get('client_id'),'app-1');
    assert.equal(signIn.searchParams.get('redirect_uri'),CALLBACK);
    server.state.challenge=signIn.searchParams.get('code_challenge');
    assert.match(await app.comeBack({code:'code-1',state:signIn.searchParams.get('state')}),/mcp_connected=Notes/);
    const {row}=app.saved[0];
    assert.equal(row.installed_via,'own_app');
    assert.equal(JSON.stringify(row).includes('xoxe.xoxp-1-fixture'),false,'the token is kept nowhere');
    // A refusal from the company comes back as the form's message.
    const refused=webapp({...real,createOwnApp:async()=>{throw Object.assign(new Error('Slack didn’t take that token. Generate a new one and paste it here.'),{plain:true});}});
    let code,reply;await refused.routes.connect({body:{input:server.url,app_token:'old'}},{status(c){code=c;return this;},json(v){reply=v;return this;}});
    assert.equal(code,400);assert.equal(reply.error,'Slack didn’t take that token. Generate a new one and paste it here.');
  }finally{await server.close();}
});

test('the dashboard has one own-app form, and the paste box opens it instead of fields of its own',()=>{
  const page=fs.readFileSync(path.join(__dirname,'../webapp/views/dashboard.html'),'utf8');
  const script=fs.readFileSync(path.join(__dirname,'../webapp/public/connection-catalogue.js'),'utf8');
  assert.equal(script.split('function ownAppForm(').length,2);
  assert.equal(script.split('ownAppForm(').length,5,'the catalogue’s own-app tiles, Shopify and MCP servers share it');
  assert.equal(/client[-_ ]?secret/i.test(page.slice(page.indexOf('id="mcp-credentials"'),page.indexOf('id="mcp-own-app"'))),false,'no second place to type an app’s secret');
  assert.match(page,/openOwnApp\(ownApp\)/);
  assert.match(page,/showToast\(decodeURIComponent\(params\.get\("mcp_connected"\)\) \+ " connected"\);/,'connected through a server reads as any connection does');
});
