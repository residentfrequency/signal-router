'use strict';

const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.MODULATION_DEMO_PORT || 3003);
const ROUTER_URL = process.env.RESIDENT_ROUTER_URL || 'wss://127.0.0.1:3000';
const TARGET_DEVICE = process.env.MODULATION_PCM_DEVICE || 'pcm/indoor-sky/audio';

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frequency × Modulation Frequency</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}body{margin:0;background:#07080b;color:#e8ecf3}main{min-height:100vh;display:grid;grid-template-rows:auto auto 1fr auto;gap:12px;padding:18px}header{display:flex;justify-content:space-between;align-items:end;gap:16px}h1{margin:0;font-size:clamp(18px,2.4vw,32px)}.sub,#status,.legend,.control{font-size:12px;color:#929cac}.controls{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:10px 12px;border:1px solid #252a33;background:#0b0d12}.control{display:flex;align-items:center;gap:8px;white-space:nowrap}.control strong{color:#d9dee8;font-weight:600}.buttons{display:inline-flex;border:1px solid #343a46;border-radius:4px;overflow:hidden}.buttons button{border:0;border-right:1px solid #343a46;background:#11151c;color:#929cac;padding:5px 9px;font:inherit;cursor:pointer}.buttons button:last-child{border-right:0}.buttons button.active{background:#dfe6f1;color:#11151c}.toggle{display:inline-flex;align-items:center;gap:6px;color:#d9dee8}.control select{background:#11151c;color:#d9dee8;border:1px solid #343a46;border-radius:4px;padding:4px 7px;font:inherit}.stage{min-height:440px;border:1px solid #252a33;background:#030408}canvas{width:100%;height:100%;display:block}.legend{display:flex;justify-content:space-between}.steady{color:#f5f7fa}
</style></head><body><main><header><div><h1>FREQUENCY × MODULATION FREQUENCY</h1><div class="sub">acoustic frequency ↑ · rate of spectral change → · live, non-scrolling</div></div><div id="status">connecting…</div></header><div class="controls"><div class="control"><strong>Spectrum</strong><span class="buttons"><button id="raw" class="active" type="button">Raw</button><button id="filtered" type="button">Filtered</button></span></div><label class="control"><strong>Palette</strong><select id="palette"><option value="original">Original</option><option value="viridis" selected>Viridis</option><option value="plasma">Plasma</option><option value="inferno">Inferno</option><option value="magma">Magma</option><option value="cividis">Cividis</option></select></label><label class="control toggle"><input id="smooth" type="checkbox" checked> Smooth</label></div><div class="stage"><canvas id="view"></canvas></div><div class="legend"><span class="steady">STEADY / CURRENT</span><span>slow modulation</span><span>fast modulation</span></div></main><script>
(()=>{
const TARGET=${JSON.stringify(TARGET_DEVICE)};
const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d',{alpha:false}),status=document.querySelector('#status');
const smoothControl=document.querySelector('#smooth'),paletteControl=document.querySelector('#palette'),rawButton=document.querySelector('#raw'),filteredButton=document.querySelector('#filtered');
const B=72,M=48,HISTORY_SIZE=128,FFT_SIZE=640,MAX_PCM=640,FMIN=20,FMAX=8000,MODMAX=12,DECAY=.93,DEFAULT_SAMPLE_RATE=16000,DB_FLOOR=-100,FILTER_RANGE_DB=30,UPSCALE=4;
let smooth=true,spectrumMode='raw',palette='viridis';
const hist=Array.from({length:B},()=>new Float32Array(HISTORY_SIZE)),pos=new Uint16Array(B),filled=new Uint16Array(B),display=Array.from({length:B},()=>new Float32Array(M+1));
const field=document.createElement('canvas'),fieldCtx=field.getContext('2d',{alpha:false});field.width=M+1;field.height=B;const fieldImage=fieldCtx.createImageData(M+1,B);
const interpolated=document.createElement('canvas'),interpolatedCtx=interpolated.getContext('2d',{alpha:false});interpolated.width=(M+1)*UPSCALE;interpolated.height=B*UPSCALE;
let pcmRing=new Float32Array(MAX_PCM),pcmPos=0,pcmFilled=0;
let sampleRate=DEFAULT_SAMPLE_RATE,spectrumFps=25,messages=0,pcmFrames=0,pcmSamples=0,lastPcmAt=0,announced=null,streamInfo=null,lastFrameSamples=640,peakDb=DB_FLOOR;
const PALETTES={
viridis:[[0,[68,1,84]],[.13,[71,44,122]],[.25,[59,82,139]],[.38,[44,113,142]],[.5,[33,145,140]],[.63,[39,173,129]],[.75,[92,200,99]],[.88,[170,220,50]],[1,[253,231,37]]],
plasma:[[0,[13,8,135]],[.13,[75,3,161]],[.25,[126,3,168]],[.38,[168,34,150]],[.5,[203,70,121]],[.63,[229,107,93]],[.75,[248,148,65]],[.88,[253,195,40]],[1,[240,249,33]]],
inferno:[[0,[0,0,4]],[.13,[31,12,72]],[.25,[85,15,109]],[.38,[136,34,106]],[.5,[186,54,85]],[.63,[227,89,51]],[.75,[249,140,10]],[.88,[249,201,50]],[1,[252,255,164]]],
magma:[[0,[0,0,4]],[.13,[28,16,68]],[.25,[79,18,123]],[.38,[129,37,129]],[.5,[181,54,122]],[.63,[229,80,100]],[.75,[251,135,97]],[.88,[254,194,135]],[1,[252,253,191]]],
cividis:[[0,[0,32,77]],[.13,[25,52,94]],[.25,[50,72,105]],[.38,[75,91,109]],[.5,[101,111,110]],[.63,[128,132,107]],[.75,[158,154,99]],[.88,[192,180,84]],[1,[255,233,69]]]
};
function resetAnalysis(){for(const h of hist)h.fill(0);pos.fill(0);filled.fill(0);for(const row of display)row.fill(0)}
function resize(){const d=Math.max(1,Math.min(2,devicePixelRatio||1)),r=canvas.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(r.width*d));canvas.height=Math.max(1,Math.floor(r.height*d))}addEventListener('resize',resize);resize();
function decodePcm(buffer){const count=Math.floor(buffer.byteLength/2);if(!count)return null;const view=new DataView(buffer,0,count*2),samples=new Float32Array(count);for(let i=0;i<count;i++)samples[i]=view.getInt16(i*2,true)/32768;return samples}
function appendPcm(samples){for(let i=0;i<samples.length;i++){pcmRing[pcmPos]=samples[i];pcmPos=(pcmPos+1)%MAX_PCM;pcmFilled=Math.min(MAX_PCM,pcmFilled+1)}}
function currentWindow(){if(pcmFilled<FFT_SIZE)return null;const out=new Float32Array(FFT_SIZE),start=(pcmPos-FFT_SIZE+MAX_PCM)%MAX_PCM;for(let i=0;i<FFT_SIZE;i++)out[i]=pcmRing[(start+i)%MAX_PCM];return out}
function dbLevel(db){return Math.max(0,Math.min(1,(db-DB_FLOOR)/-DB_FLOOR))}
function filteredLevel(db){return Math.max(0,Math.min(1,db/FILTER_RANGE_DB))}
function median(values){values.sort((a,b)=>a-b);const m=Math.floor(values.length/2);return values.length%2?values[m]:(values[m-1]+values[m])/2}
function subtractBackground(db){const out=new Float32Array(B),halfOctave=.5;for(let b=0;b<B;b++){const hz=FMIN*Math.pow(FMAX/FMIN,(b+.5)/B),neighbors=[];for(let j=0;j<B;j++){const other=FMIN*Math.pow(FMAX/FMIN,(j+.5)/B);if(Math.abs(Math.log2(other/hz))<=halfOctave)neighbors.push(db[j])}out[b]=Math.max(0,db[b]-median(neighbors))}return out}
function spectrumFromSamples(x,sr){const n=x.length;if(n<32)return null;let mean=0;for(const v of x)mean+=v;mean/=n;const db=new Float32Array(B);let framePeak=DB_FLOOR;for(let b=0;b<B;b++){const hz=FMIN*Math.pow(FMAX/FMIN,(b+.5)/B);if(hz>=sr/2){db[b]=DB_FLOOR;continue}let re=0,im=0,ws=0;for(let j=0;j<n;j++){const w=.5-.5*Math.cos(2*Math.PI*j/Math.max(1,n-1)),v=(x[j]-mean)*w,p=2*Math.PI*hz*j/sr;re+=v*Math.cos(p);im-=v*Math.sin(p);ws+=w}const amplitude=2*Math.hypot(re,im)/Math.max(1,ws),level=Math.max(DB_FLOOR,20*Math.log10(Math.max(1e-8,amplitude)));db[b]=level;if(level>framePeak)framePeak=level}return{db:spectrumMode==='filtered'?subtractBackground(db):db,framePeak}}
function ingest(spec){spectrumFps=sampleRate/Math.max(1,lastFrameSamples);peakDb=Math.max(spec.framePeak,peakDb-.15);for(let b=0;b<B;b++){const v=spec.db[b],p=pos[b];hist[b][p]=v;pos[b]=(p+1)%HISTORY_SIZE;filled[b]=Math.min(HISTORY_SIZE,filled[b]+1);const current=spectrumMode==='filtered'?filteredLevel(v):dbLevel(v);display[b][0]=Math.max(current,display[b][0]*DECAY)}computeMod()}
function computeMod(){const usable=Math.min(MODMAX,spectrumFps/2);for(let b=0;b<B;b++){const n=filled[b];if(n<16)continue;const h=hist[b],start=(pos[b]-n+HISTORY_SIZE)%HISTORY_SIZE;let mean=0;for(let j=0;j<n;j++)mean+=h[(start+j)%HISTORY_SIZE];mean/=n;for(let c=1;c<=M;c++){const q=(c-1)/Math.max(1,M-1),hz=.15*Math.pow(Math.max(.15,usable)/.15,q);let re=0,im=0,ws=0;for(let j=0;j<n;j++){const w=.5-.5*Math.cos(2*Math.PI*j/Math.max(1,n-1)),v=h[(start+j)%HISTORY_SIZE]-mean,p=2*Math.PI*hz*j/spectrumFps;re+=v*w*Math.cos(p);im-=v*w*Math.sin(p);ws+=w}const swing=2*Math.hypot(re,im)/Math.max(1,ws),power=Math.min(1,Math.log1p(swing)/Math.log(7));display[b][c]=Math.max(power,display[b][c]*DECAY)}}}
function originalRgb(x){return[Math.floor(255*Math.max(0,Math.min(1,1.8*x-.45))),Math.floor(255*Math.max(0,Math.min(1,1.9-Math.abs(x-.55)*3.2))),Math.floor(255*Math.max(0,Math.min(1,1.25-x*1.15)))]}
function paletteRgb(name,x){x=Math.max(0,Math.min(1,x));if(name==='original')return originalRgb(x);const stops=PALETTES[name]||PALETTES.viridis;for(let i=1;i<stops.length;i++){if(x<=stops[i][0]){const a=stops[i-1],b=stops[i],t=(x-a[0])/Math.max(1e-9,b[0]-a[0]);return a[1].map((v,j)=>Math.round(v+(b[1][j]-v)*t))}}return stops[stops.length-1][1]}
function updateField(){const data=fieldImage.data;for(let b=0;b<B;b++){const row=B-1-b;for(let c=0;c<=M;c++){const rgb=paletteRgb(palette,display[b][c]),i=(row*(M+1)+c)*4;data[i]=rgb[0];data[i+1]=rgb[1];data[i+2]=rgb[2];data[i+3]=255}}fieldCtx.putImageData(fieldImage,0,0)}
function draw(){const w=canvas.width,h=canvas.height,d=devicePixelRatio||1,lw=62*d,pw=w-lw,cw=pw/(M+1);ctx.fillStyle='#030408';ctx.fillRect(0,0,w,h);updateField();const source=smooth?interpolated:field;if(smooth){interpolatedCtx.imageSmoothingEnabled=true;interpolatedCtx.imageSmoothingQuality='high';interpolatedCtx.clearRect(0,0,interpolated.width,interpolated.height);interpolatedCtx.drawImage(field,0,0,interpolated.width,interpolated.height)}ctx.imageSmoothingEnabled=smooth;if(smooth)ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,source.width,source.height,lw,0,pw,h);ctx.fillStyle='rgba(255,255,255,.22)';ctx.fillRect(lw+cw,0,1,h);ctx.font=10*d+'px ui-monospace';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#8a94a3';[20,50,100,200,500,1000,2000,4000,8000].forEach(hz=>{const y=h-Math.log(hz/FMIN)/Math.log(FMAX/FMIN)*h;ctx.fillText(hz>=1000?(hz/1000)+'k':hz,lw-8,y)});const modResolution=spectrumFps/HISTORY_SIZE;let s=TARGET+' · ';if(lastPcmAt)s+=pcmFrames+' PCM frames · '+pcmSamples+' samples · '+sampleRate+' Hz · FFT window 640 samples · '+spectrumMode+' · '+palette+' · modulation window '+(HISTORY_SIZE/spectrumFps).toFixed(1)+' s · Δmod '+modResolution.toFixed(3)+' Hz · 72×49 analysis · '+(smooth?'4× interpolated':'cells');else if(streamInfo)s+='subscribed · stream available='+streamInfo.available+' · waiting for binary PCM';else if(announced)s+='route announced (available='+announced.available+', enabled='+announced.enabled+') · waiting for subscription stream';else s+='waiting for route and PCM';status.textContent=s+' · '+messages+' messages';requestAnimationFrame(draw)}
smoothControl.addEventListener('change',()=>{smooth=smoothControl.checked});paletteControl.addEventListener('change',()=>{palette=paletteControl.value});rawButton.addEventListener('click',()=>{spectrumMode='raw';rawButton.classList.add('active');filteredButton.classList.remove('active');resetAnalysis()});filteredButton.addEventListener('click',()=>{spectrumMode='filtered';filteredButton.classList.add('active');rawButton.classList.remove('active');resetAnalysis()});
function connect(){const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.binaryType='arraybuffer';ws.onopen=()=>{ws.send(JSON.stringify({type:'pcm_subscribe',device:TARGET}));status.textContent='connected · subscribed to '+TARGET};ws.onmessage=e=>{messages++;if(e.data instanceof ArrayBuffer){const samples=decodePcm(e.data);if(!samples)return;lastFrameSamples=samples.length;appendPcm(samples);const windowed=currentWindow();pcmFrames++;pcmSamples+=samples.length;lastPcmAt=performance.now();if(windowed){const spec=spectrumFromSamples(windowed,sampleRate);if(spec)ingest(spec)}return}try{const m=JSON.parse(e.data);if(m.type==='audio'&&m.device===TARGET){announced=m;if(Number.isFinite(Number(m.sampleRate)))sampleRate=Number(m.sampleRate)}if(m.type==='pcm_stream'&&m.device===TARGET){streamInfo=m;if(Number.isFinite(Number(m.sampleRate)))sampleRate=Number(m.sampleRate)}}catch(err){status.textContent='message parse error: '+err.message}};ws.onclose=()=>{status.textContent='disconnected · retrying';setTimeout(connect,1500)};ws.onerror=()=>ws.close()}
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
function page(){return PAGE}
if(require.main===module)startDemo();module.exports={startDemo,page};
