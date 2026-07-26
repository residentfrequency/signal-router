'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.MODULATION_DEMO_PORT || 3003);
const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';
const TARGET_DEVICE = process.env.MODULATION_PCM_DEVICE || 'pcm/indoor-sky/audio';

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frequency × Modulation Frequency</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}body{margin:0;background:#07080b;color:#e8ecf3}main{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;gap:12px;padding:18px}header{display:flex;justify-content:space-between;align-items:end;gap:16px}h1{margin:0;font-size:clamp(18px,2.4vw,32px)}.sub,#status,.legend{font-size:12px;color:#929cac}.stage{min-height:440px;border:1px solid #252a33;background:#030408}canvas{width:100%;height:100%;display:block}.legend{display:flex;justify-content:space-between}.steady{color:#f5f7fa}
</style></head><body><main><header><div><h1>FREQUENCY × MODULATION FREQUENCY</h1><div class="sub">acoustic frequency ↑ · rate of spectral change → · live, non-scrolling</div></div><div id="status">connecting…</div></header><div class="stage"><canvas id="view"></canvas></div><div class="legend"><span class="steady">STEADY / CURRENT</span><span>slow modulation</span><span>fast modulation</span></div></main><script>
(()=>{
const TARGET=${JSON.stringify(TARGET_DEVICE)};
const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d',{alpha:false}),status=document.querySelector('#status');
const B=72,M=48,H=128,FMIN=20,FMAX=8000,MODMAX=32,DECAY=.93;
const hist=Array.from({length:B},()=>new Float32Array(H)),pos=new Uint16Array(B),filled=new Uint16Array(B),display=Array.from({length:B},()=>new Float32Array(M+1));
let spectrumFps=30,lastSpectrumAt=0,messages=0,targetBatches=0,targetSamples=0,lastTargetAt=0,announced=null;
function resize(){const d=Math.max(1,Math.min(2,devicePixelRatio||1)),r=canvas.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(r.width*d));canvas.height=Math.max(1,Math.floor(r.height*d))}addEventListener('resize',resize);resize();
function streamsFrom(m){if(!m||typeof m!=='object')return[];if(m.type==='sample_batch'&&Array.isArray(m.streams))return m.streams;if(m.type==='signal_batch'&&Array.isArray(m.signals))return m.signals.flatMap(streamsFrom);return[]}
function targetStream(m){return streamsFrom(m).find(s=>String(s.device||'')===TARGET)||null}
function normalizeSamples(stream){if(!Array.isArray(stream.samples))return null;const rows=stream.samples.filter(x=>Array.isArray(x)&&Number.isFinite(Number(x[1]))&&Number.isFinite(Number(x[2])));if(rows.length<32)return null;const t0=Number(rows[0][1]),t1=Number(rows.at(-1)[1]),duration=(t1-t0)/1e6;const rate=duration>0?(rows.length-1)/duration:0;return rate>1000?{rows,rate}:null}
function spectrumFromSamples(c){const x=c.rows.map(v=>Number(v[2])),n=x.length,sr=c.rate;let mean=0;for(const v of x)mean+=v;mean/=n;const mags=new Float32Array(B);for(let b=0;b<B;b++){const hz=FMIN*Math.pow(FMAX/FMIN,(b+.5)/B);if(hz>=sr/2)continue;let re=0,im=0,ws=0;for(let j=0;j<n;j++){const w=.5-.5*Math.cos(2*Math.PI*j/Math.max(1,n-1)),v=(x[j]-mean)*w,p=2*Math.PI*hz*j/sr;re+=v*Math.cos(p);im-=v*Math.sin(p);ws+=w}mags[b]=Math.log1p(Math.hypot(re,im)*8/Math.max(1,ws))}return{mags,sr,n}}
function ingest(spec){const now=performance.now();if(lastSpectrumAt){const f=1000/Math.max(1,now-lastSpectrumAt);spectrumFps=.9*spectrumFps+.1*f}lastSpectrumAt=now;for(let b=0;b<B;b++){const v=spec.mags[b],p=pos[b];hist[b][p]=v;pos[b]=(p+1)%H;filled[b]=Math.min(H,filled[b]+1);display[b][0]=Math.max(v,display[b][0]*DECAY)}computeMod()}
function computeMod(){const usable=Math.min(MODMAX,spectrumFps/2);for(let b=0;b<B;b++){const n=filled[b];if(n<16)continue;const h=hist[b],start=(pos[b]-n+H)%H;let mean=0;for(let j=0;j<n;j++)mean+=h[(start+j)%H];mean/=n;for(let c=1;c<=M;c++){const q=(c-1)/Math.max(1,M-1),hz=.15*Math.pow(usable/.15,q);let re=0,im=0;for(let j=0;j<n;j++){const v=h[(start+j)%H]-mean,w=.5-.5*Math.cos(2*Math.PI*j/Math.max(1,n-1)),p=2*Math.PI*hz*j/spectrumFps;re+=v*w*Math.cos(p);im-=v*w*Math.sin(p)}const power=Math.log1p(Math.hypot(re,im)*5/n);display[b][c]=Math.max(power,display[b][c]*DECAY)}}}
function color(v){const x=Math.max(0,Math.min(1,v*1.7)),r=Math.floor(255*Math.max(0,Math.min(1,1.8*x-.45))),g=Math.floor(255*Math.max(0,Math.min(1,1.9-Math.abs(x-.55)*3.2))),bl=Math.floor(255*Math.max(0,Math.min(1,1.25-x*1.15)));return'rgb('+r+','+g+','+bl+')'}
function draw(){const w=canvas.width,h=canvas.height,d=devicePixelRatio||1,lw=62*d,pw=w-lw,cw=pw/(M+1),ch=h/B;ctx.fillStyle='#030408';ctx.fillRect(0,0,w,h);for(let b=0;b<B;b++){const y=h-(b+1)*ch;for(let c=0;c<=M;c++){ctx.fillStyle=color(display[b][c]);ctx.fillRect(lw+c*cw,y,Math.ceil(cw+.5),Math.ceil(ch+.5))}}ctx.fillStyle='rgba(255,255,255,.22)';ctx.fillRect(lw+cw,0,1,h);ctx.font=10*d+'px ui-monospace';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#8a94a3';[20,50,100,200,500,1000,2000,4000,8000].forEach(hz=>{const y=h-Math.log(hz/FMIN)/Math.log(FMAX/FMIN)*h;ctx.fillText(hz>=1000?(hz/1000)+'k':hz,lw-8,y)});let s=TARGET+' · ';if(lastTargetAt)s+=targetBatches+' PCM batches · '+targetSamples+' samples · '+spectrumFps.toFixed(1)+' spectrum fps';else if(announced)s+='route announced (available='+announced.available+', enabled='+announced.enabled+') · no PCM sample batches received';else s+='waiting for route and PCM sample batches';status.textContent=s+' · '+messages+' msgs';requestAnimationFrame(draw)}
function connect(){const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.onopen=()=>status.textContent='connected · waiting for '+TARGET;ws.onmessage=e=>{messages++;try{const m=JSON.parse(e.data);if(m.type==='audio'&&m.device===TARGET)announced=m;const stream=targetStream(m);if(!stream)return;const c=normalizeSamples(stream);if(!c)return;targetBatches++;targetSamples+=c.rows.length;lastTargetAt=performance.now();ingest(spectrumFromSamples(c))}catch(err){status.textContent='message parse error: '+err.message}};ws.onclose=()=>{status.textContent='disconnected · retrying';setTimeout(connect,1500)};ws.onerror=()=>ws.close()}
connect();draw();
})();
</script></body></html>`;

function startDemo(){
 const server=http.createServer((req,res)=>{if(req.url!=='/'&&req.url!=='/modulation-spectrum/'){res.writeHead(404).end('not found');return}res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(PAGE)});
 const clients=new WebSocketServer({server});let router,retry,count=0;
 const connect=()=>{router=new WebSocket(ROUTER_URL,{rejectUnauthorized:false});router.on('open',()=>console.log(`Modulation demo connected to ${ROUTER_URL}; target ${TARGET_DEVICE}`));router.on('message',raw=>{count++;for(const c of clients.clients)if(c.readyState===WebSocket.OPEN)c.send(raw.toString())});router.on('close',()=>{console.log('Modulation demo router connection closed; retrying');retry=setTimeout(connect,2000)});router.on('error',err=>console.error('Modulation demo router error:',err.message))};connect();
 server.listen(PORT,()=>console.log(`Modulation spectrum: http://localhost:${PORT}/modulation-spectrum/`));return{close(){clearTimeout(retry);router?.close();clients.close();server.close()}}
}
if(require.main===module)startDemo();module.exports={startDemo};
