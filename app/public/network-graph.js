import {prepareLayout,Simulation,spreadRadius} from './network-layout.js';
// Graph view modelled on Obsidian's (user request 2026-11-18): grey nodes sized by links, thin grey links, hubs as stars,
// orphans ring the linked mass; hover lights the node, its links and neighbours in purple and fades the rest; captions
// appear when zoomed in. Dragging a node pulls its neighbours through the live simulation.
const PALETTE={bg:'#1e1e1e',node:'#a7a7a7',hub:'#cfcfcf',line:'#7a7a7a',accent:'#8b6cf6',accentLine:'#8b6cf6',text:'#c8c8c8',neighbor:'#e2e2e2',match:'#3fb67f'};
const GROUPS={obsidian:'#b7beff',chatgpt:'#8b95c9',claude:'#76a3bd',codex:'#5f6bb8','claude-code':'#8a919c',email:'#aab1bb',hub:'#cfcfcf'};
const FONT="'Inter Tight','Segoe UI Variable Text','Segoe UI',system-ui,sans-serif";
export const projectName=v=>{const s=String(v||'');if(!/^[A-Z]--Users-/.test(s))return s;if(/scratch-workspaces/.test(s))return 'Временные сессии';return s.replace(/^[A-Z]--Users-[^-]+-/,'').replace(/^(Desktop|Documents)-/,'').replace(/-/g,' ');};
export class NetworkGraph{
 constructor(canvas,{onSelect=()=>{}}={}){
  this.canvas=canvas;this.ctx=canvas.getContext('2d');this.onSelect=onSelect;this.scale=1;this.pan={x:0,y:0};this.paused=false;this.local=false;this.pointSize=6;this.labels=false;this.groups=false;this.highlight=null;this.fade=0;this.lastFocus=null;this.userMoved=false;this.forces={center:1,repel:1,link:1,distance:1};
  new ResizeObserver(()=>this.resize()).observe(canvas.parentElement);
  canvas.addEventListener('wheel',e=>{e.preventDefault();this.userMoved=true;this.follow=null;const p=this.point(e),old=this.scale;this.scale=Math.max(.08,Math.min(8,this.scale*Math.exp(-e.deltaY*.0015)));this.pan.x=p.x-(p.x-this.pan.x)*this.scale/old;this.pan.y=p.y-(p.y-this.pan.y)*this.scale/old;},{passive:false});
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;const p=this.point(e),node=this.hit(p);this.drag={...p,pan:{...this.pan},node,moved:false};if(node){node.fx=node.x;node.fy=node.y;}try{canvas.setPointerCapture(e.pointerId);}catch{}});
  canvas.addEventListener('pointermove',e=>{const p=this.point(e);
   if(this.drag){const dx=p.x-this.drag.x,dy=p.y-this.drag.y;if(!this.drag.moved&&Math.abs(dx)+Math.abs(dy)>4){this.drag.moved=true;this.userMoved=true;this.follow=null;if(this.drag.node&&this.sim){this.sim.alphaTarget=.3;this.sim.reheat(.3);}}
    if(this.drag.moved){if(this.drag.node){this.drag.node.fx=(p.x-this.pan.x)/this.scale;this.drag.node.fy=(p.y-this.pan.y)/this.scale;}else this.pan={x:this.drag.pan.x+dx,y:this.drag.pan.y+dy};}
    if(this.drag.node){this.hover=this.drag.node;return;}}
   this.hover=this.hit(p);const tip=document.querySelector('#graph-tooltip');tip.hidden=!this.hover||this.scale>1.2;if(!tip.hidden){tip.textContent=this.hover.type==='hub'?projectName(this.hover.label)+' · '+this.hover.count+' записей':this.hover.label;tip.style.left=Math.max(10,Math.min(this.width-300,p.x+14))+'px';tip.style.top=Math.max(10,Math.min(this.height-60,p.y+14))+'px';}
   canvas.style.cursor=this.hover?'pointer':this.drag?'grabbing':'grab';});
  const release=click=>{const d=this.drag;this.drag=null;if(!d)return;if(this.sim)this.sim.alphaTarget=0;if(!d.node)return;d.node.fx=null;d.node.fy=null;if(!d.moved&&click){this.select(d.node.id);this.onSelect(d.node.id);}};
  canvas.addEventListener('pointerup',()=>release(true));canvas.addEventListener('pointercancel',()=>release(false));canvas.addEventListener('lostpointercapture',()=>{if(this.drag)release(false);});
  canvas.addEventListener('pointerleave',()=>{if(!this.drag){this.hover=null;document.querySelector('#graph-tooltip').hidden=true;}});
  this.frame();
 }
 // brain-app compatibility: setting tick to 0 (point size changed) re-heats the layout.
 set tick(v){if(this.sim)this.sim.reheat(v===0?.5:.2);}
 get tick(){return this.sim?Math.round((1-this.sim.alpha)*420):0;}
 point(e){const r=this.canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
 resize(){const r=this.canvas.parentElement.getBoundingClientRect(),dpr=devicePixelRatio||1;if(!r.width)return;this.width=r.width;this.height=r.height;this.canvas.width=Math.round(r.width*dpr);this.canvas.height=Math.round(r.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);if(!this.userMoved)this.fitRadius();}
 setData(data){
  this.data=data;this.nodes=prepareLayout(data.nodes);this.byId=new Map(this.nodes.map(n=>[n.id,n]));
  this.edges=data.edges.filter(e=>this.byId.has(e.source)&&this.byId.has(e.target)).map(e=>({...e,a:this.byId.get(e.source),b:this.byId.get(e.target)}));
  this.neighbors=new Map(this.nodes.map(n=>[n,new Set()]));for(const e of this.edges){this.neighbors.get(e.a).add(e.b);this.neighbors.get(e.b).add(e.a);}
  this.sim=new Simulation(this.nodes,this.edges);Object.assign(this.sim.forces,this.forces);this.selected=null;this.hover=null;this.highlight=null;this.userMoved=false;this.fitRadius();}
 // The view is set once from the expected spread of the layout and never moves on its own afterwards.
 fitRadius(){if(!this.width||!this.nodes)return;const R=spreadRadius(this.nodes.length)*1.5;this.scale=Math.max(.08,Math.min(1.6,Math.min(this.width,this.height)/(2*R+60)));this.pan={x:this.width/2,y:this.height/2};}
 // Obsidian "Forces": multipliers for centre gravity, repulsion, link strength and link length; the layout re-heats.
 setForce(name,value){if(!(name in this.forces)||!Number.isFinite(value))return;this.forces[name]=value;if(this.sim){this.sim.forces[name]=value;this.sim.reheat(.45);}}
 select(id){this.selected=this.byId?.get(id)||null;}
 // "Show on graph": select and keep the camera on the record while the layout settles; any user pan/zoom stops it.
 reveal(id){this.select(id);if(!this.selected)return;this.follow=this.selected;this.userMoved=true;this.scale=Math.max(this.scale,1.1);}
 setMatches(ids){this.highlight=ids??null;if(this.highlight?.size)this.fit(this.nodes.filter(n=>ids.has(n.id)));}
 // On screen a node grows with the square root of the zoom (like Obsidian), so zooming in opens space between nodes.
 radius(n){return n.r*(this.pointSize/6)/Math.sqrt(Math.max(this.scale,.05));}
 hit(p){let best=null,distance=Infinity;for(const n of this.nodes||[]){const d=Math.hypot(n.x*this.scale+this.pan.x-p.x,n.y*this.scale+this.pan.y-p.y),r=Math.max(this.radius(n)*this.scale,2)+5;if(d<Math.max(10,r)&&d<distance){best=n;distance=d;}}return best;}
 fit(nodes=this.nodes||[]){if(!this.width||!nodes.length)return;this.userMoved=true;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const n of nodes){minX=Math.min(minX,n.x);maxX=Math.max(maxX,n.x);minY=Math.min(minY,n.y);maxY=Math.max(maxY,n.y);}this.scale=Math.max(.08,Math.min(2,(this.width-120)/Math.max(200,maxX-minX),(this.height-120)/Math.max(200,maxY-minY)));this.pan={x:this.width/2-(minX+maxX)/2*this.scale,y:this.height/2-(minY+maxY)/2*this.scale};}
 frame(){requestAnimationFrame(()=>this.frame());if(document.querySelector('#graph-view').hidden||!this.width||!this.nodes)return;
  if(!this.paused)this.sim.tick();
  if(this.follow){const tx=this.width*.5-this.follow.x*this.scale,ty=this.height*.5-this.follow.y*this.scale;this.pan.x+=(tx-this.pan.x)*.15;this.pan.y+=(ty-this.pan.y)*.15;if(!this.sim.running&&Math.abs(tx-this.pan.x)<1)this.follow=null;}
  const c=this.ctx,s=this.scale,focus=this.hover||this.selected;
  // Smooth hover fade (Obsidian animates the dimming in and out).
  if(focus)this.lastFocus=focus;this.fade+=((focus?1:0)-this.fade)*.18;if(this.fade<.01&&!focus)this.lastFocus=null;
  const f=this.lastFocus,near=f?this.neighbors.get(f):null,dim=1-.82*this.fade;
  const visible=n=>!this.local||!this.selected||n===this.selected||this.neighbors.get(this.selected).has(n);
  c.fillStyle=PALETTE.bg;c.fillRect(0,0,this.width,this.height);c.save();c.translate(this.pan.x,this.pan.y);c.scale(s,s);
  // Links: plain ones first, the focused node's links on top in accent colour.
  c.lineWidth=1/s;c.strokeStyle=PALETTE.line;c.globalAlpha=.35*dim;c.beginPath();
  for(const e of this.edges){if(f&&(e.a===f||e.b===f))continue;if(!visible(e.a)||!visible(e.b))continue;c.moveTo(e.a.x,e.a.y);c.lineTo(e.b.x,e.b.y);}c.stroke();
  if(f){c.globalAlpha=.9*this.fade;c.strokeStyle=(this.accent||PALETTE.accentLine);c.lineWidth=1.6/s;c.beginPath();for(const e of this.edges)if(e.a===f||e.b===f){c.moveTo(e.a.x,e.a.y);c.lineTo(e.b.x,e.b.y);}c.stroke();}
  // Nodes.
  const minR=1.6/s;
  for(const n of this.nodes){if(!visible(n))continue;const isF=n===f,isN=near?.has(n),matched=!this.highlight||this.highlight.has(n.id);
   const r=Math.max(this.radius(n),minR);c.globalAlpha=!matched?.15:isF||isN?1:dim;
   c.fillStyle=isF?(this.accent||PALETTE.accent):this.highlight&&matched?PALETTE.match:isN&&this.fade>.05?PALETTE.neighbor:this.groups?(this.groupColors||GROUPS)[n.provider]||PALETTE.node:n.type==='hub'?PALETTE.hub:PALETTE.node;
   c.beginPath();c.arc(n.x,n.y,isF?r*1.15:r,0,Math.PI*2);c.fill();}
  // Captions: under the node when zoomed in (fading in between 0.9 and 1.4), always for the focus and its neighbours.
  const textAlpha=Math.max(0,Math.min(1,(s-1.2)/.6));c.textAlign='center';c.textBaseline='top';
  // Captions never overlap: focus first, then hubs, then by number of links; a caption that would collide is skipped.
  const taken=new Map(),CELL=40,fits=(x,y,w,h)=>{for(let gx=Math.floor((x-w/2)/CELL);gx<=Math.floor((x+w/2)/CELL);gx++)for(let gy=Math.floor(y/CELL);gy<=Math.floor((y+h)/CELL);gy++)for(const b of taken.get(gx+','+gy)||[])if(Math.abs(b.x-x)*2<b.w+w&&y<b.y+b.h&&b.y<y+h)return false;return true;},take=(x,y,w,h)=>{const box={x,y,w,h};for(let gx=Math.floor((x-w/2)/CELL);gx<=Math.floor((x+w/2)/CELL);gx++)for(let gy=Math.floor(y/CELL);gy<=Math.floor((y+h)/CELL);gy++){const k=gx+','+gy;if(!taken.has(k))taken.set(k,[]);taken.get(k).push(box);}};
  const order=[...this.nodes].sort((a,b)=>(b===f)-(a===f)||(b.type==='hub')-(a.type==='hub')||(b.degree||0)-(a.degree||0));
  for(const n of order){if(!visible(n))continue;const isF=n===f,isN=near?.has(n);let a=this.labels||n.type==='hub'?Math.max(textAlpha,n.type==='hub'&&s>.25?.85:0):textAlpha;if(isF)a=Math.max(a,this.fade);else if(isN)a=Math.max(a*dim,a);else a*=dim;if(a<.04)continue;
   const label=n.type==='hub'?projectName(n.label):n.label,text=label.length>42?label.slice(0,41)+'…':label;c.font=`${isF||n.type==='hub'?600:400} ${(n.type==='hub'?13:12)/s}px ${FONT}`;const sx=n.x*s+this.pan.x,sy=(n.y+Math.max(this.radius(n),minR))*s+this.pan.y+4,w=c.measureText(text).width*s+6,h=16;if(sx<-w||sx>this.width+w||sy<-h||sy>this.height+h)continue;if(!isF&&!fits(sx,sy,w,h))continue;take(sx,sy,w,h);c.globalAlpha=a;c.fillStyle=isF?'#ffffff':PALETTE.text;c.fillText(text,n.x,n.y+Math.max(this.radius(n),minR)+4/s);}
  c.restore();c.globalAlpha=1;
 }
}
