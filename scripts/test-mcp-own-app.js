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
const catalogueWith=(personal,services={slack:{name:'Slack'}})=>createCatalogue({db:null,services,userId:()=>'person-1',baseUrl:'http://localhost:3000',personalUrl:async()=>personal});

// A server like Slack's: it names its sign-in pages and permissions, has no
// way for an app to register itself, and hands out a token only to the app
// whose secret it knows, for the callback address that app was given.
async function standIn(){
  const state={challenge:null,tokenAsks:[]};
  const server=http.createServer(async(req,res)=>{
    const base='http://127.0.0.1:'+server.address().port;
    const send=(code,body,headers={})=>{res.writeHead(code,{'Content-Type':'application/json',...headers});res.end(body===undefined?'':JSON.stringify(body));};
    let raw='';for await(const chunk of req)raw+=chunk;
    if(req.url==='/.well-known/oauth-protected-resource')return send(200,{resource:base,authorization_servers:[base],scopes_supported:['notes:read','notes:write']});
    if(req.url==='/.well-known/oauth-authorization-server')return send(200,{issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',
      response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['client_secret_post']});
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
  const resolver=require('../webapp/mcp-input-resolver');
  vm.runInNewContext([
    cut('async function mcpOpenForDiscovery','\nasync function scanModelFor'),
    cut('async function connectMcpHandler','\n// Connecting Google or Microsoft through'),
    cut('app.get("/auth/mcp-oauth/callback"','\n// OAuth callback for any service'),
    'routes.connect=connectMcpHandler;',
  ].join('\n'),{
    routes,app:{get:(route,handler)=>{routes[route]=handler;}},console:{log(){},error(){}},crypto,URL,
    mcpClient:mcp,connectionCatalogue:catalogue,oauthStates,
    consumeOAuthState:key=>{const found=oauthStates.get(key);oauthStates.delete(key);return found||null;},
    getUserIdFromRequest:()=>'person-1',apiKeys:{bareKey:()=>false},mcpHost:url=>new URL(url).hostname,
    require:name=>name==='./mcp-input-resolver'?{...resolver,resolveInput:async()=>null}:require(name),
    mcpDiscoverAndScan:async client=>({found:{tools:(await client.listTools()).tools,serverInfo:client.getServerVersion()},verdict:null}),
    mcpSaveRow:async(userId,row,found)=>{saved.push({userId,row:{...row},found});return {id:'row-1',name:found.serverInfo.name};},
  });
  const ask=async body=>{let reply;await routes.connect({body},{json(v){reply=v;return this;},status(){return this;}});return reply;};
  const comeBack=async query=>{let to;await routes['/auth/mcp-oauth/callback']({query},{redirect(v){to=v;}});return to;};
  return {ask,comeBack,saved,oauthStates};
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

    // A wrong code or a reused sign-in saves nothing.
    assert.match(await app.comeBack({code:'code-1',state:signIn.searchParams.get('state')}),/mcp_error=invalid_state/);
    assert.equal(app.saved.length,1);
  }finally{await server.close();}
});

test('the callback address: this computer for a sign-in Closedhand registered, the personal URL for the person’s own app',async()=>{
  const claimed=catalogueWith(PERSONAL+'/'),unclaimed=catalogueWith(null);
  assert.equal(await claimed.mcpCallback({installed_via:'oauth'}),'http://localhost:3000/auth/mcp-oauth/callback');
  assert.equal(await claimed.mcpCallback({}),'http://localhost:3000/auth/mcp-oauth/callback');
  assert.equal(await claimed.mcpCallback({installed_via:'own_app'}),CALLBACK);
  assert.equal(await unclaimed.mcpCallback({installed_via:'own_app'}),'http://localhost:3000/auth/mcp-oauth/callback','with no personal URL yet, this computer');
});

test('Slack’s server gets Slack’s steps and a manifest with the callback address and permissions in it',async()=>{
  const catalogue=catalogueWith(PERSONAL);
  const slack=await catalogue.ownApp('https://mcp.slack.com/mcp',{scopes_supported:['chat:write','search:read.public','not a scope',7]});
  assert.equal(slack.name,'Slack');
  assert.equal(slack.steps.length,4);
  assert.match(slack.guide,/^https:\/\/api\.slack\.com\/apps/);
  assert.equal(slack.secretOptional,false);
  assert.deepEqual(JSON.parse(slack.copy.text),{display_information:{name:'Closedhand'},oauth_config:{redirect_urls:[CALLBACK],scopes:{user:['chat:write','search:read.public']}}},
    'only well-formed permissions from the server go into the manifest');
  assert.deepEqual(slack.scopes,[],'the manifest already lists them');
  // Any other server: the same form, by its address, with nothing invented.
  const other=await catalogue.ownApp('https://mcp.example-crm.test/v1',{scopes_supported:['crm.read']});
  assert.equal(other.name,'example-crm.test');
  assert.deepEqual([other.steps,other.copy,other.guide,other.scopes,other.redirectUri],[[],null,null,['crm.read'],CALLBACK]);
});

test('the dashboard has one own-app form, and the paste box opens it instead of fields of its own',()=>{
  const page=fs.readFileSync(path.join(__dirname,'../webapp/views/dashboard.html'),'utf8');
  const script=fs.readFileSync(path.join(__dirname,'../webapp/public/connection-catalogue.js'),'utf8');
  assert.equal(script.split('function ownAppForm(').length,2);
  assert.equal(script.split('ownAppForm(').length,4,'the catalogue’s own-app tiles and MCP servers share it');
  assert.equal(/client[-_ ]?secret/i.test(page.slice(page.indexOf('id="mcp-credentials"'),page.indexOf('id="mcp-own-app"'))),false,'no second place to type an app’s secret');
  assert.match(page,/openOwnApp\(ownApp\)/);
});
