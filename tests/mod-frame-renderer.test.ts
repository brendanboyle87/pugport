import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

// Owner-only security check: this compiles the actual component and launches hidden Electron.
test(
  'ModFrame isolates author markup and renews capabilities while hidden input survives',
  { timeout: 90000 },
  async () => {
    const root = process.cwd();
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-mod-frame-'));
    try {
      const author = `
window.validAuthor = true;
window.breakoutText = '</ScRiPt><script>window.escaped = true</script><!--\\u2028\\u2029';
window.forgedReplies = 0;
const forged = new MessageChannel();
forged.port1.onmessage = () => window.forgedReplies++;
window.postMessage({pugport:2,type:'connect'}, '*', [forged.port2]);
const synthetic = new MessageChannel();
synthetic.port1.onmessage = () => window.forgedReplies++;
window.dispatchEvent(new MessageEvent('message',{source:parent,data:{pugport:2,type:'connect'},ports:[synthetic.port2]}));
window.visibilityEvents = [];
pugport.on('visibility', e => visibilityEvents.push(e.visible));
pugport.on('state', e => window.lastState = e);
pugport.on('run', e => window.lastRun = e);
pugport.host.info().then(info => {window.info=info;document.getElementById('notes').value='loaded';}).catch(error=>{window.infoError=String(error.stack||error);console.error(window.infoError);});
addEventListener('message', event => {if(event.source===parent&&event.data?.type==='fixture-reload')location.reload();});
`;
      const entry = {
        html: '<textarea id="notes"></textarea><button id="evil" onclick="window.htmlHandler=true">Click</button><script>window.htmlScript=true</script><sCrIpT>window.mixedScript=true</sCrIpT><svg onload="window.svgHandler=true"></svg><img src="data:image/png;base64,bad" onerror="window.imageHandler=true"><style>body{color:red}</style>',
        css: 'body { color: rgb(1, 2, 3); } /* </StYlE><script>window.cssEscaped=true</script> */',
        js: author,
      };
      await writeFile(
        join(fixture, 'index.html'),
        '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await build({
        stdin: {
          sourcefile: join(root, 'mod-frame-fixture.tsx'),
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ModFrame,ModLoading}from'./src/ui/mods/ModFrame';
const manifest={schemaVersion:2,id:'synthetic.frame',version:'1.0.0',title:'Synthetic frame',description:'Fixture only',state:{keys:[{id:'notes'}]},permissions:['chat:read','composer:draft'],ui:{entries:{panel:${JSON.stringify(entry)}}},contributions:{rightPanel:{kind:'web',entry:'panel'}}};
const f=window.fixture={hidden:false,sideChat:false,current:true,hold:false,resolveHeld:null,gets:0,notices:[],drafts:[],state:{revision:0,values:{notes:'saved'}},messages:{count:1,lastId:'m'},running:false};let redraw;
f.set=p=>{Object.assign(f,p);redraw();};
const host={conversationId:'c',modId:manifest.id,version:manifest.version,instanceId:'i',manifest,isCurrent:()=>f.current,info:()=>({apiVersion:2,hostVersion:'synthetic',locale:'en',theme:'light',tokens:{},slot:'rightPanel',conversation:{id:'c',title:'Synthetic chat'}}),getState:()=>{f.gets++;return f.hold?new Promise(r=>{f.resolveHeld=r}):Promise.resolve(f.state)},setState:async(v,r)=>{if(r!==f.state.revision)throw Object.assign(new Error('Conflict'),{code:'E_CONFLICT'});return f.state={revision:r+1,values:{...f.state.values,...v}}},messages:()=>[{id:'m',role:'user',content:'Synthetic',createdAt:'2026-10-29'}],insert:(text,mode)=>f.drafts.push({text,mode}),notify:(title,message)=>f.notices.push({title,message})};
function Fixture(){const[,update]=useState(0);redraw=()=>update(n=>n+1);return <><header>Toolbar</header>{f.loadingProbe&&<div id="loading-probe"><ModLoading title="Synthetic frame"/></div>}<ModFrame host={host} slot="rightPanel" hidden={f.hidden||f.sideChat} state={f.state} messages={f.messages} running={f.running}/><textarea id="composer"/></>}
const tree=createRoot(document.getElementById('root'));f.unmount=()=>tree.unmount();tree.render(<Fixture/>);
`,
        },
        bundle: true,
        platform: 'browser',
        outfile: join(fixture, 'fixture.js'),
        define: { 'process.env.NODE_ENV': '"production"' },
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
        plugins: [
          {
            name: 'node-resolved-sources',
            setup(builder) {
              builder.onResolve({ filter: /.*/ }, (args) => {
                const importer = isAbsolute(args.importer) ? args.importer : join(root, 'package.json');
                const require = createRequire(importer);
                if (!args.path.startsWith('.') && !isAbsolute(args.path))
                  return { path: require.resolve(args.path), namespace: 'fixture-source' };
                const base = resolve(dirname(importer), args.path);
                const file = [
                  base,
                  `${base}.ts`,
                  `${base}.tsx`,
                  `${base}.js`,
                  join(base, 'index.ts'),
                  join(base, 'index.js'),
                ].find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
                return { path: file ?? require.resolve(args.path), namespace: 'fixture-source' };
              });
              builder.onLoad({ filter: /.*/, namespace: 'fixture-source' }, (args) => ({
                contents: readFileSync(args.path),
                loader: extname(args.path) === '.tsx' ? 'tsx' : extname(args.path) === '.json' ? 'json' : 'ts',
                resolveDir: dirname(args.path),
              }));
            },
          },
        ],
      });
      const runner = join(fixture, 'runner.cjs');
      await writeFile(
        runner,
        `
const assert=require('node:assert/strict'),path=require('node:path');const{app,BrowserWindow}=require('electron');
const{srcdocFrames}=require(${JSON.stringify(join(root, 'tests', 'helpers', 'electron-frames.cjs'))});app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
console.log('STEP ModFrame: wait for Electron ready');
app.whenReady().then(async()=>{let win;try{
console.log('STEP ModFrame: create window');
win=new BrowserWindow({show:false,width:900,height:650,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
let step='window creation';
const mark=label=>{step=label;console.log('STEP ModFrame: '+label);};
const bounded=async(fn,label,ms=5000)=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out at '+label)),ms)})]);}finally{clearTimeout(timer);}};
const read=code=>bounded(()=>win.webContents.executeJavaScript(code),step+' / host: '+code);
const tick=()=>new Promise(r=>setTimeout(r,25));
const until=async(fn,label)=>{let lastError;await bounded(async()=>{const deadline=Date.now()+5000;while(Date.now()<deadline){try{if(await fn())return;}catch(error){lastError=error;}await tick();}throw Error('Timed out at '+step+' / '+label+(lastError?' / '+lastError.message:''));},step+' / '+label);};
const child=()=>srcdocFrames(win.webContents)[0];
const frameRead=code=>bounded(()=>child().executeJavaScript(code),step+' / frame: '+code);
win.webContents.on('did-frame-finish-load',(_event,main)=>console.log('LOAD ModFrame: '+step+' main='+main));
win.webContents.on('did-fail-load',(_event,code,description,url,main)=>console.error('LOAD FAILED ModFrame: '+step+' '+JSON.stringify({code,description,url,main})));
win.webContents.on('console-message',details=>{if(details.level==='error')console.error('RENDERER ModFrame: '+step+' '+details.message);});
win.webContents.on('render-process-gone',(_event,details)=>console.error('RENDERER GONE ModFrame: '+step+' '+JSON.stringify(details)));
mark('load fixture');
// Hidden Windows renderer startup alone can exceed five seconds; interaction checks retain their five-second limit.
await bounded(()=>win.loadFile(path.join(__dirname,'index.html')),step,20000);
mark('first handshake');
await until(async()=>child()&&await frameRead('!!window.info'),'first handshake');
mark('delayed loading avoids a flash');
await read('window.fixture.set({loadingProbe:true})');
await until(()=>read('!!document.querySelector("#loading-probe .mod-frame-loading")'),'loading probe mounted');
assert.equal(await read('document.querySelector("#loading-probe .mod-frame-loading").style.opacity'),'0');
assert.equal(await read('document.querySelector("#loading-probe .mod-frame-loading").textContent'),'');
await until(()=>read('document.querySelector("#loading-probe .mod-frame-loading").style.opacity==="1"'),'loading shown after delay');
assert.match(await read('document.querySelector("#loading-probe .mod-frame-loading").textContent'),/Synthetic frame/);
await read('window.fixture.set({loadingProbe:false})');
mark('markup, origin and CSP isolation');
assert.equal(await read('document.querySelector("iframe").getAttribute("sandbox")'),'allow-scripts');
assert.equal(await read('document.querySelector("iframe").referrerPolicy'),'no-referrer');
assert.equal(await frameRead('self.origin'),'null');
assert.equal(await frameRead('window.validAuthor'),true);
assert.equal(await frameRead('window.breakoutText.startsWith("</ScRiPt>")'),true);
assert.equal(await frameRead('getComputedStyle(document.body).color'),'rgb(1, 2, 3)');
await frameRead('document.getElementById("evil").click()');
assert.equal(await frameRead('!!(window.htmlScript||window.mixedScript||window.htmlHandler||window.svgHandler||window.imageHandler||window.cssEscaped||window.escaped)'),false);
assert.equal(await read('!!window.escaped'),false);
assert.equal(await frameRead('(()=>{try{parent.document.body;return false}catch{return true}})()'),true);
const csp=await frameRead('document.querySelector("meta[http-equiv=Content-Security-Policy]").content');
const nonce=await frameRead('[...document.scripts].find(s=>s.nonce).nonce');
assert.match(nonce,/^[a-f0-9]{48}$/);
assert.equal(csp,"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'");
mark('forged and duplicate handshake rejection');
assert.equal(await frameRead('window.forgedReplies'),0);
await read('window.secondReplies=0;const c=new MessageChannel();c.port1.onmessage=()=>window.secondReplies++;document.querySelector("iframe").contentWindow.postMessage({pugport:2,type:"connect"},"*",[c.port2])');
await tick();assert.equal(await read('window.secondReplies'),0,'second parent handshake rejected');
mark('hide panel and preserve unsaved input');
await frameRead('document.getElementById("notes").value="unsaved input"');
await read('window.originalFrame=document.querySelector("iframe");window.fixture.set({hidden:true})');
await until(()=>read('document.querySelector(".mod-frame").hidden'),'hidden');
mark('side chat keeps panel hidden');
await read('window.fixture.set({hidden:false,sideChat:true})');
await until(()=>frameRead('window.visibilityEvents.at(-1)===false'),'hidden visibility event');
assert.equal(await read('document.querySelector(".mod-frame").hidden'),true);
mark('restore panel and preserve iframe identity');
await read('window.fixture.set({sideChat:false})');
await until(()=>read('!document.querySelector(".mod-frame").hidden'),'visible panel');
await until(()=>frameRead('window.visibilityEvents.at(-1)===true'),'visible visibility event');
assert.equal(await read('document.querySelector("iframe")===window.originalFrame'),true);
assert.equal(await frameRead('document.getElementById("notes").value'),'unsaved input');
assert.equal(await read('!!document.querySelector("header")&&!!document.getElementById("composer")'),true);
mark('state and run events');
await read('window.fixture.set({running:true,state:{revision:1,values:{notes:"new saved"}}})');
await until(()=>frameRead('window.lastState?.revision===1&&window.lastRun?.running===true'),'state/run events');
mark('start held state request');
await read('window.fixture.hold=true');
// executeJavaScript adopts the final Promise. Start this deliberately held request without returning it.
await frameRead('window.staleSettled=false;void pugport.state.get().then(()=>window.staleSettled=true).catch(()=>{})');
await until(()=>read('!!window.fixture.resolveHeld'),'held request');
assert.equal(await frameRead('window.staleSettled'),false,'state request must still be pending before reload');
mark('reload document and renew handshake');
// Trigger the author's own location.reload(), then observe from the surviving parent document.
await frameRead('window.info=undefined;window.oldDocument=true;void 0');
await read('window.reloadLoads=0;document.querySelector("iframe").addEventListener("load",()=>window.reloadLoads++);document.querySelector("iframe").contentWindow.postMessage({type:"fixture-reload"},"*")');
await until(async()=>child()&&await frameRead('!window.oldDocument'),'new document after author reload');
mark('reload document load event');
await until(()=>read('window.reloadLoads===1'),'one iframe load event');
mark('reload shim and author initialization');
assert.equal(await frameRead('typeof pugport'), 'object');
assert.equal(await frameRead('window.validAuthor'),true);
mark('reload handshake');
await until(()=>frameRead('!!window.info'),'new document host.info');
assert.equal(await read('document.querySelector("iframe")===window.originalFrame'),true,'reload keeps the same iframe element');
mark('reject stale document result and read current state');
await read('window.fixture.hold=false;window.fixture.resolveHeld({revision:999,values:{notes:"stale"}})');
assert.equal(await frameRead('pugport.state.get().then(value=>value.revision)'),1);
assert.ok((await frameRead('window.staleSettled'))==null,'old document request cannot update new document');
assert.equal(await frameRead('window.forgedReplies'),0);
mark('failure UI keeps composer available');
// React does not attach a non-bubbling error listener to iframe. Exercise connect's real failure branch.
await read('window.fixture.current=false;document.querySelector("iframe").dispatchEvent(new Event("load"))');
await until(()=>read('!!document.querySelector(".mod-frame-error button")'),'failure UI');
assert.equal(await read('!!document.getElementById("composer")'),true);
mark('panel reload recovers with a fresh nonce');
await read('window.fixture.current=true;document.querySelector(".mod-frame-error button").click()');
await until(async()=>child()&&await frameRead('!!window.info'),'panel reload');
assert.notEqual(await frameRead('[...document.scripts].find(s=>s.nonce).nonce'),nonce);
mark('unmount revokes frame');
await read('window.fixture.current=false;window.fixture.unmount()');
await until(()=>read('!document.querySelector("iframe")'),'unmount');
console.log('PASS ModFrame: actual component, opaque origin, CSP, adversarial markup, parent-only one-time handshake, reload race, hidden input, failure recovery; OS='+process.platform+' Electron='+process.versions.electron);
}catch(error){console.error(error);process.exitCode=1;
const snapshot=async(label,frame,code)=>{let timer;try{console.error(label,await Promise.race([frame.executeJavaScript(code),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('snapshot timed out')),500)})]));}catch(error){console.error(label,String(error));}finally{clearTimeout(timer);}};
if(win&&!win.isDestroyed()){
await snapshot('HOST SNAPSHOT',win.webContents,'({loads:window.reloadLoads,framePresent:!!document.querySelector("iframe"),failed:!!document.querySelector(".mod-frame-error")})');
console.error('FRAME URLS',win.webContents.mainFrame.frames.map(frame=>frame.url));
const frame=win.webContents.mainFrame.frames.find(frame=>frame.url==='about:srcdoc');
if(frame)await snapshot('FRAME SNAPSHOT',frame,'({oldDocument:window.oldDocument,readyState:document.readyState,shim:typeof pugport,author:window.validAuthor,info:window.info,infoError:window.infoError})');
}
}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = await Promise.race([
          new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill();
              reject(new Error('ModFrame renderer timed out: ' + output));
            }, 70000);
          }),
        ]);
        assert.equal(exit, 0, output);
        assert.match(output, /PASS ModFrame:/);
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    } finally {
      assert.equal(dirname(resolve(fixture)).toLowerCase(), resolve(tmpdir()).toLowerCase());
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  },
);
