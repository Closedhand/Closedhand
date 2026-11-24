const {test}=require('node:test');
const assert=require('node:assert/strict');
const mcp=require('../webapp/mcp-client');
// The Connect anything box (dashboard.html) takes every kind of paste below;
// each one is read here, with invented names.
test('every kind of paste the box takes is one it reads',()=>{
 for (const [paste, kind] of [["https://mcp.kestrel.example/mcp", "url"], ["npm:@kestrel/mcp-server", "command"], ["pypi:kestrel-mcp", "command"],
  ["https://www.npmjs.com/package/@kestrel/mcp-server", "command"], ["https://pypi.org/project/kestrel-mcp/", "command"],
  ["npx -y @kestrel/mcp-server", "command"], ["uvx kestrel-mcp", "command"], ["docker run -i --rm kestrel/mcp", "command"],
  ['{"mcpServers":{"kestrel":{"command":"npx","args":["-y","@kestrel/mcp-server"]}}}', "json"], ['{"servers":{"kestrel":{"url":"https://mcp.kestrel.example/mcp"}}}', "json"],
  ['{"mcp":{"servers":{"kestrel":{"url":"https://mcp.kestrel.example/mcp"}}}}', "json"], ["claude mcp add kestrel -- npx -y @kestrel/mcp-server", "command"],
  ["https://github.com/kestrel/skills/blob/main/notes/SKILL.md", "skill"]]) assert.equal(mcp.parseServerInput(paste).kind, kind, paste);
});
test('a link to a skill\'s folder installs its SKILL.md, and any other folder reads its README',async()=>{
 const {resolveInput}=require('../webapp/mcp-input-resolver');
 const seen=[];
 const fetcher=async(url)=>{seen.push(url);const ok=/\/skills\/notes\/SKILL\.md\?ref=main$/.test(url);
  return {ok,status:ok?200:404,headers:{get:()=>null},body:(async function*(){yield new TextEncoder().encode(ok?'# Notes skill':'');})()};};
 assert.deepEqual(await resolveInput('https://github.com/kestrel/tools/tree/main/skills/notes',fetcher),{skill:'https://github.com/kestrel/tools/blob/main/skills/notes/SKILL.md'});
 await assert.rejects(resolveInput('https://github.com/kestrel/tools/tree/main/servers/notes',fetcher));
 assert.match(seen.at(-1),/\/contents\/servers\/notes\/README\.md\?ref=main$/,'not a skill: its README, as before');
});
test('a README pasted as text offers the connections it describes',async()=>{
 const {resolveInput}=require('../webapp/mcp-input-resolver');
 const readme='# Kestrel\n\nInstall:\n\n```bash\nnpx -y @kestrel/kestrel-mcp\n```\n\nOr in your config:\n\n```json\n{"mcpServers":{"kestrel":{"url":"https://mcp.kestrel.example/mcp"}}}\n```\n';
 const got=await resolveInput(readme,async()=>{throw new Error('nothing is fetched');});
 assert.equal(got.source,null);
 assert.equal(got.choices.length,2);
 assert.equal(await resolveInput('npx -y @kestrel/kestrel-mcp'),null,'a plain command is left to the parser');
});
// A package named on its own is read from the instructions its GitHub project
// publishes, so what it needs is asked for: started bare, a server that needs
// a client id and secret could only fail to connect.
test('a package named on its own offers the connections its project describes, asking for what they need',async()=>{
 const {resolveInput}=require('../webapp/mcp-input-resolver');
 const readme='# Kestrel MCP\n\n#### 1. Custom Connections\n\n```json\n{"mcpServers":{"kestrel":{"command":"npx","args":["-y","@kestrel/kestrel-mcp@latest"],"env":{"KESTREL_CLIENT_ID":"your_client_id_here","KESTREL_CLIENT_SECRET":"your_client_secret_here"}}}}\n```\n\n#### 2. Bearer Token\n\n```json\n{"mcpServers":{"kestrel":{"command":"npx","args":["-y","@kestrel/kestrel-mcp@latest"],"env":{"KESTREL_BEARER_TOKEN":"your_bearer_token"}}}}\n```\n';
 const seen=[];
 const fetcher=(project)=>async(url)=>{seen.push(url);
  if(url.startsWith('https://registry.npmjs.org/'))return {ok:true,json:async()=>(project===undefined?{}:{repository:project})};
  const ok=/\/readme$|\/README\.md$/.test(url);
  return {ok,status:ok?200:404,headers:{get:()=>null},body:(async function*(){yield new TextEncoder().encode(ok?readme:'');})()};};
 for (const paste of ['@kestrel/kestrel-mcp','npm:@kestrel/kestrel-mcp@1.2.0','https://www.npmjs.com/package/@kestrel/kestrel-mcp']) {
  seen.length=0;
  const got=await resolveInput(paste,fetcher({url:'git+https://github.com/kestrel/kestrel-mcp.git',type:'git'}));
  assert.equal(seen[0],'https://registry.npmjs.org/@kestrel%2fkestrel-mcp/latest',paste);
  assert.equal(seen[1],'https://api.github.com/repos/kestrel/kestrel-mcp/readme');
  assert.equal(got.source,'https://www.npmjs.com/package/@kestrel/kestrel-mcp');
  assert.deepEqual(got.choices.map(c=>c.name.split(' · ')[0]),['Custom Connections','Bearer Token']);
  assert.match(got.choices[0].input,/KESTREL_CLIENT_ID/);
 }
 seen.length=0;
 await resolveInput('@kestrel/kestrel-mcp',fetcher({url:'https://github.com/kestrel/servers',directory:'packages/kestrel'}));
 assert.ok(seen.includes('https://api.github.com/repos/kestrel/servers/contents/packages/kestrel/README.md'),'a package in a folder of a larger project: that folder\'s README, on the default branch');
 assert.equal(await resolveInput('@kestrel/kestrel-mcp',fetcher(undefined)),null,'no project named: run as given');
 assert.equal(await resolveInput('@kestrel/kestrel-mcp',async()=>({ok:false,status:404})),null,'not on npm: as before');
});
test('GitHub project links explain the correct input',()=>{
 assert.equal(mcp.parseServerInput('https://github.com/example/project').kind,'invalid');
 assert.equal(mcp.parseServerInput('https://example.com/mcp').kind,'url');
 assert(!mcp.publicConnectionError(new Error('Streamable error: <!DOCTYPE html>secret')).includes('secret'));
});
test('security review covers every tool, validates structured verdicts and keeps incomplete checks visible',async()=>{
 const wire=require('../webapp/model-wire'), original=wire.request;const seen=[];
 wire.request=async(conn,params)=>{seen.push(params);return {content:[{type:'tool_use',name:'report_security_review',input:{risk_level:'safe',findings:[],summary:'Reviewed'}}]};};
 try {
  const scan=require('../webapp/security-scan');
  const tools=Array.from({length:188},(_,i)=>({name:'tool_'+i,description:'Read a record',inputSchema:{type:'object'}}));
  const result=await scan.scanMcpTools(tools,{model:'fixture'});
  assert.equal(result.risk_level,'safe');assert.equal(seen.length,10);
  assert(seen.some(x=>x.messages[0].content.includes('tool_187')));
  assert(seen.every(x=>x.effort==='fast'&&x.tool_choice.name==='report_security_review'));
  wire.request=async()=>({content:[{type:'text',text:'{"risk_level":"unknown","findings":[]}'}]});
  assert.equal((await scan.scanMcpTools(tools.slice(0,1),{model:'fixture'})).risk_level,'warning');
 }finally{wire.request=original;}
});
