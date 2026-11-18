import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'real Workspace keeps the same unsaved Mod input across visibility, side chat and reload',
  { timeout: 60000 },
  async () => {
    const root = process.cwd();
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-mod-workspace-'));
    const artifacts = resolve('artifacts/mod-workspace');
    await mkdir(artifacts, { recursive: true });
    try {
      const main = await readFile(join(root, 'src/ui/main.tsx'), 'utf8');
      const styles = [...main.matchAll(/^import ['"](\.\/[^'"]+\.css)['"];$/gm)]
        .map((match) => `<link rel="stylesheet" href="${pathToFileURL(resolve(root, 'src/ui', match[1]!)).href}">`)
        .join('');
      assert.ok(styles.includes('conversation-work.css'));

      await writeFile(
        join(fixture, 'index.html'),
        `<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css">${styles}<body><div id="root"></div><script src="fixture.js"></script></body></html>`,
      );
      await build({
        stdin: {
          sourcefile: join(root, 'mod-workspace-fixture.tsx'),
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{ConversationWorkspace}from'./src/ui/Workspace';
const stamp='2026-10-27T00:00:00Z';
const project={id:'project',name:'Synthetic project',path:'C:/Synthetic',createdAt:stamp,updatedAt:stamp};
const binding={instanceId:'instance',modeId:'synthetic.notes',version:'1.0.0'};
const manifest={schemaVersion:2,id:binding.modeId,version:binding.version,title:'Synthetic notes',description:'Fixture',contributions:{rightPanel:{kind:'form',form:{fields:[{id:'note',label:'Note',type:'textarea'}],actions:[]}}}};
const view={binding,pending:null,installed:true,manifest,instance:{id:binding.instanceId,conversationId:'chat',modeId:binding.modeId,version:binding.version,schemaVersion:1,revision:0,state:{note:'saved'},createdAt:stamp,updatedAt:stamp}};
let stored={id:'chat',projectId:project.id,title:'Synthetic chat',modeBinding:binding,createdAt:stamp,updatedAt:stamp};
const base={app:{name:'Fixture',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-first'},projects:[project],targets:[],runtimes:[],runs:[],workflows:[],approvals:[],plugins:[],conversationMessages:[]};
const f=window.fixture={calls:[],notices:[],errors:[],stored:()=>stored};
window.addEventListener('error',e=>f.errors.push(e.message));window.addEventListener('unhandledrejection',e=>f.errors.push(String(e.reason)));
const api=async(path,body,method='POST')=>{
 f.calls.push({path,body,method});
 if(path==='/api/conversations/chat/mode/visibility'){if(method!=='PUT')throw Error('Wrong visibility method');stored={...stored,modeHidden:body.hidden?true:undefined};return structuredClone(stored);}
 if(path==='/api/conversations/chat/mode')return structuredClone(view);
 if(path==='/api/modes')return{catalog:[{...manifest,compatible:true}],installed:[{modeId:binding.modeId,version:binding.version,installedAt:stamp}]};
 if(path==='/api/conversations/chat/side-chat')return{id:'side',projectId:project.id,title:'Synthetic side chat',createdAt:stamp,updatedAt:stamp,sideChat:{parentConversationId:'chat',selection:body.selection}};
 if(path==='/api/conversations/chat'||path==='/api/conversations/side')return{messages:[],workflows:[]};
 throw Error('Unexpected fixture request: '+method+' '+path);
};
function Fixture(){const[conversation,setConversation]=useState(()=>structuredClone(stored));const[key,setKey]=useState(0);const reload=async()=>setConversation(structuredClone(stored));f.remount=()=>{setConversation(structuredClone(stored));setKey(v=>v+1);};return <main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace key={key} state={{...base,conversations:[conversation]}} project={project} conversation={conversation} api={api} reload={reload} notify={n=>f.notices.push(n)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}}/></main>;}
const root=createRoot(document.getElementById('root'));f.unmount=()=>root.unmount();root.render(<Fixture/>);
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
                loader:
                  extname(args.path) === '.png'
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
      assert.ok((await readFile(join(fixture, 'index.html'), 'utf8')).includes(styles));
      const runner = join(fixture, 'runner.cjs');
      await writeFile(
        runner,
        `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1300,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!/^(file:|data:|blob:)/.test(d.url);if(cancel)remote++;cb({cancel});});
 await win.loadFile(path.join(__dirname,'index.html'));
 const read=c=>win.webContents.executeJavaScript(c);
 const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const wait=async code=>{for(let n=0;n<100;n++){if(await read(code))return;await frame();}throw Error('Timed out: '+code+'; '+JSON.stringify(await read('window.fixture?.errors')));};
 const click=async selector=>{await read('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
 const checkInput=async()=>{assert.equal(await read('document.querySelector(".mod-panel textarea")===window.originalInput'),true);assert.equal(await read('window.originalInput.value'),'unsaved draft');assert.equal(await read('!!document.querySelector("#conversation-input")'),true);};
 const layout=async()=>assert.equal(await read('(()=>{const chat=document.querySelector(".conversation-workspace").getBoundingClientRect(),panel=document.querySelector(".mod-panel").getBoundingClientRect(),input=document.querySelector("#conversation-input"),box=input.getBoundingClientRect();return chat.width>0&&panel.width>0&&chat.right<=panel.left+1&&panel.right<=innerWidth+1&&box.width>0&&box.height>0&&box.right<=panel.left+1&&box.bottom<=innerHeight+1&&document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===input})()'),true,'Mod must remain beside the visible chat composer');
 await wait('!!document.querySelector(".mod-panel textarea")');await layout();
 await read('window.originalInput=document.querySelector(".mod-panel textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(window.originalInput,"unsaved draft");window.originalInput.dispatchEvent(new Event("input",{bubbles:true}))');await frame();
 await click('.mod-toolbar-button');await wait('document.querySelector(".mod-panel").hidden');assert.equal(await read('window.fixture.stored().modeHidden'),true);await checkInput();
 await click('.mod-toolbar-button');await wait('!document.querySelector(".mod-panel").hidden');assert.equal(await read('window.fixture.stored().modeHidden'),undefined);await checkInput();
 await click('[aria-label="新侧聊"]');await wait('!!document.querySelector(".side-chat-panel")');assert.equal(await read('getComputedStyle(document.querySelector(".mod-panel")).display'),'none');await checkInput();
 await click('[aria-label="关闭侧聊"]');await wait('!document.querySelector(".mod-panel").hidden');await checkInput();
 await click('.mod-toolbar-button');await wait('document.querySelector(".mod-panel").hidden');await click('[aria-label="新侧聊"]');await click('[aria-label="关闭侧聊"]');assert.equal(await read('document.querySelector(".mod-panel").hidden'),true);await checkInput();
 assert.deepEqual(await read('window.fixture.calls.filter(c=>c.path.endsWith("/visibility")).map(c=>[c.method,c.body.hidden])'),[['PUT',true],['PUT',false],['PUT',true]]);
 await read('window.fixture.remount()');await wait('document.querySelector(".mod-panel textarea")&&document.querySelector(".mod-panel textarea")!==window.originalInput');assert.equal(await read('document.querySelector(".mod-panel").hidden'),true);assert.equal(await read('document.querySelector(".mod-toolbar-button").getAttribute("aria-pressed")'),'false');
 await click('.mod-toolbar-button');await wait('!document.querySelector(".mod-panel").hidden');await fs.writeFile(path.join(${JSON.stringify(artifacts)},'workspace-panel.png'),(await win.webContents.capturePage()).toPNG());
 win.setSize(390,760);await frame();assert.equal(await read('(()=>{const chat=document.querySelector(".conversation-workspace").getBoundingClientRect(),panel=document.querySelector(".mod-panel").getBoundingClientRect();return Math.abs(chat.width-innerWidth)<=1&&panel.right<=innerWidth+1&&getComputedStyle(document.querySelector(".mod-panel")).position==="absolute"})()'),true,'narrow panel overlays full width chat');
 await read('window.fixture.unmount()');await frame();assert.equal(await read('document.getElementById("root").childElementCount'),0);assert.deepEqual(await read('window.fixture.errors'),[]);assert.deepEqual(await read('window.fixture.notices'),[]);assert.equal(remote,0);
 console.log('PASS Mod workspace: actual DOM, persisted visibility, mounted draft, side chat and reload');
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
              reject(new Error(`Offscreen renderer timed out: ${output}`));
            }, 45000);
          }),
        ]);
        assert.equal(code, 0, output);
        assert.match(output, /PASS Mod workspace:/);
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
