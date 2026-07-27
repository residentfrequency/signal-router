'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.MODULATION_DEMO_PORT || 3003);
const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';
const TARGET_DEVICE = process.env.MODULATION_PCM_DEVICE || 'pcm/indoor-sky/audio';

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frequency × Modulation Frequency</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}body{margin:0;background:#07080b;color:#e8ecf3}main{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;gap:12px;padding:18px}header{display:flex;justify-content:space-between;align-items:end;gap:16px}h1{margin:0;font-size:clamp(18px,2.4vw,32px)}.sub,#status,.legend{font-size:12px;color:#929cac}.stage{min-height:440px;border:1px solid #252a33;background:#030408}canvas{width:100%;height:100%;display:block}.legend{display:flex;justify-content:space-between}.steady{color:#f5f7fa}
</style></head><body><main><header><div><h1>FREQUENCY × MODULATION FREQUENCY</h1><div class="sub">acoustic frequency ↑ · rate of spectral change → · live, non-scrolling</div></div><div id="status">connecting…</div></header><div class="stage"><canvas id="view"></canvas></div><div class="legend"><span class="steady">STEADY / CURRENT (−100…0 dBFS)</span><span>slow modulation</span><span>fast modulation</span></div></main><script>
(()=>{
const TARGET=${JSON.stringify(TARGET_DEVICE)};
const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d',{alpha:false}),status=document.querySelector('#status');
const B=256,M=128,H=256,AUDIO_FFT=1024,FMIN=20,FMAX=8000,DECAY=.93,DEFAULT_SAMPLE_RATE=16000,DB_FLOOR=-100;
const hist=Array.from({length:B},()=>new Float32Array(H)),pos=new Uint16Array(B),filled=new Uint16Array(B),display=Array.from({length:B},()=>new Float32Array(M+1));
const modRe=new Float32Array(H),modIm=new Float32Array(H),audioRe=new Float32Array(AUDIO_FFT),audioIm=new Float32Array(AUDIO_FFT);
let sampleRate=DEFAULT_SAMPLE_RATE,spectrumFps=25,messages=0,pcmFrames=0,pcmSamples=0,lastPcmAt=0,announced=null,streamInfo=null,lastFrameSamples=0,peakDb=DB_FLOOR,analysisMs=0;
function resize(){const d=Math.max(1,Math.min(2,devicePixelRatio||1)),r=canvas.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(r.width*d));canvas.height=Math.max(1,Math.floor(r.height*d))}addEventListener('resize',resize);resize();
function decodePcm(buffer){const count=Math.floor(buffer.byteLength/2);if(!count)return null;const view=new DataView(buffer,0,count*2),samples=new Float32Array(count);for(let i=0;i<count;i++)samples[i]=view.getInt16(i*2,true)/32768;return samples}
function fft(re,im){const n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t}}for(let len=2;len<=n;len<<=1){const angle=-2*Math.PI/len,wlr=Math.cos(angle),wli=Math.sin(angle);for(let i=0;i<n;i+=len){let wr=1,wi=0;for(let j=0;j<len/2;j++){const u=i+j,v=u+len/2,tr=re[v]*wr-im[v]*wi,ti=re[v]*wi+im[v]*wr;re[v]=re[u]-tr;im[v]=im[u]-ti;re[u]+=tr;im[u]+=ti;const nwr=wr*wlr-wi*wli;wi=wr*wli+wi*wlr;wr=nwr}}}}
function dbLevel(db){return Math.max(0,Math.min(1,(db-DB_FLOOR)/-DB_FLOOR))}
function spectrumFromSamples(x,sr){const n=Math.min(x.length,AUDIO_FFT);if(n<32)return null;let mean=0;for(let i=0;i<n;i++)mean+=x[i];mean/=n;audioRe.fill(0);audioIm.fill(0);let ws=0;for(let i=0;i<n;i++){const w=.5-.5*Math.cos(2*Math.PI*i/Math.max(1,n-1));audioRe[i]=(x[i]-mean)*w;ws+=w}fft(audioRe,audioIm);const db=new Float32Array(B);let framePeak=DB_FLOOR;for(let b=0;b<B;b++){const hz=FMIN*Math.pow(FMAX/FMIN,(b+.5)/B),index=hz*AUDIO_FFT/sr,k0=Math.max(0,Math.min(AUDIO_FFT/2-1,Math.floor(index))),k1=Math.min(AUDIO_FFT/2,k0+1),mix=index-k0,a0=Math.hypot(audioRe[k0],audioIm[k0]),a1=Math.hypot(audioRe[k1],audioIm[k1]),amplitude=2*(a0+(a1-a0)*mix)/Math.max(1,ws),level=Math.max(DB_FLOOR,20*Math.log10(Math.max(1e-8,amplitude)));db[b]=level;if(level>framePeak)framePeak=level}return{db,sr,n:x.length,framePeak}}
function ingest(spec){const started=performance.now();spectrumFps=spec.sr/spec.n;peakDb=Math.max(spec.framePeak,peakDb-.15);for(let b=0;b<B;b++){const v=spec.db[b],p=pos[b];hist[b][p]=v;pos[b]=(p+1)%H;filled[b]=Math.min(H,filled[b]+1);display[b][0]=Math.max(dbLevel(v),display[b][0]*DECAY)}computeMod();const elapsed=performance.now()-started;analysisMs=.9*analysisMs+.1*elapsed}
function computeMod(){for(let b=0;b<B;b++){const n=filled[b];if(n<32)continue;const h=hist[b],start=(pos[b]-n+H)%H;let mean=0;for(let j=0;j<n;j++)mean+=h[(start+j)%H];mean/=n;modRe.fill(0);modIm.fill(0);let ws=0;for(let j=0;j<n;j++){const w=.5-.5*Math.cos(2*Math.PI*j/Math.max(1,n-1));modRe[j]=(h[(start+j)%H]-mean)*w;ws+=w}fft(modRe,modIm);const maxBin=Math.min(M,H/2);for(let c=1;c<=M;c++){const k=Math.max(1,Math.min(maxBin,Math.round(c*maxBin/M))),dbSwing=2*Math.hypot(modRe[k],modIm[k])/Math.max(1,ws),power=Math.min(1,Math.log1p(dbSwing)/Math.log(7));display[b][c]=Math.max(power,display[b][c]*DECAY)}}}
function color(v){const x=Math.max(0,Math.min(1,v)),r=Math.floor(255*Math.max(0,Math.min(1,1.8*x-.45))),g=Math.floor(255*Math.max(0,Math.min(1,1.9-Math.abs(x-.55)*3.2))),bl=Math.floor(255*Math.max(0,Math.min(1,1.25-x*1.15)));return'rgb('+r+','+g+','+bl+')'}
function draw(){const w=canvas.width,h=canvas.height,d=devicePixelRatio||1,lw=62*d,pw=w-lw,cw=pw/(M+1),ch=h/B;ctx.fillStyle='#030408';ctx.fillRect(0,0,w,h);ctx.imageSmoothingEnabled=false;for(let b=0;b<B;b++){const y=h-(b+1)*ch;for(let c=0;c<=M;c++){ctx.fillStyle=color(display[b][c]);ctx.fillRect(lw+c*cw,y,Math.ceil(cw+.35),Math.ceil(ch+.35))}}ctx.fillStyle='rgba(255,255,255,.22)';ctx.fillRect(lw+cw,0,1,h);ctx.font=10*d+'px ui-monospace';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#8a94a3';[20,50,100,200,500,1000,2000,4000,8000].forEach(hz=>{const y=h-Math.log(hz/FMIN)/Math.log(FMAX/FMIN)*h;ctx.fillText(hz>=1000?(hz/1000)+'k':hz,lw-8,y)});let s=TARGET+' · ';if(lastPcmAt)s+=pcmFrames+' PCM frames · '+pcmSamples+' samples · '+sampleRate+' Hz · '+lastFrameSamples+' samples/frame · '+spectrumFps.toFixed(1)+' spectral fps · peak '+peakDb.toFixed(1)+' dBFS · FFT '+B+'×'+M+' · '+analysisMs.toFixed(1)+' ms/frame';else if(streamInfo)s+='subscribed · stream available='+streamInfo.available+' · waiting for binary PCM';else if(announced)s+='route announced (available='+announced.available+', enabled='+announced.enabled+') · waiting for subscription stream';else s+='waiting for route and PCM';status.textContent=s+' · '+messages+' messages';requestAnimationFrame(draw)}
function connect(){const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.binaryType='arraybuffer';ws.onopen=()=>status.textContent='connected · proxy subscribing to '+TARGET;ws.onmessage=e=>{messages++;if(e.data instanceof ArrayBuffer){const samples=decodePcm(e.data);if(!samples)return;lastFrameSamples=samples.length;const spec=spectrumFromSamples(samples,sampleRate);pcmFrames++;pcmSamples+=samples.length;lastPcmAt=performance.now();if(spec)ingest(spec);return}try{const m=JSON.parse(e.data);if(m.type==='audio'&&m.device===TARGET){announced=m;if(Number.isFinite(Number(m.sampleRate)))sampleRate=Number(m.sampleRate)}if(m.type==='pcm_stream'&&m.device===TARGET){streamInfo=m;if(Number.isFinite(Number(m.sampleRate)))sampleRate=Number(m.sampleRate)}}catch(err){status.textContent='message parse error: '+err.message}};ws.onclose=()=>{status.textContent='disconnected · retrying';setTimeout(connect,1500)};ws.onerror=()=>ws.close()}
connect();draw();
})();
</script></body></html>`;

function startDemo(){
 const server=http.createServer((req,res)=>{if(req.url!=='/'&&req.url!=='/modulation-spectrum/'){res.writeHead(404).end('not found');return}res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(PAGE)});
 const clients=new WebSocketServer({server});let router,retry;
 const connect=()=>{
  router=new WebSocket(ROUTER_URL,{rejectUnauthorized:false});
  router.on('open',()=>{
   router.send(JSON.stringify({type:'pcm_subscribe',device:TARGET_DEVICE}));
   console.log(`Modulation demo connected to ${ROUTER_URL}; subscribed to ${TARGET_DEVICE}`);
  });
  router.on('message',(raw,isBinary)=>{
   for(const client of clients.clients){
    if(client.readyState!==WebSocket.OPEN)continue;
    if(isBinary)client.send(raw,{binary:true});
    else client.send(raw.toString());
   }
  });
  router.on('close',()=>{console.log('Modulation demo router connection closed; retrying');retry=setTimeout(connect,2000)});
  router.on('error',err=>console.error('Modulation demo router error:',err.message));
 };
 connect();
 server.listen(PORT,()=>console.log(`Modulation spectrum: http://localhost:${PORT}/modulation-spectrum/`));
 return{close(){clearTimeout(retry);router?.close();clients.close();server.close()}};
}
if(require.main===module)startDemo();module.exports={startDemo};