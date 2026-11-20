import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrainStore} from './store.mjs';
import {ModelProvider} from './model-provider.mjs';
const setup=fetchImpl=>{const s=new BrainStore(':memory:'),p=new ModelProvider(s,{secretDir:fs.mkdtempSync(path.join(os.tmpdir(),'brain-secret-test-')),fetchImpl});p.save({model:'gpt-fixture'});return {s,p};};
test('key is replaceable, blank keeps it, public status and database do not expose it',()=>{
 const {s,p}=setup();p.save({api_key:'fixture-key-number-one'});p.save({api_key:''});assert.equal(p.key(),'fixture-key-number-one');p.save({api_key:'fixture-key-number-two',reasoning_effort:'high'});
 assert.equal(p.key(),'fixture-key-number-two');assert.equal(p.status().config.reasoning_effort,'high');assert.ok(!JSON.stringify(p.status()).includes('fixture-key'));assert.ok(!s.db.prepare('SELECT payload FROM model_config').get().payload.includes('fixture-key'));s.close();
});
test('both confirmed API protocols carry the chosen reasoning setting; no silent fallback',()=>{
 const {s,p}=setup();p.save({reasoning_effort:'medium'});assert.equal(p.requestBody({text:'fixture'}).body.reasoning.effort,'medium');p.save({protocol:'chat-completions',reasoning_effort:'high'});assert.equal(p.requestBody({}).body.reasoning_effort,'high');p.save({reasoning_effort:'default'});assert.equal(p.requestBody({}).body.reasoning_effort,undefined);assert.throws(()=>p.save({reasoning_effort:'invented'}));s.close();
});
test('connection check requests catalog only; key and model do not leak through errors',async()=>{
 let request;const {s,p}=setup(async(url,options)=>{request={url,options};return new Response(JSON.stringify({data:[{id:'gpt-fixture'}]}),{status:200});});p.save({api_key:'fixture-secret-token'});
 const r=await p.check();assert.equal(r.model_found,true);assert.equal(request.options.method,'GET');assert.equal(request.url,'https://api.openai.com/v1/models');assert.equal(r.completion_calls,0);assert.ok(!JSON.stringify(r).includes('fixture-secret'));s.close();
});
test('missing tariff or exhausted budget prevents paid network calls',async()=>{
 let calls=0;const {s,p}=setup(async()=>{calls++;throw Error('must not call');});p.save({api_key:'fixture-key'});await assert.rejects(p.requestJSON({}),/тариф/);p.save({input_usd_per_million:1,output_usd_per_million:1,monthly_limit_usd:.000001});await assert.rejects(p.requestJSON({text:'fixture'}),/лимит/);assert.equal(calls,0);s.close();
});
test('truncated or blank model response is rejected and billed attempt is retained',async()=>{
 const {s,p}=setup(async()=>new Response(JSON.stringify({status:'incomplete',usage:{input_tokens:100,output_tokens:32},output:[]}),{status:200}));p.save({api_key:'fixture-key',input_usd_per_million:1,output_usd_per_million:1});await assert.rejects(p.requestJSON({}),/не завершён/);assert.equal(s.db.prepare('SELECT status FROM model_usage').get().status,'invalid-output');assert.ok(p.status().accounted_usd>0);s.close();
});
test('uncertain failed request is not retried and its reserve remains charged',async()=>{
 let calls=0;const {s,p}=setup(async()=>{calls++;throw Error('fixture-secret-token');});p.save({api_key:'fixture-secret-token',input_usd_per_million:1,output_usd_per_million:1});await assert.rejects(p.requestJSON({}),e=>!e.message.includes('fixture-secret'));assert.equal(calls,1);assert.equal(s.db.prepare('SELECT status FROM model_usage').get().status,'unknown-cost');assert.ok(p.status().accounted_usd>0);s.close();
});
test('project hubs are derived from folders; an explicit assignment overrides them',()=>{
 const s=new BrainStore(':memory:');const r=s.ingest({provider:'chatgpt',external_id:'a',title:'Fixture',body:'fixture',messages:[{id:'m',role:'user',text:'fixture'}],source_path:'notes/Projects/Demo/fixture.md'});
 let g=s.graph();assert.equal(g.projects[0].label,'Demo');assert.ok(g.edges.some(e=>e.kind==='project-membership'&&e.target===r.id));s.assignProject(r.id,'Мой проект');g=s.graph();assert.equal(g.projects[0].label,'Мой проект');assert.equal(s.stats().sources,1);s.close();
});
