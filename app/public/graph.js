const palette=['#b59af5','#65cfb0','#7baff0','#e8b27f','#e6ca7c','#d194c4','#79c7d2','#a7c67f'];
const sourceColors={obsidian:'#ae8bfa',chatgpt:'#62cfb5',claude:'#f1ad81',codex:'#79adf3','claude-code':'#dc997e',email:'#e5bd70',topic:'#dacb81'};
const isGroup=n=>['project','collection'].includes(n.type);
export class KnowledgeGraph{
 constructor(canvas,{onSource=()=>{},onProject=()=>{}}={}){
  this.canvas=canvas;this.ctx=canvas.getContext('2d');this.onSource=onSource;this.onProject=onProject;this.scale=1;this.pan={x:0,y:0};this.paused=false;this.tick=0;this.expanded=new Set();this._local=false;
  new ResizeObserver(()=>this.resize()).observe(canvas.parentElement);
  canvas.addEventListener('wheel',e=>{e.preventDefault();const p=this.point(e),old=this.scale;this.scale=Math.max(.15,Math.min(5,this.scale*(e.deltaY<0?1.12:.89)));this.pan.x=p.x-(p.x-this.pan.x)*this.scale/old;this.pan.y=p.y-(p.y-this.pan.y)*this.scale/old;},{passive:false});
  canvas.addEventListener('pointerdown',e=>{const p=this.point(e);this.drag={x:p.x,y:p.y,pan:{...this.pan},node:this.hit(p),moved:false};canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{const p=this.point(e);if(this.drag){const dx=p.x-this.drag.x,dy=p.y-this.drag.y;this.drag.moved ||=Math.abs(dx)+Math.abs(dy)>5;if(this.drag.node&&this.drag.moved){const n=this.drag.node;n.x=(p.x-this.pan.x)/this.scale;n.y=(p.y-this.pan.y)/this.scale;n.ax=n.x;n.ay=n.y;n.vx=n.vy=0;}else if(this.drag.moved)this.pan={x:this.drag.pan.x+dx,y:this.drag.pan.y+dy};}else{this.hover=this.hit(p);const tip=document.querySelector('#graph-tooltip');tip.hidden=!this.hover;if(this.hover){tip.textContent=this.hover.label+(isGroup(this.hover)?` · ${this.hover.count} записей · нажмите, чтобы раскрыть`:'');tip.style.left=Math.max(8,Math.min(p.x+15,this.width-290))+'px';tip.style.top=Math.min(p.y+15,this.height-60)+'px';}canvas.style.cursor=this.hover?'pointer':'grab';}});
  canvas.addEventListener('pointerup',()=>{if(this.drag&&!this.drag.moved&&this.drag.node){const n=this.drag.node;this.selected=n;if(n.type==='root')this.fit();else if(isGroup(n)){this.expanded.has(n.id)?this.expanded.delete(n.id):this.expanded.add(n.id);this.rebuild();this.onProject(n);}else if(n.type==='topic')this.onSource(n.id);else this.onSource(n.id);}this.drag=null;});
  canvas.addEventListener('pointerleave',()=>{document.querySelector('#graph-tooltip').hidden=true;this.hover=null;});this.frame();
 }
 get local(){return this._local;}set local(v){this._local=v;if(this.allNodes)this.rebuild();}
 point(e){const r=this.canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
 resize(){const r=this.canvas.parentElement.getBoundingClientRect(),dpr=devicePixelRatio||1;this.width=r.width;this.height=r.height;this.canvas.width=Math.round(r.width*dpr);this.canvas.height=Math.round(r.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);this.fit();}
 setData(data,showTopics){
  this.data=data;this.showTopics=showTopics;const groups=data.nodes.filter(isGroup),positions=new Map(groups.map((g,i)=>{const angle=i/Math.max(1,groups.length)*Math.PI*2-Math.PI/2,r=groups.length>8?420:360;return[g.id,{x:Math.cos(angle)*r,y:Math.sin(angle)*r*.77,color:palette[i%palette.length]}];}));
  const children=new Map();for(const n of data.nodes)if(n.project_id){if(!children.has(n.project_id))children.set(n.project_id,[]);children.get(n.project_id).push(n.id);}
  this.allNodes=data.nodes.filter(n=>showTopics||n.type!=='topic').map((n,i)=>{
   let seed=0;for(const c of n.id)seed=(Math.imul(seed,31)+c.charCodeAt(0))>>>0;
   let x=0,y=0,color=sourceColors[n.provider]||'#b4b1c1';
   if(n.type==='root'){color='#c3a7ff';}
   else if(isGroup(n)){const p=positions.get(n.id);x=p.x;y=p.y;color=p.color;}
   else if(n.project_id){const p=positions.get(n.project_id),siblings=children.get(n.project_id),index=siblings.indexOf(n.id),a=index*2.3999632297,r=80+Math.sqrt(index%100)*9;x=p.x+Math.cos(a)*r;y=p.y+Math.sin(a)*r*.8;color=p.color;}
   else{const a=(seed%6283)/1000,r=180+Math.sqrt((seed>>>7)%10000/10000)*320;x=Math.cos(a)*r;y=Math.sin(a)*r*.7;}
   const label=n.type==='project'&&/^C[-_]/i.test(n.label)?n.label.replace(/^.*(?:Desktop|Documents)[-_]+/i,'').replace(/-/g,' '):n.label;
   return {...n,label,x,y,ax:x,ay:y,vx:0,vy:0,color};
  });
  this.allById=new Map(this.allNodes.map(n=>[n.id,n]));this.allEdges=data.edges.filter(e=>this.allById.has(e.source)&&this.allById.has(e.target));this.tick=0;this.rebuild();this.fit();
 }
 rebuild(){
  const included=new Set(this.allNodes.filter(n=>isGroup(n)||n.type==='root').map(n=>n.id)),counts=new Map(),grouped=this.data.mode==='projects';
  for(const n of this.allNodes){if(n.type==='source'){const count=counts.get(n.project_id)||0,max=this.expanded.has(n.project_id)?120:10;counts.set(n.project_id,count+1);if(!grouped||count<max)included.add(n.id);}else if(n.type==='topic'&&this.showTopics)included.add(n.id);}
  if(this._local&&this.selected){const selected=this.selected.id,neighbors=new Set([selected]);for(const e of this.allEdges)if(e.source===selected||e.target===selected){neighbors.add(e.source);neighbors.add(e.target);}for(const id of [...included])if(!neighbors.has(id))included.delete(id);}
  this.nodes=this.allNodes.filter(n=>included.has(n.id));this.byId=new Map(this.nodes.map(n=>[n.id,n]));this.edges=this.allEdges.filter(e=>included.has(e.source)&&included.has(e.target)).map(e=>({...e,a:this.byId.get(e.source),b:this.byId.get(e.target)}));this.tick=0;
  const caption=document.querySelector('#graph-count');if(caption)caption.textContent=grouped?`${this.data.projects.length} групп · ${this.data.total_sources.toLocaleString('ru-RU')} материалов · нажмите крупный узел`:`${this.nodes.filter(n=>n.type==='source').length} источников · ${this.edges.length} связей`;
 }
 fit(){if(!this.width)return;const nodes=this.nodes||[];if(!nodes.length){this.pan={x:this.width/2,y:this.height/2};return;}let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(const n of nodes){minX=Math.min(minX,n.x);maxX=Math.max(maxX,n.x);minY=Math.min(minY,n.y);maxY=Math.max(maxY,n.y);}this.scale=Math.max(.18,Math.min(1.25,(this.width-190)/Math.max(200,maxX-minX),(this.height-170)/Math.max(200,maxY-minY)));this.pan={x:this.width/2-(minX+maxX)/2*this.scale,y:this.height/2-(minY+maxY)/2*this.scale+5};}
 radius(n){return n.type==='root'?34:isGroup(n)?26+Math.min(10,Math.log1p(n.count)*1.6):n.type==='topic'?5:4+(n.cards?1:0);}
 hit(p){let best=null,dist=Infinity;for(const n of this.nodes||[]){const d=Math.hypot(n.x*this.scale+this.pan.x-p.x,n.y*this.scale+this.pan.y-p.y);if(d<this.radius(n)+7&&d<dist){best=n;dist=d;}}return best;}
 simulate(){if(!this.nodes?.length)return;this.tick++;for(const n of this.nodes){if(n===this.drag?.node)continue;if(isGroup(n)||n.type==='root')continue;n.vx+=(n.ax-n.x)*.015;n.vy+=(n.ay-n.y)*.015;n.vx*=.7;n.vy*=.7;n.x+=n.vx;n.y+=n.vy;}}
 frame(){requestAnimationFrame(()=>this.frame());if(document.querySelector('#graph-view').hidden||!this.width)return;if(!this.paused&&this.tick<200)this.simulate();const c=this.ctx;c.clearRect(0,0,this.width,this.height);if(!this.nodes)return;
  const focus=this.hover||this.selected,neighbors=new Set(focus?[focus.id]:[]);if(focus)for(const e of this.edges)if(e.source===focus.id||e.target===focus.id){neighbors.add(e.source);neighbors.add(e.target);}
  c.save();c.translate(this.pan.x,this.pan.y);c.scale(this.scale,this.scale);
  for(const e of this.edges){const membership=['project-root','project-membership'].includes(e.kind),active=focus&&(e.source===focus.id||e.target===focus.id);c.globalAlpha=active?.7:focus?.13:membership?.32:.1;c.strokeStyle=membership?e.a.color:'#a297b6';c.lineWidth=(e.kind==='project-root'?1.7:membership?1.05:.65)/this.scale;c.beginPath();c.moveTo(e.a.x,e.a.y);c.lineTo(e.b.x,e.b.y);c.stroke();}
  for(const n of this.nodes){const hub=isGroup(n)||n.type==='root',active=focus&&neighbors.has(n.id),radius=this.radius(n)/this.scale;c.globalAlpha=focus&&!active&&!hub?.24:1;
   if(hub){c.fillStyle=n.color+'14';c.beginPath();c.arc(n.x,n.y,radius*1.5,0,Math.PI*2);c.fill();c.fillStyle='#201c2c';c.strokeStyle=n.color;c.lineWidth=(n===focus?2.5:1.5)/this.scale;c.shadowColor=n.color;c.shadowBlur=(n===focus?22:8)/this.scale;c.beginPath();c.arc(n.x,n.y,radius,0,Math.PI*2);c.fill();c.stroke();c.shadowBlur=0;c.fillStyle=n.color;c.textAlign='center';c.font=`600 ${(n.type==='root'?17:15)/this.scale}px Segoe UI`;c.fillText(n.type==='root'?'SB':String(n.count),n.x,n.y+5/this.scale);
   }else{c.fillStyle=n.color;c.beginPath();c.arc(n.x,n.y,(n===focus?this.radius(n)+2:this.radius(n))/this.scale,0,Math.PI*2);c.fill();}
   if(hub||n===focus){const text=n.label.length>26?n.label.slice(0,25)+'…':n.label;c.font=`${hub?'600':'400'} ${(hub?16:14)/this.scale}px Segoe UI`;c.textAlign='center';const y=n.y+radius+23/this.scale,w=c.measureText(text).width;c.fillStyle='#14151be8';c.fillRect(n.x-w/2-6/this.scale,y-17/this.scale,w+12/this.scale,23/this.scale);c.fillStyle=hub?'#eee9f8':'#d7cbe6';c.fillText(text,n.x,y);if(isGroup(n)){c.font=`${11/this.scale}px Segoe UI`;c.fillStyle='#a79cb7';c.fillText(n.type==='project'?'проект / папка':'без назначенного проекта',n.x,y+19/this.scale);}}
  }c.restore();c.globalAlpha=1;
 }
}
