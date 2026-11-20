import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareLayout,Simulation} from './public/network-layout.js';
test('Obsidian-style simulation keeps all records finite, separates coincident nodes, pulls linked records together and rings orphans',()=>{
 const nodes=Array.from({length:1191},(_,i)=>({id:'source-'+i,degree:i<240?2:0})),edges=Array.from({length:239},(_,i)=>({source:nodes[i].id,target:nodes[i+1].id,weight:1,kinds:['topic']}));
 const layout=prepareLayout(nodes),same=prepareLayout(nodes);assert.deepEqual(layout,same);layout[1].x=layout[0].x;layout[1].y=layout[0].y;
 const by=new Map(layout.map(n=>[n.id,n])),links=edges.map(e=>({...e,a:by.get(e.source),b:by.get(e.target)})),sim=new Simulation(layout,links);
 let ticks=0;while(sim.running&&ticks<1000){sim.tick();ticks++;}assert.ok(!sim.running&&ticks<600,'cools down, ticks '+ticks);
 assert.equal(layout.length,nodes.length);assert.ok(layout.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));assert.ok(Math.hypot(layout[0].x-layout[1].x,layout[0].y-layout[1].y)>5);
 const linkLen=links.reduce((s,l)=>s+Math.hypot(l.a.x-l.b.x,l.a.y-l.b.y),0)/links.length,randomPair=Math.hypot(layout[300].x-layout[900].x,layout[300].y-layout[900].y);
 assert.ok(linkLen<120,'linked records stay close: '+Math.round(linkLen));
 const r=n=>Math.hypot(n.x,n.y),linked=layout.slice(0,240).map(r).sort((a,b)=>a-b),orphans=layout.slice(240).map(r).sort((a,b)=>a-b);
 assert.ok(orphans[Math.floor(orphans.length/2)]>linked[Math.floor(linked.length/2)],'orphans sit outside the linked mass');
 const dragged=layout[100];dragged.fx=dragged.x+400;dragged.fy=dragged.y;const nb=layout[101],before=nb.x;sim.alphaTarget=.3;sim.reheat(.3);for(let i=0;i<60;i++)sim.tick();assert.ok(nb.x-before>40,'a neighbour follows the dragged record');
});
test('force multipliers change the layout like Obsidian sliders: longer links, weaker centre pull spreads orphans',()=>{
 const run=forces=>{const nodes=Array.from({length:300},(_,i)=>({id:'n'+i})),layout=prepareLayout(nodes),by=new Map(layout.map(n=>[n.id,n]));
  const links=Array.from({length:120},(_,i)=>({source:'n'+i,target:'n'+(i+1),kinds:['topic']})).map(e=>({...e,a:by.get(e.source),b:by.get(e.target)}));
  const sim=new Simulation(layout,links);Object.assign(sim.forces,forces);let t=0;while(sim.running&&t<800){sim.tick();t++;}
  const len=links.reduce((s,l)=>s+Math.hypot(l.a.x-l.b.x,l.a.y-l.b.y),0)/links.length,orph=layout.slice(150).map(n=>Math.hypot(n.x,n.y)).sort((a,b)=>a-b)[75];return {len,orph};};
 const base=run({}),long=run({distance:2.5}),loose=run({center:.3});
 assert.ok(long.len>base.len*1.5,'distance slider: '+Math.round(base.len)+' -> '+Math.round(long.len));
 assert.ok(loose.orph>base.orph*1.2,'centre slider: '+Math.round(base.orph)+' -> '+Math.round(loose.orph));
});
