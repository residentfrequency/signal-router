'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.MODULATION_DEMO_PORT || 3003);
const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';
const TARGET_DEVICE = process.env.MODULATION_PCM_DEVICE || 'pcm/indoor-sky/audio';

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frequency × Modulation Frequency</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}body{margin:0;background:#07080b;color:#e8ecf3}main{min-height:100vh;display:grid;grid-template-rows:auto auto 1fr auto;gap:12px;padding:18px}header{display:flex;justify-content:space-between;align-items:end;gap:16px}h1{margin:0;font-size:clamp(18px,2.4vw,32px)}.sub,#status,.legend,.control{font-size:12px;color:#929cac}.controls{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:10px 12px;border:1px solid #252a33;background:#0b0d12}.control{display:flex;align-items:center;gap:8px;white-space:nowrap}.control strong{color:#d9dee8;font-weight:600}.control input[type=range]{width:150px}.buttons{display:inline-flex;border:1px solid #343a46;border-radius:4px;overflow:hidden}.buttons button{border:0;border-right:1px solid #343a46;background:#11151c;color:#929cac;padding:5px 9px;font:inherit;cursor:pointer}.buttons button:last-child{border-right:0}.buttons button.active{background:#dfe6f1;color:#11151c}.toggle{display:inline-flex;align-items:center;gap:6px;color:#d9dee8}.stage{min-height:440px;border:1px solid #252a33;background:#030408}canvas{width:100%;height:100%;display:block}.legend{display:flex;justify-content:space-between}.steady{color:#f5f7fa}
</style></head><body><main><header><div><h1>FREQUENCY × MODULATION FREQUENCY</h1><div class="sub">acoustic frequency ↑ · rate of spectral change → · live, non-scrolling</div></div><div id="status">connecting…</div></header><div class="controls"><label class="control"><strong>FFT</strong><input id="fft" type="range" min="0" max="3" step="1" value="1"><span id="fftValue">640</span></label><label class="control"><strong>Window</strong><input id="window" type="range" min="0" max="3" step="1" value="1"><span id="windowValue">5.1 s</span></label><div class="control"><strong>Spectrum</strong><span class="buttons"><button id="raw" class="active" type="button">Raw</button><button id="filtered" type="button">Filtered</button></span></div><label class="control toggle"><input id="smooth" type="checkbox" checked> Smooth</label></div><div class="stage"><canvas id="view"></canvas></div><div class="legend"><span class="steady">STEADY / CURRENT</span><span>slow modulation</span><span>fast modulation</span></div></main><script>
(()=>{
const TARGET=${JSON.stringify(TARGET_DEVICE)};
const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d',{alpha:false}),status=document.querySelector('#status');
const fftControl=document.querySelector('#fft'),fftValue=document.querySelector('#fftValue'),windowControl=document.querySelector('#window'),windowValue=document.querySelector('#windowValue'),smoothControl=document.querySelector('#smooth'),rawButton=document.querySelector('#raw'),filteredButton=document.querySelector('#filtered');
const B=72,M=48,FMIN=20,FMAX=8000,MODMAX=12,DECAY=.93,DEFAULT_SAMPLE_RATE=16000,DB_FLOOR=-100,FILTER_RANGE_DB=30;
const FFT_SIZES=[320,640,1024,2048],HISTORY_SIZES=[64,128,256,512],MAX_PCM=2048;
let fftSize=FFT_SIZES[1],historySize=HISTORY_SIZES[1],smooth=true,spectrumMode='raw';
let hist,pos,filled,display,field,fieldCtx,fieldImage;
let pcmRing=new Float32Array(MAX_PCM),pcmPos=0,pcmFilled=0;
let sampleRate=DEFAULT_SAMPLE_RATE,spectrumFps=25,messages=0,pcmFrames=0,pcmSamples=0,lastPcmAt=0,announced=null,streamInfo=null,lastFrameSamples=640,peakDb=DB_FLOOR;
function resetAnalysis(){hist=Array.from({length:B},()=>new Float32Array(historySize));pos=new Uint16Array(B);filled=new Uint16Array(B);display=Array.from({length:B},()=>new Float32Array(M+1));field=document.createElement('canvas');field.width=M+1;field.height=B;fieldCtx=field.getContext('2d',{alpha:false});fieldImage=fieldCtx.createImageData(M+1,B)}
function resize(){const d=Math.max(1,Math.min(2,devicePixelRatio||1)),r=canvas.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(r.width*d));canvas.height=Math.max(1,Math.floor(r.height*d))}addEventListener('resize',resize);resize();
function decodePcm(buffer){const count=Math.floor(buffer.byteLength/2);if(!count)return null;const view=new DataView(buffer,0,count*2),samples=new Float32Array(count);for(let i=0;i<count;i++)samples[i]=view.getInt16(i*2,true)/32768;return samples}
function appendPcm(samples){for(let i=0;i<samples.length;i++){pcmRing[pcmPos]=samples[i];pcmPos=(pcmPos+1)%MAX_PCM;pcmFilled=Math.min(MAX_PCM,pcmFilled+1)}}
function currentWindow(){if(pcmFilled<fftSize)return null;const out=new Float32Array(fftSize),start=(pcmPos-fftSize+MAX_PCM)%MAX_PCM;for(let i=0;i<fftSize;i++)out[i]=pcmRing[(start+i)%MAX_PCM];return out}
function dbLevel(db){return Math.max(0,Math.min(1,(db-DB_FLOOR)/-DB_FLOOR))}
function filteredLevel(db){return Math.max(0,Math.min(1,db/FILTER_RANGE_DB))}
function median(values){values.sort((a,b)=>a-b);const m=Math.floor(values.length/2);return values.length%2?values[m]:(values[m-1]+values[m])/2}
function subtractBackground(db){const out=new Float32Array(B),halfOctave=.5;for(let b=0;b<B;b++){const hz=FMIN*Math.pow(FMAX/FMIN,(b+.5)/B),neighbors=[];for(let j=0;j<B;j++){const other=FMIN*Math.pow(FMAX/FMIN,(j+.5)/B);if(Math.abs(Math.log2(other/hz))<=halfOctave)neighbors.push(db[j])}out[b]=Math.max(0,db[b]-median(neighbors))}return out}
function spectrumFromSamples(x,sr){const n=x.length;if(n<32)return null;let mean=0;for(const v of x)mean+=v;mean/=n;const db=new Float32Array(B);let framePeak=DB_FLOOR;for(let b=0;b<B;b++){const hz=FMIN*Math.pow(FMAX/FMIN,(b+.5)/B);if(hz>=sr/2){db[b]=DB_FLOOR;continue}let re=0,im=0,ws=0;for(let j=0;j<n;j++){const w=.5-.5*Math.cos(2*Math.PI*j/Math.max(1,n-1)),v=(x[j]-mean)*w,p=2*Math.PI*hz*j/sr;re+=v*Math.cos(p);im-=v*Math.sin(p);ws+=w}const amplitude=2*Math.hypot(re,im)/Math.max(1,ws),level=Math.max(DB_FLOOR,20*Math.log10(Math.max(1e-8,amplitude)));db[b]=level;if(level>framePeak)framePeak=level}return{db:spectrumMode==='filtered'?subtractBackground(db):db,rawDb:db,framePeak}}
function ingest(spec){spectrumFps=sampleRate/Math.max(1,lastFrameSamples);peakDb=Math.max(spec.framePeak,peakDb-.15);for(let b=0;b<B;b++){const v=spec.db[b],p=pos[b];hist[b][p]=v;pos[b]=(p+1)%historySize;filled[b]=Math.min(historySize,filled[b]+1);const current=spectrumMode==='filtered'?filteredLevel(v):dbLevel(v);display[b][0]=Math.max(current,display[b][0]*DECAY)}computeMod()}
function computeMod(){const usable=Math.min(MODMAX,spectrumFps/2);for(let b=0;b<B;b++){const n=filled[b];if(n<16)continue;const h=hist[b],start=(pos[b]-n+historySize)%historySize;let mean=0;for(let j=0;j<n;j++)mean+=h[(start+j)%historySize];mean/=n;for(let c=1;c<=M;c++){const q=(c-1)/Math.max(1,M-1),hz=.15*Math.pow(Math.max(.15,usable)/.15,q);let re=0,im=0,ws=0;for(let j=0;j<n;j++){const w=.5-.5*Math.cos(2*Math.PI*j/Math.max(1,n-1)),v=h[(start+j)%historySize]-mean,p=2*Math.PI*hz*j/spectrumFps;re+=v*w*Math.cos(p);im-=v*w*Math.sin(p);ws+=w}const swing=2*Math.hypot(re,im)/Math.max(1,ws),power=Math.min(1,Math.log1p(swing)/Math.log(7));display[b][c]=Math.max(power,display[b][c]*DECAY)}}}
function colorRgb(v){const x=Math.max(0,Math.min(1,v));return[Math.floor(255*Math.max(0,Math.min(1,1.8*x-.45))),Math.floor(255*Math.max(0,Math.min(1,1.9-Math.abs(x-.55)*3.2))),Math.floor(255*Math.max(0,Math.min(1,1.25-x*1.15)))]}
function updateField(){const data=fieldImage.data;for(let b=0;b<B;b++){const row=B-1-b;for(let c=0;c<=M;c++){const rgb=colorRgb(display[b][c]),i=(row*(M+1)+c)*4;data[i]=rgb[0];data[i+1]=rgb[1];data[i+2]=rgb[2];data[i+3]=255}}fieldCtx.putImageData(fieldImage,0,0)}
function draw(){const w=canvas.width,h=canvas.height,d=devicePixelRatio||1,lw=62*d,pw=w-lw,cw=pw/(M+1);ctx.fillStyle='#030408';ctx.fillRect(0,0,w,h);updateField();ctx.imageSmoothingEnabled=smooth;if(smooth)ctx.imageSmoothingQuality='high';ctx.drawImage(field,0,0,M+1,B,lw,0,pw,h);ctx.fillStyle='rgba(255,255,255,.22)';ctx.fillRect(lw+cw,0,1,h);ctx.font=10*d+'px ui-monospace';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#8a94a3';[20,50,100,200,500,1000,2000,4000,8000].forEach(hz=>{const y=h-Math.log(hz/FMIN)/Math.log(FMAX/FMIN)*h;ctx.fillText(hz>=1000?(hz/1000)+'k':hz,lw-8,y)});const modResolution=spectrumFps/Math.max(1,historySize);let s=TARGET+' · ';if(lastPcmAt)s+=pcmFrames+' PCM frames · '+pcmSamples+' samples · '+sampleRate+' Hz · FFT '+fftSize+' · '+spectrumMode+' · window '+(historySize/spectrumFps).toFixed(1)+' s · Δmod '+modResolution.toFixed(3)+' Hz · '+(smooth?'smooth':'cells');else if(streamInfo)s+='subscribed · stream available='+streamInfo.available+' · waiting for binary PCM';else if(announced)s+='route announced (available='+announced.available+', enabled='+announced.enabled+') · waiting for subscription stream';else s+='waiting for route and PCM';status.textContent=s+' · '+messages+' messages';requestAnimationFrame(draw)}
function updateControls(){fftSize=FFT_SIZES[Number(fftControl.value)];historySize=HISTORY_SIZES[Number(windowControl.value)];smooth=smoothControl.checked;fftValue.textContent=String(fftSize);windowValue.textContent=(historySize/spectrumFps).toFixed(1)+' s'}
fftControl.addEventListener('input',()=>{updateControls();resetAnalysis()});windowControl.addEventListener('input',()=>{updateControls();resetAnalysis()});smoothControl.addEventListener('change',()=>{smooth=smoothControl.checked});rawButton.addEventListener('click',()=>{spectrumMode='raw';rawButton.classList.add('active');filteredButton.classList.remove('active');resetAnalysis()});filteredButton.addEventListener('click',()=>{spectrumMode='filtered';filteredButton.classList.add('active');rawButton.classList.remove('active');resetAnalysis()});
function connect(){const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.binaryType='arraybuffer';ws.onopen=()=>status.textContent='connected · proxy subscribing to '+TARGET;ws.onmessage=e=>{messages++;if(e.data instanceof ArrayBuffer){const samples=decodePcm(e.data);if(!samples)return;lastFrameSamples=samples.length;appendPcm(samples);const windowed=currentWindow();pcmFrames++;pcmSamples+=samples.length;lastPcmAt=performance.now();if(windowed){const spec=spectrumFromSamples(windowed,sampleRate);if(spec)ingest(spec)}updateControls();return}try{const m=JSON.parse(e.data);if(m.type==='audio'&&m.device===TARGET){announced=m;if(Number.isFinite(Number(m.sampleRate)))sampleRate=Number(m.sampleRate)}if(m.type==='pcm_stream'&&m.device===TARGET){streamInfo=m;if(Number.isFinite(Number(m.sampleRate)))sampleRate=Number(m.sampleRate)}}catch(err){status.textContent='message parse error: '+err.message}};ws.onclose=()=>{status.textContent='disconnected · retrying';setTimeout(connect,1500)};ws.onerror=()=>ws.close()}
updateControls();resetAnalysis();connect();draw();
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