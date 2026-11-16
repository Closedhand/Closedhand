(() => {
  let services=[], loaded=false, loading=false;
  const byId=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  // The web chat's copy icon, and a tick once copied.
  const COPY_ICON='<svg width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  const DONE_ICON='<svg width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  // What went wrong, in words meant for the person: the server's own, or the
  // plain fallback. A script's error ("Cannot read properties of undefined")
  // or the browser's ("Failed to fetch") never shows.
  const said=(e,fallback)=>e&&e.plain?e.message:fallback;
  const plain=text=>Object.assign(new Error(text),{plain:true});
  async function loadCatalogue() {
    if(loading)return;
    loading=true;byId('catalogue-retry').hidden=true;
    byId('catalogue-status').textContent='Loading connections…';
    try {
      const response=await fetch('/api/connection-catalogue',{cache:'no-store'});
      const data=await response.json();
      if(!response.ok)throw plain(data.error||'Could not load connections.');
      if(!Array.isArray(data.services))throw plain('Could not load connections.');
      services=data.services;loaded=true;
      byId('catalogue-status').textContent='';
      render(query);
    }catch(e){byId('catalogue-status').textContent=said(e,'Could not load connections.');byId('catalogue-retry').hidden=false;}finally{loading=false;}
  }
  // Connected apps live under "Connected"; this list holds the rest, as
  // tiles. The search at the top of the tab narrows it.
  let query='';
  function render(q=query) {
    query=q;
    const list=byId('connection-catalogue-list');list.replaceChildren();
    const term=q.trim().toLowerCase();
    const open=services.filter(s=>!s.connected);
    // Banks are one tile: the service depends on where the bank is, so the
    // region is asked for after the tap.
    const banks=open.filter(s=>BANKS[s.mode]);
    const tiles=open.filter(s=>!BANKS[s.mode]).concat(banks.length?[{key:'banks',name:'Banks',mode:'banks',banks,logoUrl:banks[0].logoUrl,
      description:'Bank balances and transactions, read-only. '+BANK_WHERE}]:[]);
    const visible=tiles.filter(s=>(s.name+' '+s.description).toLowerCase().includes(term))
      .sort((a,b)=>a.name.localeCompare(b.name));
    visible.forEach(s=>{
      const tile=el('button','catalogue-tile');tile.type='button';tile.title=s.description||'';
      tile.setAttribute('aria-label','Connect '+s.name);
      const logo=el('img');logo.src=s.logoUrl;logo.alt='';logo.width=24;logo.height=24;
      tile.append(logo,el('span','',s.name));
      tile.addEventListener('click',()=>choose(s,tile));
      list.append(tile);
    });
    byId('catalogue-apps-heading').hidden=!visible.length&&!!term;
    if(!visible.length&&!term)list.append(el('p','catalogue-empty',open.length?'':'Every app here is connected.'));
  }
  // An app with a quick route and an own-app route asks which, in its own
  // view; any other goes straight to its route.
  function choose(s,tile){
    if(s.mode==='banks'){chooseBank(s);return;}
    if(!(['mcp','microsoft'].includes(s.mode)&&s.manualMode)){select(s,tile);return;}
    const {box,title}=openSetup(s);
    const help=el('p','',s.description||'');
    const quick=el('button','catalogue-action','Connect '+s.name);quick.type='button';
    quick.onclick=()=>{closeSetup();select(s,quick);};
    const own=el('button','catalogue-quiet','Use your own '+s.name+' app instead');own.type='button';
    own.onclick=()=>select({...s,mode:s.manualMode},own);
    const actions=el('div','catalogue-choice');actions.append(quick,own);
    box.append(help,actions);title.focus();
  }
  function closeSetup(){
    const box=byId('catalogue-setup'),mcp=document.querySelector('#connection-catalogue .mcp-hero');
    box.hidden=true;box.replaceChildren();byId('catalogue-browse').hidden=false;if(mcp)mcp.hidden=false;
    byId('mcp-section').classList.remove('setting-up');
  }
  // One connection's setup stands alone: the paste box and the Mac card
  // belong to browsing, and around a form they read as its steps.
  function openSetup(s){
    const box=byId('catalogue-setup'),mcp=document.querySelector('#connection-catalogue .mcp-hero');
    box.replaceChildren();box.hidden=false;byId('mcp-section').classList.add('setting-up');
    byId('catalogue-browse').hidden=true;if(mcp)mcp.hidden=true;
    const back=el('button','catalogue-return');back.type='button';
    back.innerHTML='<svg width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
    back.append('Back to connections');
    back.onclick=()=>{closeSetup();const first=document.querySelector('#connection-catalogue-list .catalogue-tile');if(first)first.focus();};
    const title=el('h3','', 'Connect '+s.name);title.tabIndex=-1;
    box.append(back,title);
    return {box,title};
  }
  // A bank, read-only, through a service the person signs up to and pays
  // themselves: SimpleFIN for US banks, Lunch Flow for UK and EU banks. They
  // paste what it hands out; Closedhand keeps it encrypted.
  // On Railway (Go always-on) Closedhand lives in the person's own Railway
  // account, not on their computer (webapp/assets.js marks the page).
  const HOME=typeof document!=='undefined'&&document.documentElement&&document.documentElement.dataset.host==='railway'?'in your Railway account':'on your computer';
  const BANKS={
    simplefin:{
      intro:'SimpleFIN is a service you sign up to yourself, for about $15 a year paid to SimpleFIN. Your bank data goes from your bank through SimpleFIN to Closedhand '+HOME+' and never to closedhand.com. Closedhand can only read it: it can’t move money or change anything at your bank.',
      steps:['Open SimpleFIN, click “Get Started” and enter your email. Sign in with the link SimpleFIN emails you.','Under “Financial Institutions”, click “New Connection” and link your US bank. SimpleFIN asks you to subscribe before the first one.','Under “Apps”, click “New Connection”, name it Closedhand and click “Create Setup Token”. Copy the token it shows.','Paste it below. A Setup Token works once: Closedhand swaps it straight away for its own access, kept encrypted on the computer running Closedhand.'],
      link:'https://bridge.simplefin.org/simplefin/create',linkText:'Open SimpleFIN',label:'Setup Token',field:'setupToken',url:'/api/bank/simplefin',
    },
    lunchflow:{
      intro:'Lunch Flow is a paid service you sign up to yourself and pay directly. Your bank data goes from your bank through Lunch Flow to Closedhand '+HOME+' and never to closedhand.com. Closedhand can only read it: it can’t move money or change anything at your bank.',
      steps:['Open Lunch Flow and sign up.','Go to “Connections”, click “+ New Connection”, find your bank and approve it at your bank. Do this for each UK or EU bank you want.','Go to “Destinations”, click “Add Destination” and pick “REST API”, the option for apps like Closedhand. Copy the key Lunch Flow shows you.','On that same page, under “Account Access”, switch on each account you want Closedhand to see.','Paste the key below. Closedhand keeps it encrypted on the computer running Closedhand.'],
      link:'https://www.lunchflow.app/',linkText:'Open Lunch Flow',label:'API key',field:'apiKey',url:'/api/bank/lunchflow',
    },
  };
  const BANK_WHERE='UK and EU banks connect through Lunch Flow, US banks through SimpleFIN.';
  const BANK_CHOICES={lunchflow:'UK or EU bank',simplefin:'US bank'};
  // Where the bank is decides the service; with one left, its form at once.
  function chooseBank(tile){
    if(tile.banks.length===1){bankForm(tile.banks[0]);return;}
    const {box,title}=openSetup({name:'your bank'});
    const actions=el('div','catalogue-choice');
    for(const mode of Object.keys(BANK_CHOICES)){
      const bank=tile.banks.find(b=>b.mode===mode);
      const pick=el('button','catalogue-action',BANK_CHOICES[mode]);pick.type='button';pick.onclick=()=>bankForm(bank);
      actions.append(pick);
    }
    box.append(el('p','','Where is your bank? '+BANK_WHERE),actions);title.focus();
  }
  const amount=n=>Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  function bankForm(s){
    const b=BANKS[s.mode];
    const {box,title}=openSetup(s);
    const intro=el('p','',b.intro);
    const steps=el('ol','catalogue-steps');b.steps.forEach(t=>steps.append(el('li','',t)));
    const link=el('a','catalogue-deep',b.linkText);link.href=b.link;link.target='_blank';link.rel='noopener noreferrer';
    const form=el('form','catalogue-form');
    const label=el('label','',b.label),input=el('input');input.type='password';input.name=b.field;input.required=true;input.maxLength=4096;input.autocomplete='off';input.spellcheck=false;label.append(input);
    const status=el('p','catalogue-status');status.setAttribute('role','status');
    const submit=el('button','catalogue-action','Connect');submit.type='submit';
    form.append(label,submit,status);
    form.onsubmit=async event=>{
      event.preventDefault();submit.disabled=true;status.textContent='Connecting…';
      try{
        const response=await fetch(b.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[b.field]:input.value})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw plain(data.error||'Could not connect. Try again.');
        input.value='';
        [intro,steps,link,form].forEach(n=>{n.hidden=true;});
        const accounts=data.accounts||[];
        box.append(el('p','',accounts.length?'Connected. Closedhand can now read '+(accounts.length===1?'this account:':'these '+accounts.length+' accounts:'):'Connected.'));
        if(accounts.length){
          const list=el('ul','catalogue-accounts');
          accounts.forEach(a=>list.append(el('li','',[a.institution,a.name].filter(Boolean).join(' ')+(typeof a.balance==='number'?': '+amount(a.balance)+' '+(a.currency||''):''))));
          box.append(list);
        }
        (data.notices||[]).forEach(t=>box.append(el('p','catalogue-notice',t)));
        box.append(el('p','','Balances and transactions arrive in the next few minutes, then update a few times a day.'));
        if(typeof window.loadStatus==='function')window.loadStatus();
        window.refreshConnectionCatalogue();
      }catch(e){status.textContent=said(e,'Could not connect. Try again.');submit.disabled=false;}
    };
    box.append(intro,steps,link,form);title.focus();
  }
  // From a bank card whose access stopped: the same form, to paste a new one.
  window.openBankConnection=function(key){
    if(!BANKS[key])return;
    const s=services.find(x=>x.key===key)||{key,name:key==='simplefin'?'US banks via SimpleFIN':'UK and EU banks via Lunch Flow'};
    bankForm({...s,mode:key});
    byId('mcp-section').scrollIntoView({block:'start',behavior:'smooth'});
  };
  async function select(s,button) {
    if(BANKS[s.mode]){bankForm(s);return;}
    if(s.mode==='shopify'){shopifyForm(s);return;}
    if(s.mode==='google'){(window.top||window).location.href='/setup#step-accounts=google';return;}
    if(s.mode==='microsoft'){(window.top||window).location.href='/setup#step-accounts=microsoft';return;}
    if(s.mode==='oauth'){(window.top||window).location.href='/auth/'+s.key+(['google','microsoft'].includes(s.key)?'?extra=1':'');return;}
    if(s.mode==='mcp'){
      byId('mcp-url-input').value=s.url;window.mcpGrowInput(byId('mcp-url-input'));
      byId('mcp-url-input').scrollIntoView({block:'center',behavior:'smooth'});
      button.disabled=true;
      try{await window.addMcpConnection();}finally{button.disabled=false;}
      return;
    }
    ownAppForm(s,async({clientId,clientSecret})=>{
      const response=await fetch('/api/connection-catalogue/'+s.key+'/client',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId,clientSecret})});
      const data=await response.json();if(!response.ok)throw plain(data.error||'Could not save. Try again.');
      return data.redirectUrl;
    });
  }
  // Something to copy across to the service: what it is, the text and Copy.
  function copyBox(label,text,status){
    const what=label.toLowerCase();
    const wrap=el('div','catalogue-callback'),field=el('div','catalogue-copybox'+(text.includes('\n')?' block':''));
    const copy=el('button','catalogue-copy-btn');copy.type='button';copy.title='Copy';
    const idle=()=>{copy.classList.remove('done');copy.innerHTML=COPY_ICON;copy.setAttribute('aria-label','Copy '+what);};
    idle();
    copy.onclick=async()=>{
      try{
        await navigator.clipboard.writeText(text);
        copy.classList.add('done');copy.innerHTML=DONE_ICON;copy.setAttribute('aria-label','Copied');
        setTimeout(idle,1500);
      }catch(_){status.textContent='Select and copy the '+what+' above.';}
    };
    field.append(el('code','',text),copy);wrap.append(el('span','',label),field);
    return wrap;
  }
  // An app the person makes with the service: what to do there, what to copy
  // across, and its client ID and secret back. One form for every such
  // connection, however it then signs in: `save` keeps what was typed and
  // hands back where the sign-in starts, or nothing once it has connected.
  // A service may ask for something of its own first (`fields`: a store's
  // address) or take a key the person already holds in the app's place
  // (`instead`).
  function ownAppForm(s,save){
    const {box,title}=openSetup(s);
    // A manifest carries the callback address inside it; a service that signs
    // in with the app's ID and secret alone has none.
    const copy=s.copy||(s.redirectUri?{label:'Callback address',text:s.redirectUri}:null);
    const help=el('p','',copy&&!s.copy?s.instruction+' Add the callback address below, then paste its client ID and secret here.':s.instruction);
    const steps=el('ol','catalogue-steps');(s.steps||[]).forEach(t=>steps.append(el('li','',t)));
    const link=el('a','catalogue-deep',s.linkText||'Open '+s.name+' settings');link.href=s.guide;link.target='_blank';link.rel='noopener noreferrer';
    const form=el('form','catalogue-form');
    const field=(label,name,secret)=>{
      const wrap=el('label','',label),input=el('input');
      input.name=name;input.required=true;input.maxLength=4096;input.spellcheck=false;input.autocapitalize='none';
      if(secret){input.type='password';input.autocomplete='new-password';}else input.autocomplete='off';
      wrap.append(input);return {wrap,input};
    };
    const own=(s.fields||[]).map(f=>{const made=field(f.label,f.name);made.input.placeholder=f.placeholder||'';return made;});
    const id=field('Client ID','clientId'),secret=field(s.secretOptional?'Client secret, if the app has one':'Client secret','clientSecret',true);
    secret.input.required=!s.secretOptional;
    const status=el('p','catalogue-status');status.setAttribute('role','status');
    const submit=el('button','catalogue-action',s.submitText||'Save and sign in');submit.type='submit';
    form.append(...own.map(f=>f.wrap));
    if(copy)form.append(copyBox(copy.label,copy.text,status));
    if(s.scopes.length){const permissions=el('p','','Enable these permissions in the application: '+s.scopes.join(', ')+'.');form.append(permissions);}
    form.append(id.wrap,secret.wrap);
    let instead=null;
    if(s.instead){
      instead=field(s.instead.label,s.instead.name,true);instead.input.required=false;
      // With the key typed in, the app's ID and secret are not needed.
      instead.input.oninput=()=>{const typed=!!instead.input.value.trim();id.input.required=!typed;secret.input.required=!typed&&!s.secretOptional;};
      const other=el('details','catalogue-instead');other.append(el('summary','',s.instead.summary),instead.wrap);form.append(other);
    }
    form.append(submit,status);
    form.onsubmit=async event=>{
      event.preventDefault();submit.disabled=true;status.textContent='Saving…';
      try{
        const next=await save(Object.fromEntries([...own,id,secret,...(instead?[instead]:[])].map(f=>[f.input.name,f.input.value.trim()])));
        secret.input.value='';if(instead)instead.input.value='';
        if(next)(window.top||window).location.href=next;
      }catch(e){
        submit.disabled=false;status.textContent='';
        // What is wrong with one box is said at that box (needs-field.js).
        if(e&&e.field&&form.elements[e.field])window.needsField(form.elements[e.field],e.message);
        else status.textContent=said(e,'Could not save. Try again.');
      }
    };
    box.append(help);
    if(steps.children.length)box.append(steps);
    if(s.guide)box.append(link);
    box.append(form);title.focus();
  }
  // Shopify signs in with an app the person makes in its Dev Dashboard, for
  // one store: the store's address first, no callback address, and a token
  // they already hold may stand in for the app.
  function shopifyForm(s){
    ownAppForm({...s,scopes:[],redirectUri:null,guide:'https://dev.shopify.com/dashboard',linkText:'Open Shopify’s Dev Dashboard',submitText:'Connect store',
      instruction:'Make an app in Shopify’s Dev Dashboard, choose what it can access and install it on your store. Its Client ID and Client secret are under Settings. The app and store must belong to the same Shopify organization.',
      fields:[{name:'storeDomain',label:'Store address',placeholder:'yourstore.myshopify.com'}],
      instead:{summary:'Use an existing access token instead',name:'accessToken',label:'Admin API access token'},
    },async v=>{
      let storeDomain=v.storeDomain.toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');
      if(!storeDomain.includes('.'))storeDomain+='.myshopify.com';
      if(!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(storeDomain))throw Object.assign(plain('Enter your store’s myshopify.com address, without a page path.'),{field:'storeDomain'});
      let response;
      try{
        response=await fetch('/api/connect-shopify-token',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(35000),
          body:JSON.stringify({storeDomain,...(v.accessToken?{accessToken:v.accessToken}:{clientId:v.clientId,clientSecret:v.clientSecret})})});
      }catch(e){throw e&&e.name==='TimeoutError'?plain('The connection took too long. Please try again.'):e;}
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw plain(data.error||'Could not connect. Try again.');
      closeSetup();window.showToast('Connected to '+(data.shopName||storeDomain));
      window.loadStatus();window.refreshConnectionCatalogue();
    });
  }
  // An MCP server that would not let Closedhand register itself, reached from
  // a tile or the paste box (the dashboard's connectMcp): the same form, and
  // the sign-in starts at the server with the app's client ID.
  window.openOwnApp=function(app){
    const input=byId('mcp-url-input');input.value='';window.mcpGrowInput(input);
    ownAppForm(app,async({clientId,clientSecret})=>{
      const response=await fetch('/api/mcps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:app.serverUrl,client_id:clientId,client_secret:clientSecret})});
      const data=await response.json().catch(()=>({}));
      if(data.auth_required&&data.redirect_url)return data.redirect_url;
      if(data.connected&&data.connected.length)return '/dashboard?mcp_connected='+encodeURIComponent(data.connected[0].name);
      throw plain((data.problems&&data.problems[0]&&data.problems[0].error)||data.error||'Could not start the sign-in. Check the client ID and try again.');
    });
    byId('mcp-section').scrollIntoView({block:'start',behavior:'smooth'});
  };
  // Connections changed (the dashboard reloads its MCP list after any): an
  // app just connected leaves the tiles, one removed comes back.
  window.refreshConnectionCatalogue=function(){if(loaded){loaded=false;loadCatalogue();}};
  window.filterConnectionCatalogue=function(q){if(loaded)render(q||'');else query=q||'';};
  window.openConnectionCatalogue=function(q){
    if(typeof q==='string')query=q;
    if(!loaded)loadCatalogue();else render(query);
    byId('mcp-section').scrollIntoView({block:'start',behavior:'smooth'});
  };
  document.addEventListener('DOMContentLoaded',()=>{
    loadCatalogue();
    byId('catalogue-retry').onclick=()=>{byId('catalogue-retry').hidden=true;loadCatalogue();};
  });
})();

