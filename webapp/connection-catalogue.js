// Connection discovery and per-account OAuth application settings.
// This module never returns a saved secret to the browser.
const { encryptString, decryptString } = require('./crypto-tokens');
const microsoftApp = require('./microsoft-app');
// Where the person makes an app of their own for a service that signs in
// through one, and what to make there.
const guides = {
  microsoft: ['https://entra.microsoft.com/', 'Register a web application in Microsoft Entra.'],
};
// Each company's own MCP server. A tile with one connects through it and
// nothing else (no app of Closedhand's or the person's), and Closedhand's
// recall reads it like any connection. GitHub's asks for a token pasted in,
// Slack's for an app in the person's own workspace (ownApps, below); the
// rest sign in by themselves. A service with no tile connects the way
// anything does: its MCP server or an API key pasted into the box.
const remote = {
  notion: 'https://mcp.notion.com/mcp',
  atlassian: 'https://mcp.atlassian.com/v2/mcp?tools=all',
  stripe: 'https://mcp.stripe.com',
  github: 'https://api.githubcopilot.com/mcp/',
  gitlab: 'https://gitlab.com/api/v4/mcp',
  dropbox: 'https://mcp.dropbox.com/mcp',
  meta_ads: 'https://mcp.facebook.com/ads',
  slack: 'https://mcp.slack.com/mcp',
};
// A company's MCP server that signs people in only through an app they make
// with that company: it turns away an app that registers itself. Each entry
// says where to go and what to do there, in the company's own names for its
// pages. Where the company lets a short-lived token make an app (`create`),
// Closedhand makes it, with the callback address, the permissions and
// anything else it needs, uses the token that once and keeps nothing of it;
// the person pastes only the token. Any other server that turns Closedhand
// away gets the form for an app's client ID and secret (ownApp).
const ownApps = {
  slack: {
    instruction: 'Slack connects through an app in your own workspace, so your messages go straight from Slack to Closedhand.',
    link: 'https://api.slack.com/apps', linkText: 'Open Slack’s app page',
    steps: [
      'On Slack’s app page (sign in if it asks), press “Generate Token” below “Create an App” and pick your workspace.',
      'Press “Copy” under “Access Token” and paste it below. Closedhand uses it once to make the app and doesn’t keep it.',
      'Press “Allow” on Slack’s page.',
    ],
    token: 'Configuration token',
    // Slack's App Manifest API (apps.manifest.create, with a configuration
    // token): the app, its callback address, its user permissions and its
    // MCP server switched on, in one call.
    async create(token, callback, scopes, fetchFn) {
      const manifest = { display_information: { name: 'Closedhand' }, oauth_config: { redirect_urls: [callback], scopes: { user: scopes } }, settings: { is_mcp_enabled: true } };
      const response = await fetchFn('https://slack.com/api/apps.manifest.create', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, manifest: JSON.stringify(manifest) }).toString() });
      const data = await response.json().catch(() => ({}));
      if (data.ok && data.credentials && data.credentials.client_id && data.credentials.client_secret) return { clientId: data.credentials.client_id, clientSecret: data.credentials.client_secret };
      console.error('[own app] Slack did not make the app:', String(data.error || response.status), (data.errors || []).map(e => `${e.pointer}: ${e.message}`).join('; ').slice(0, 500));
      if (['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive'].includes(data.error)) throw plain('Slack didn’t take that token. Generate a new one and paste it here.');
      throw plain('Slack couldn’t make the app. Try again.');
    },
  },
};
const plain = text => Object.assign(new Error(text), { plain: true });
const MCP_CALLBACK = '/auth/mcp-oauth/callback';
const originOf = url => { try { return new URL(url).origin; } catch (_) { return null; } };
const hostName = url => { try { return new URL(url).hostname.replace(/^(www|mcp|api)\./, ''); } catch (_) { return 'this server'; } };
function validClient(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
}
function createCatalogue({db, services, userId, baseUrl, personalUrl, fetchFn = fetch}) {
  // Where a sign-in to an MCP server comes back to. One that Closedhand
  // registers for itself comes back to where it was started: this computer's
  // own address, or the personal URL when started away from it (`elsewhere`:
  // a phone can't open localhost). Through an app the person made
  // (installed_via own_app) it is always the personal URL: that one address
  // is written into their app, and most companies take only an https one.
  async function mcpCallback(row, elsewhere) {
    const personal=elsewhere||(row&&row.installed_via==='own_app')?String(await personalUrl()||'').replace(/\/+$/,''):'';
    return (personal||baseUrl)+MCP_CALLBACK;
  }
  // What the own-app form shows for an MCP server that would not let
  // Closedhand register itself: the company's steps where they are known,
  // otherwise the callback address and the permissions the server names
  // (`published`, what it says about signing in).
  const keyFor=serverUrl=>Object.keys(ownApps).find(k=>originOf(remote[k])===originOf(serverUrl));
  // The permissions a server names (`published`, what it says about signing
  // in), as far as they read as permissions.
  const scopesOf=published=>(Array.isArray(published&&published.scopes_supported)?published.scopes_supported:[])
    .filter(scope=>typeof scope==='string'&&/^[\w:.\/-]{1,100}$/.test(scope)).slice(0,100);
  async function ownApp(serverUrl, published) {
    const key=keyFor(serverUrl);
    const guide=ownApps[key]||{};
    const made=!!guide.create;
    return {name:(key&&services[key]&&services[key].name)||hostName(serverUrl),serverUrl,
      redirectUri:made?null:await mcpCallback({installed_via:'own_app'}),
      instruction:guide.instruction||'This server signs you in through an app you make with the service.',
      steps:guide.steps||[],guide:guide.link||null,linkText:guide.linkText||null,
      token:made?guide.token:null,submitText:made?'Connect':null,
      scopes:made?[]:scopesOf(published),secretOptional:!key};
  }
  // Makes the person's app with the token the company handed them, for a
  // server that has `create`, and gives back its client ID and secret.
  async function createOwnApp(serverUrl, token, published) {
    const guide=ownApps[keyFor(serverUrl)];
    if(!guide||!guide.create)throw plain('This service has no way for Closedhand to make the app.');
    if(!validClient(token))throw plain('Paste the token first.');
    return guide.create(token.trim(),await mcpCallback({installed_via:'own_app'}),scopesOf(published),fetchFn);
  }
  async function resolve(key, owner) {
    const service=services[key];
    if (!service || !owner || key==='google') return service;
    const {data,error}=await db.from('connection_clients').select('client_id,client_secret').eq('user_id',owner).eq('service',key).maybeSingle();
    if(error) throw new Error('Could not read connection settings.');
    if(!data) return service;
    const secret=decryptString(data.client_secret);
    if(!secret) throw new Error('Could not open saved connection settings. Save them again.');
    return {...service,clientId:data.client_id,clientSecret:secret,personalClient:true};
  }
  function register(app) {
    app.get('/api/connection-catalogue',async(req,res)=>{
      res.set('Cache-Control','no-store');
      const owner=userId(req); if(!owner)return res.status(401).json({error:'Sign in to view connections.'});
      try {
        const [clients,connections,mcps]=await Promise.all([
          db.from('connection_clients').select('service').eq('user_id',owner),
          db.from('connections').select('service').eq('user_id',owner),
          db.from('user_mcps').select('id,server_url,status,args,caps').eq('user_id',owner),
        ]);
        if(clients.error||connections.error||mcps.error)throw new Error('Could not load connections. Try again.');
        const own=new Set((clients.data||[]).map(x=>x.service));
        const linked=new Set((connections.data||[]).map(x=>x.service.replace(/^(google|microsoft)_extra_.+$/, '$1')));
        // A tile shows when everyone has a way in: the company's own MCP
        // server (with the steps for the app it asks for, where it asks for
        // one), a form of its own, or a sign-in that needs no developer app.
        // A sign-in this build has no app for (Microsoft, in a build without
        // Closedhand's) shows once connected or set up with the person's own.
        const rows=Object.entries(services).map(([key,s])=>{
          const ready=own.has(key)||!!(s.clientId&&s.clientSecret);
          // Microsoft without an app of the person's own signs in by code
          // through Closedhand's app, on the setup page.
          const microsoftCode=key==='microsoft'&&!ready&&!!microsoftApp.appId();
          const url=remote[key];
          const mcpLinked=url&&(mcps.data||[]).some(m=>m.status==='connected'&&m.server_url?.replace(/\/$/,'')===url.replace(/\/$/,''));
          return {key,name:s.name,description:s.description||'',logoUrl:s.logoUrl||'',connected:linked.has(key)||!!mcpLinked,
            mode:s.pasteForm?s.pasteForm:s.needsStoreDomain?'shopify':microsoftCode?'microsoft':url?'mcp':ready?'oauth':key==='google'?'google':'setup',
            url:url||null,manualMode:microsoftCode&&guides[key]?'setup':null,guide:guides[key]?.[0],instruction:guides[key]?.[1],
            redirectUri:baseUrl+'/auth/'+key+'/callback',scopes:s.scopes||[],personalClient:own.has(key)};
        }).filter(r=>r.mode!=='setup'||r.connected||r.personalClient);
        res.json({services:rows});
      } catch(e){res.status(503).json({error:e.message});}
    });
    app.put('/api/connection-catalogue/:service/client',async(req,res)=>{
      const owner=userId(req); if(!owner)return res.status(401).json({error:'Sign in to set up a connection.'});
      const key=req.params.service, service=services[key];
      if(!service||!guides[key])return res.status(400).json({error:'Use this service’s existing setup.'});
      const {clientId,clientSecret}=req.body||{};
      if(!validClient(clientId)||!validClient(clientSecret))return res.status(400).json({error:'Enter the client ID and client secret from your application.'});
      try{
        const encrypted=encryptString(clientSecret.trim());
        if(!encrypted.startsWith('enc:v1:'))throw new Error('Encrypted storage is unavailable. Check Closedhand’s settings.');
        const {error}=await db.from('connection_clients').upsert({user_id:owner,service:key,client_id:clientId.trim(),client_secret:encrypted,updated_at:new Date().toISOString()},{onConflict:'user_id,service'});
        if(error)throw new Error('Could not save connection settings. Try again.');
        res.json({redirectUrl:'/auth/'+key+(service.isSignup?'?extra=1':'')});
      }catch(e){res.status(503).json({error:e.message});}
    });
  }
  return {resolve,register,mcpCallback,ownApp,createOwnApp};
}
module.exports={createCatalogue,validClient,remote};

