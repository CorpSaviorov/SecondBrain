// Obsidian-like force simulation, after the d3-force model Obsidian's graph view is built on:
// link springs (strength 1/min degree, biased by degree), Barnes–Hut many-body repulsion, weak gravity to the centre
// (it is what lays orphan notes out as a ring around the linked mass), collision, and alpha cooling that is
// re-heated while a node is dragged. Forces can be scaled by the user (repel / link / center / distance).
const hash=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
const random=seed=>{let v=seed||1;return()=>{v^=v<<13;v^=v>>>17;v^=v<<5;return(v>>>0)/4294967296;};};
export const spreadRadius=n=>Math.sqrt(Math.max(1,n))*21;
export function prepareLayout(nodes){
 const R=spreadRadius(nodes.length);
 return nodes.map(n=>{const rand=random(hash(n.id)),a=rand()*Math.PI*2,d=Math.sqrt(rand())*R;return {...n,x:Math.cos(a)*d,y:Math.sin(a)*d,vx:0,vy:0,fx:null,fy:null};});
}
export const nodeRadius=n=>n.type==='hub'?Math.min(18,6+Math.sqrt(n.degree||0)*.9):Math.min(11,4+Math.sqrt(n.degree||0)*1.1);
const DISTANCE={link:42,topic:50,project:80};
export class Simulation{
 constructor(nodes,links){
  this.nodes=nodes;this.links=links;this.alpha=1;this.alphaTarget=0;this.alphaMin=.0015;this.alphaDecay=1-Math.pow(this.alphaMin,1/330);this.velocityDecay=.42;
  this.forces={repel:1,link:1,center:1,distance:1};
  const count=new Map();for(const l of links){count.set(l.a,(count.get(l.a)||0)+1);count.set(l.b,(count.get(l.b)||0)+1);}
  for(const l of links){const ca=count.get(l.a),cb=count.get(l.b);l.strength=1/Math.min(ca,cb);l.bias=ca/(ca+cb);l.length=DISTANCE[l.kinds?.includes('link')?'link':l.kinds?.includes('topic')?'topic':'project']||50;}
  for(const n of nodes)n.r=nodeRadius(n);
 }
 get running(){return this.alpha>=this.alphaMin||this.alphaTarget>0;}
 reheat(a=.3){this.alpha=Math.max(this.alpha,a);}
 tick(){
  if(!this.running)return false;
  this.alpha+=(this.alphaTarget-this.alpha)*this.alphaDecay;const alpha=this.alpha,F=this.forces;
  // Links
  for(const l of this.links){const a=l.a,b=l.b;let dx=b.x+b.vx-a.x-a.vx||1e-6,dy=b.y+b.vy-a.y-a.vy||1e-6;const d=Math.hypot(dx,dy),k=(d-l.length*F.distance)/d*alpha*l.strength*F.link;dx*=k;dy*=k;b.vx-=dx*l.bias;b.vy-=dy*l.bias;a.vx+=dx*(1-l.bias);a.vy+=dy*(1-l.bias);}
  // Many-body (Barnes–Hut quadtree)
  const strength=-70*F.repel,theta2=.81,maxD2=900*900;const tree=buildTree(this.nodes);
  if(tree)for(const n of this.nodes){const stack=[tree];while(stack.length){const q=stack.pop();if(!q.mass)continue;let dx=q.cx-n.x,dy=q.cy-n.y,l=dx*dx+dy*dy;const w=q.size;
    if(q.leaf||w*w/theta2<l){if(q.leaf&&q.body===n&&!q.more)continue;if(l>maxD2)continue;if(l<1){dx=(Math.random()-.5)*.5;dy=(Math.random()-.5)*.5;l=dx*dx+dy*dy||1;}if(l<64)l=Math.sqrt(64*l);
     const m=q.leaf&&q.body===n?q.mass-1:q.mass;if(!m)continue;const f=strength*alpha*m/l;n.vx+=dx*f;n.vy+=dy*f;}
    else for(const c of q.kids)if(c)stack.push(c);}}
  // Centre gravity
  const g=.03*F.center*alpha;for(const n of this.nodes){n.vx-=n.x*g;n.vy-=n.y*g;}
  // Collision
  const cell=24,grid=new Map();for(const n of this.nodes){const k=Math.floor(n.x/cell)+','+Math.floor(n.y/cell);let list=grid.get(k);if(!list)grid.set(k,list=[]);list.push(n);}
  for(const a of this.nodes){const gx=Math.floor(a.x/cell),gy=Math.floor(a.y/cell);for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(const b of grid.get((gx+x)+','+(gy+y))||[]){if(b===a)continue;const dx=a.x-b.x||.01,dy=a.y-b.y||.01,d=Math.hypot(dx,dy),min=a.r+b.r+2;if(d<min){const f=(min-d)/d*.35;a.vx+=dx*f;a.vy+=dy*f;}}}
  // Integrate
  const keep=1-this.velocityDecay;for(const n of this.nodes){if(n.fx!=null){n.x=n.fx;n.y=n.fy;n.vx=n.vy=0;continue;}n.vx*=keep;n.vy*=keep;n.x+=n.vx;n.y+=n.vy;}
  return true;
 }
}
function buildTree(nodes){
 let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const n of nodes){if(n.x<x0)x0=n.x;if(n.y<y0)y0=n.y;if(n.x>x1)x1=n.x;if(n.y>y1)y1=n.y;}if(!isFinite(x0))return null;
 const size=Math.max(x1-x0,y1-y0)+1,root={x0,y0,size,kids:[null,null,null,null],mass:0,cx:0,cy:0,leaf:false};
 const insert=(q,n,depth)=>{
  if(q.leaf){if(depth>24||(Math.abs(q.body.x-n.x)<1e-3&&Math.abs(q.body.y-n.y)<1e-3)){q.more=(q.more||0)+1;q.mass++;q.cx+=(n.x-q.cx)/q.mass;q.cy+=(n.y-q.cy)/q.mass;return;}
   const old=q.body;q.leaf=false;q.body=null;q.kids=[null,null,null,null];const om=q.mass;q.mass=0;q.cx=0;q.cy=0;place(q,old,depth);if(om>1){/* coincident extras stay merged in the moved leaf */}place(q,n,depth);return;}
  place(q,n,depth);};
 const place=(q,n,depth)=>{q.mass++;q.cx+=(n.x-q.cx)/q.mass;q.cy+=(n.y-q.cy)/q.mass;const h=q.size/2,i=(n.x>=q.x0+h?1:0)+(n.y>=q.y0+h?2:0);let c=q.kids[i];
  if(!c){q.kids[i]={x0:q.x0+(i&1?h:0),y0:q.y0+(i&2?h:0),size:h,leaf:true,body:n,mass:1,cx:n.x,cy:n.y,kids:null};return;}
  if(c.leaf)insert(c,n,depth+1);else place(c,n,depth+1);};
 for(const n of nodes)place(root,n,0);return root;
}
