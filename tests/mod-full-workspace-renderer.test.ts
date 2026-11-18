import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
import { packMod } from '../scripts/pack-mod.ts';

test(
  'real full Mod workspace keeps one chat composer, handles keyboard and bridge actions, and fills its surface',
  { timeout: 120000 },
  async () => {
    const root = process.cwd();
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-full-mod-'));
    const artifacts = resolve(process.env.MOD_WORKSPACE_ARTIFACTS ?? 'artifacts/mod-full-workspace');
    await mkdir(artifacts, { recursive: true });
    try {
      const packed = await packMod(join(root, 'docs/examples/mods/reading-notes'), {
        out: join(fixture, 'notes.json'),
      });
      const main = await readFile(join(root, 'src/ui/main.tsx'), 'utf8');
      const styleImports = main
        .split('\n')
        .filter((line) => /^import ['"].*(?:css|fontsource).*['"];/.test(line))
        .map((line) => '@import ' + line.slice(7))
        .join('\n');
      await build({
        stdin: { contents: styleImports, resolveDir: join(root, 'src/ui'), loader: 'css' },
        bundle: true,
        outfile: join(fixture, 'style.css'),
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
        logLevel: 'silent',
      });
      await writeFile(
        join(fixture, 'index.html'),
        '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await build({
        stdin: {
          sourcefile: join(root, 'mod-full-workspace-fixture.tsx'),
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{ConversationWorkspace}from'./src/ui/Workspace';import{startInterfaceLanguage}from'./src/ui/i18n';
const manifest=${JSON.stringify(packed.manifest)};
const stamp='2026-10-31T12:00:00Z';
const project={id:'project',name:'Reading',path:'C:/Synthetic/reading',createdAt:stamp,updatedAt:stamp};
const binding={instanceId:'00000000-0000-4000-8000-000000000001',modeId:manifest.id,version:manifest.version};
let view={binding,pending:null,installed:true,manifest,granted:manifest.permissions,instance:{id:binding.instanceId,conversationId:'chat',modeId:binding.modeId,version:binding.version,schemaVersion:2,revision:0,state:{notes:'Good notes connect an idea to something you already know.\\n\\nWrite a short summary in your own words, then ask what changes in practice.'},createdAt:stamp,updatedAt:stamp}};
let stored={id:'chat',projectId:project.id,title:'A notebook for better reading',modeBinding:binding,createdAt:stamp,updatedAt:stamp};
let messages=[{id:'m1',conversationId:'chat',role:'user',content:'How can I remember more of what I read?',createdAt:stamp},{id:'m2',conversationId:'chat',role:'assistant',content:'Pause after each section. Explain the idea in your own words, connect it to something familiar, and write one question to revisit.',createdAt:stamp}];
const base={app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-first'},projects:[project],targets:[],runtimes:[],runs:[],workflows:[],approvals:[],plugins:[]};
const f=window.fixture={modTitle:manifest.title,calls:[],notices:[],errors:[],details:[],stored:()=>stored};
window.addEventListener('error',e=>f.errors.push(e.message));window.addEventListener('unhandledrejection',e=>f.errors.push(String(e.reason)));
const api=async(path,body,method='POST')=>{
 f.calls.push({path,body,method});
 if(path==='/api/conversations/chat/mode/visibility'){if(method!=='PUT')throw Error('Wrong visibility method');stored={...stored,modeHidden:body.hidden?true:undefined};return structuredClone(stored);}
 if(path==='/api/conversations/chat/mode'){if(f.failView)throw Error('Synthetic view failure');return structuredClone(view);}
 if(path==='/api/conversations/chat/mode/action'){view={...view,instance:{...view.instance,revision:view.instance.revision+1,state:{...view.instance.state,...body.action.values}}};return structuredClone(view);}
 if(path==='/api/modes')return{catalog:[{...manifest,compatible:true}],installed:[{modeId:binding.modeId,version:binding.version,installedAt:stamp}]};
 if(path==='/api/conversations/chat/messages'){const message={id:'sent-'+messages.length,conversationId:'chat',role:'user',content:body.content,createdAt:stamp,clientMessageId:body.clientMessageId};messages.push(message);return{message};}
 if(path==='/api/conversations/chat'){if(!f.historyReady)return new Promise(resolve=>{f.resolveHistory=()=>{f.historyReady=true;resolve({messages:structuredClone(messages),workflows:[]});};});return{messages:structuredClone(messages),workflows:[]};}
 throw Error('Unexpected fixture request: '+method+' '+path);
};
function Fixture(){const[conversation,setConversation]=useState(()=>structuredClone(stored));const[key,setKey]=useState(0);const[owner,setOwner]=useState(true);const reload=async()=>setConversation(structuredClone(stored));f.owner=setOwner;f.reply=()=>{messages=[...messages,{id:'reply-'+messages.length,conversationId:'chat',role:'assistant',content:'Another synthetic reply',createdAt:stamp}];f.recent=messages;setConversation({...stored});};f.remount=()=>{setConversation(structuredClone(stored));setKey(v=>v+1);};return <main className="workspace-main" style={{height:'100vh',width:'100vw'}}><ConversationWorkspace key={key} modSurfaces={owner} state={{...base,conversations:[conversation],conversationMessages:f.recent??[]}} project={project} conversation={conversation} api={api} reload={reload} notify={n=>f.notices.push(n)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} onOpenModeStore={id=>f.details.push(id)}/></main>;}
localStorage.setItem('comborunner.locale','en');const root=createRoot(document.getElementById('root'));f.unmount=()=>root.unmount();startInterfaceLanguage().then(()=>root.render(<Fixture/>));
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
                ].find((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
                return { path: file ?? require.resolve(args.path), namespace: 'fixture-source' };
              });
              builder.onLoad({ filter: /.*/, namespace: 'fixture-source' }, (args) => ({
                contents: readFileSync(args.path),
                loader: ['.png', '.webp'].includes(extname(args.path))
                  ? 'dataurl'
                  : extname(args.path) === '.css'
                    ? 'css'
                    : extname(args.path) === '.tsx'
                      ? 'tsx'
                      : extname(args.path) === '.json'
                        ? 'json'
                        : 'ts',
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
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1300,height:850,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!/^(file:|data:|blob:|devtools:)/.test(d.url);if(cancel)remote++;cb({cancel});});
 await win.loadFile(path.join(__dirname,'index.html'));
 const read=c=>win.webContents.executeJavaScript(c);
 const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const wait=async (code,attempts=160)=>{for(let n=0;n<attempts;n++){if(await read(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+code+'; '+JSON.stringify(await read('window.fixture?.errors')));};
 const click=async selector=>{await read('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
 const mod=()=>win.webContents.mainFrame.frames.find(f=>f.url==='about:srcdoc');
 const modRead=code=>mod().executeJavaScript(code);
 const ready=async()=>{await wait('!!document.querySelector(".mod-workspace-surface iframe")');for(let n=0;n<160;n++){if(mod()&&await modRead('!!window.pugport&&!!document.getElementById("notes")&&!document.getElementById("notes").disabled').catch(()=>false))return;await new Promise(r=>setTimeout(r,30));}throw Error('Mod did not become ready');};
 const shot=async name=>{await new Promise(r=>setTimeout(r,300));await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
 const geometry=async()=>{const boxes=await read('(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return{surface:box(".mod-workspace-surface"),frame:box(".mod-workspace-surface iframe"),bar:box(".mod-workspace-bar"),width:innerWidth,height:innerHeight}})()');assert.ok(Math.abs(boxes.surface.width-boxes.frame.width)<=1,JSON.stringify(boxes));assert.ok(Math.abs(boxes.surface.height-boxes.frame.height)<=1,JSON.stringify(boxes));assert.ok(Math.abs(boxes.frame.right-boxes.width)<=1,JSON.stringify(boxes));assert.ok(Math.abs(boxes.frame.bottom-boxes.height)<=1,JSON.stringify(boxes));assert.ok(boxes.bar.height===48,JSON.stringify(boxes));};
 await ready();await geometry();
 assert.equal(await read('!!document.querySelector(".mod-chat-unread")'),false,'history has not hydrated');
 await wait('!!window.fixture.resolveHistory');await read('window.fixture.resolveHistory()');await wait('document.querySelector(".mod-chat-drawer").textContent.includes("Pause after each section")');
 assert.equal(await read('!!document.querySelector(".mod-chat-unread")'),false,'hydrating an older assistant message is not a new reply');
 assert.equal(await modRead('Math.abs(document.querySelector("#mod-root").getBoundingClientRect().height-innerHeight)<=1&&Math.abs(document.querySelector("footer.bar").getBoundingClientRect().bottom-innerHeight)<=1'),true,'example must fill the shim root, not collapse to its content height');
 assert.equal(await modRead('window.pugport.host.info().then(info=>info.layout)'),'workspace');
 assert.match(await modRead('getComputedStyle(document.querySelector("button")).fontFamily'),/system-ui|sans-serif/,'example controls use the application typography');
 assert.equal(await read('document.querySelectorAll("#conversation-input").length'),1);
 assert.equal(await read('document.querySelector(".mod-chat-drawer").hidden'),true);
 await read('window.originalInput=document.querySelector("#conversation-input");window.originalFrame=document.querySelector(".mod-workspace-surface iframe")');
 await modRead('window.chatEvents=[];window.pugport.on("chat",e=>window.chatEvents.push(e.open))');
 for(const theme of ['light','dark']){await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();assert.equal(await read('document.querySelector("iframe").style.colorScheme'),theme);await shot('workspace-'+theme);await click('.mod-chat-toggle');await wait('!document.querySelector(".mod-chat-drawer").hidden');await shot('drawer-'+theme);assert.equal(await read('document.activeElement===window.originalInput'),true);const width=await read('document.querySelector(".mod-chat-drawer").getBoundingClientRect().width');assert.ok(width>=380&&width<=420,'drawer width '+width);await read('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await wait('document.querySelector(".mod-chat-drawer").hidden');assert.equal(await read('document.activeElement===document.querySelector(".mod-chat-toggle")'),true);}
 await read('window.fixture.reply()');await wait('!!document.querySelector(".mod-chat-unread")');
 assert.equal(await read('document.querySelector(".mod-chat-toggle").getAttribute("aria-label")'),'Chat, new reply');
 await read('document.querySelector(".mod-chat-toggle").dispatchEvent(new KeyboardEvent("keydown",{key:"j",ctrlKey:true,bubbles:true,cancelable:true}))');await wait('!document.querySelector(".mod-chat-drawer").hidden');
 assert.equal(await read('!!document.querySelector(".mod-chat-unread")'),false);
 assert.equal(await read('document.querySelector(".mod-chat-drawer").getAttribute("role")'),'region');
 assert.equal(await read('document.querySelector(".mod-workspace-surface").inert'),false);
 assert.equal(await read('document.querySelector(".mod-workspace-body").dataset.chat'),'beside');
 await modRead('document.getElementById("notes").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"j",ctrlKey:true,bubbles:true,cancelable:true}))');await wait('document.querySelector(".mod-chat-drawer").hidden');
 assert.equal(await read('document.activeElement===window.originalFrame'),true,'closing from the frame leaves focus in the frame');
 await modRead('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"j",metaKey:true,bubbles:true,cancelable:true}))');await wait('!document.querySelector(".mod-chat-drawer").hidden');
 await read('document.querySelector("#conversation-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true,cancelable:true}))');await frame();assert.equal(await read('document.querySelector(".mod-chat-drawer").hidden'),false,'IME Escape leaves drawer open');
 await click('.mod-workspace-bar [aria-haspopup="menu"]');await wait('!!document.querySelector(".mod-workspace-bar .mod-menu")');
 await read('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');await wait('!document.querySelector(".mod-workspace-bar .mod-menu")');
 assert.equal(await read('document.querySelector(".mod-chat-drawer").hidden'),false,'Tab dismisses the host menu while keeping Chat available');
 await click('.mod-workspace-bar [aria-haspopup="menu"]');await wait('!!document.querySelector(".mod-workspace-bar .mod-menu")');
 await read('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await wait('!document.querySelector(".mod-workspace-bar .mod-menu")');
 assert.equal(await read('document.querySelector(".mod-chat-drawer").hidden'),false,'Escape dismisses the host menu before its chat drawer');
 await read('document.querySelector(".mod-chat-toggle").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await frame();assert.equal(await read('document.querySelector(".mod-chat-drawer").hidden'),false,'Escape outside drawer leaves it open');
 await read('document.querySelector("#conversation-input").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await wait('document.querySelector(".mod-chat-drawer").hidden');assert.equal(await read('document.activeElement===document.querySelector(".mod-chat-toggle")'),true);
 await modRead('window.pugport.ui.chat({open:true})');await wait('!document.querySelector(".mod-chat-drawer").hidden');
 await click('.mod-chat-drawer .composer-route');await wait('!!document.querySelector(".route-popover")');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait('!document.querySelector(".route-popover")');await frame();
 assert.equal(await read('document.querySelector(".mod-chat-drawer").hidden'),false,'Escape dismisses composer options without closing the chat drawer');
 await modRead('window.pugport.ui.chat({open:false})');await wait('document.querySelector(".mod-chat-drawer").hidden');
 await modRead('window.pugport.composer.insert({text:"A question from my notes",mode:"replace"})');await wait('document.activeElement===window.originalInput&&window.originalInput.value==="A question from my notes"');
 assert.equal(await read('document.querySelector("#conversation-input")===window.originalInput'),true);
 await click('.send-button');await wait('window.fixture.calls.some(c=>c.path==="/api/conversations/chat/messages")');
 assert.equal(await read('window.fixture.calls.find(c=>c.path==="/api/conversations/chat/messages").body.content'),'A question from my notes');
 assert.ok((await modRead('window.chatEvents')).includes(true));assert.ok((await modRead('window.chatEvents')).includes(false));
 await click('.mod-chat-toggle');await wait('document.querySelector(".mod-chat-drawer").hidden');
 await modRead('document.getElementById("notes").value="Unsaved local note";document.getElementById("notes").dispatchEvent(new Event("input",{bubbles:true}))');
 await click('.mod-workspace-bar [aria-haspopup="menu"]');
 await read('[...document.querySelectorAll(".mod-workspace-bar .mod-menu button")].find(b=>b.textContent.trim()==="Hide Mod").click()');await wait('!document.querySelector(".mod-workspace-active")');
 assert.equal(await read('window.fixture.stored().modeHidden'),true);assert.equal(await read('document.querySelector("#conversation-input")===window.originalInput'),true);
 await click('.mod-toolbar-button');await ready();assert.equal(await read('document.querySelector(".mod-workspace-surface iframe")===window.originalFrame'),true);assert.equal(await modRead('document.getElementById("notes").value'),'Unsaved local note');
 for(const width of [720,760,2560]){win.setContentSize(width,850);await frame();await geometry();if(width===760){for(const theme of ['light','dark']){await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();await shot('narrow-'+theme);}}}
 win.setContentSize(1300,850);await frame();
 await modRead('document.getElementById("notes").focus()');
 await read('document.querySelector(".mod-workspace-surface iframe").srcdoc="<!doctype html><html><body></body></html>"');await wait('!!document.querySelector(".mod-frame-error")',500);
 for(const theme of ['light','dark']){await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('failed-'+theme);}
 assert.match(await read('document.querySelector(".mod-frame-error").textContent'),/didn't open/);
 assert.equal(await read('document.activeElement===document.querySelector(".mod-frame-error button")'),true);
 await click('.mod-frame-error button');await ready();await geometry();
 await read('window.fixture.owner(false)');await wait('!document.querySelector(".mod-workspace-surface iframe")');assert.equal(await read('!!document.querySelector("#conversation-input")'),true);
 await read('window.fixture.owner(true)');await ready();assert.equal(await read('document.querySelectorAll(".mod-workspace-surface iframe").length'),1);
 await click('.mod-chat-toggle');await wait('!document.querySelector(".mod-chat-drawer").hidden');await read('window.fixture.remount()');await ready();assert.equal(await read('document.querySelector(".mod-chat-drawer").hidden'),false,'window session remembers open state through remount');
 await read('window.fixture.failView=true;window.fixture.remount()');await wait('!!document.querySelector(".mod-frame-error")&&document.querySelector(".mod-workspace-title strong").textContent===window.fixture.modTitle');
 assert.equal(await read('document.querySelector(".mod-frame-error h2").textContent.includes(window.fixture.modTitle)'),true,'view failure uses catalog title');
 await read('window.fixture.failView=false');await click('.mod-frame-error button');await ready();
 await read('window.fixture.unmount()');await frame();assert.equal(await read('document.getElementById("root").childElementCount'),0);assert.deepEqual(await read('window.fixture.errors'),[]);assert.deepEqual(await read('window.fixture.notices'),[]);assert.equal(remote,0);
 console.log('PASS full Mod workspace: 8 screenshots; layout 720/760/1300/2560; Chat/Escape/focus/send/ui.chat/events/insert; hide/reload/ownership');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
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
        const code = await Promise.race([
          new Promise<number | null>((done, reject) => {
            child.once('error', reject);
            child.once('exit', done);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill();
              reject(new Error('Offscreen renderer timed out: ' + output));
            }, 90000);
          }),
        ]);
        assert.equal(code, 0, output);
        assert.match(output, /PASS full Mod workspace:/);
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
