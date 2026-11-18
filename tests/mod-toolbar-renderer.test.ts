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
  'Mod components preserve mounted input across visibility and side chat, with accessible toolbar and removal',
  { timeout: 60000 },
  async () => {
    const root = process.cwd();
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-mod-components-'));
    const artifacts = resolve('artifacts/mod-components');
    await mkdir(artifacts, { recursive: true });
    try {
      const main = await readFile(join(root, 'src/ui/main.tsx'), 'utf8');
      const styles = [...main.matchAll(/^import ['"](\.\/[^'"]+\.css)['"];$/gm)]
        .map((match) => `<link rel="stylesheet" href="${pathToFileURL(resolve(root, 'src/ui', match[1]!)).href}">`)
        .join('');
      assert.ok(styles.includes('conversation-work.css'));
      await writeFile(
        join(fixture, 'fixture.css'),
        `body{margin:0}.fixture-toolbar{height:48px;display:flex;align-items:center;justify-content:flex-end;padding:0 12px}.fixture-row{display:flex;gap:6px;padding:8px}.conversation-with-side-chat{display:flex;position:relative;height:calc(100vh - 120px)}.fixture-chat{flex:1;min-width:0;padding:16px;display:flex;flex-direction:column}.fixture-composer{box-sizing:border-box;width:100%;min-width:0;margin-top:auto}.fixture-side{width:340px}`,
      );
      await writeFile(
        join(fixture, 'index.html'),
        `<!doctype html><html data-theme="light"><meta charset="utf-8">${styles}<link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>`,
      );
      await build({
        stdin: {
          sourcefile: join(root, 'mod-components-fixture.tsx'),
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{ModBadge}from'./src/ui/mods/ModBadge';import{ModToolbarButton}from'./src/ui/mods/ModToolbarButton';import{ModPanel}from'./src/ui/mods/ModPanel';
const manifest={schemaVersion:2,id:'synthetic.notes',version:'1.0.0',title:'Synthetic notes',description:'Local fixture',icon:'notebook-pen',contributions:{rightPanel:{kind:'form',form:{fields:[{id:'note',label:'Note',type:'textarea'}],actions:[]}}}};
const binding={instanceId:'i',modeId:manifest.id,version:manifest.version};const view={binding,pending:null,installed:true,manifest,instance:{id:'i',conversationId:'c',modeId:manifest.id,version:'1.0.0',schemaVersion:1,revision:0,state:{note:'saved'},createdAt:'',updatedAt:''}};
const f=window.fixture={installed:[],binding:null,hidden:false,hasSurface:true,sideChat:false,busy:false,opens:0,toggles:0,selected:[],removed:0,stores:0,view};let redraw;f.set=p=>{Object.assign(f,p);redraw();};
function Fixture(){const[,update]=useState(0);redraw=()=>update(n=>n+1);return <><div className="fixture-row" data-row="normal"><ModBadge mode={manifest}/>Ordinary chat</div><div className="fixture-row" data-row="pinned"><ModBadge/>Pinned chat</div><header className="fixture-toolbar"><ModToolbarButton installed={f.installed} binding={f.binding} mode={manifest} hidden={f.hidden} hasSurface={f.hasSurface} busy={f.busy} onOpen={()=>{f.opens++;}} onSelect={id=>{f.selected.push(id);f.set({binding});}} onToggle={()=>{f.toggles++;f.set({hidden:!f.hidden});}} onStore={()=>f.stores++}/></header><div className="conversation-with-side-chat"><section className="fixture-chat">Chat remains visible<textarea className="fixture-composer" aria-label="Chat draft"/></section><ModPanel view={view} hidden={f.hidden||f.sideChat} busy={f.busy} onSave={async values=>{view.instance.state={...values};redraw();}} onCompose={()=>{}} onStore={()=>f.stores++} onRemove={()=>f.removed++}/>{f.sideChat&&<aside className="fixture-side">Side chat</aside>}</div></>;}
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
              // Resolve through Node so esbuild does not enumerate restricted worktree ancestors.
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
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{win=new BrowserWindow({show:false,width:1300,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!d.url.startsWith('file://');if(cancel)remote++;cb({cancel});});await win.loadFile(path.join(__dirname,'index.html'));
const read=c=>win.webContents.executeJavaScript(c);const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');for(let n=0;n<30;n++){await frame();if(await read('!!window.fixture?.set'))break;}
const patch=async p=>{await read('window.fixture.set('+p+')');await frame();};const click=async s=>{await read('document.querySelector('+JSON.stringify(s)+').click()');await frame();};const key=async k=>{await read('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(k)+',bubbles:true}))');await frame();};
assert.equal(await read('window.fixture.opens'),1);assert.equal(await read('!!document.querySelector(".mod-toolbar-button")'),false);assert.equal(await read('[...document.querySelectorAll(".mod-badge")].every(b=>(b.getAttribute("aria-label")==="Mod"||b.getAttribute("aria-label")==="Mod\uff1aSynthetic notes")&&b.textContent===""&&b.querySelector("svg").getAttribute("width")==="13")'),true);
await patch('{installed:[{...window.fixture.view.manifest,compatible:true}]}');assert.equal(await read('document.querySelector(".mod-toolbar-button").getAttribute("aria-label")'),'添加 Mod');await click('.mod-toolbar-button');assert.equal(await read('document.activeElement.getAttribute("role")'),'menuitem');await key('Escape');assert.equal(await read('document.activeElement.classList.contains("mod-toolbar-button")'),true);await click('.mod-toolbar-button');await click('.mod-toolbar [role=menuitem]');assert.deepEqual(await read('window.fixture.selected'),['synthetic.notes']);assert.equal(await read('document.querySelector(".mod-toolbar-button").getAttribute("aria-pressed")'),'true');
await read('window.originalInput=document.querySelector(".mod-panel textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(window.originalInput,"unsaved draft");window.originalInput.dispatchEvent(new Event("input",{bubbles:true}))');await frame();
await click('.mod-toolbar-button');assert.equal(await read('document.querySelector(".mod-panel").hidden'),true);assert.equal(await read('document.querySelector(".mod-toolbar-button").getAttribute("aria-label")'),'显示 Mod');await click('.mod-toolbar-button');assert.equal(await read('document.querySelector(".mod-panel").hidden'),false);assert.equal(await read('document.querySelector(".mod-panel textarea")===window.originalInput'),true);assert.equal(await read('window.originalInput.value'),'unsaved draft');
await patch('{sideChat:true}');assert.equal(await read('getComputedStyle(document.querySelector(".mod-panel")).display'),'none');await patch('{sideChat:false}');assert.equal(await read('document.querySelector(".mod-panel textarea")===window.originalInput&&window.originalInput.value==="unsaved draft"'),true);await patch('{hidden:true,sideChat:true}');await patch('{sideChat:false}');assert.equal(await read('document.querySelector(".mod-panel").hidden'),true);await patch('{hidden:false}');
await patch('{hasSurface:false}');await click('.mod-toolbar-button');assert.equal(await read('document.querySelector(".mod-toolbar-button").getAttribute("aria-haspopup")'),'menu');await click('.mod-toolbar [role=menuitem]');assert.equal(await read('window.fixture.stores'),1);await patch('{installed:[],hasSurface:true}');assert.equal(await read('!!document.querySelector(".mod-toolbar-button")'),true);
await click('.mod-panel-menu > button');assert.equal(await read('document.querySelector(".mod-panel-menu [role=menuitem]").textContent.trim()'),'从此对话移除 Mod');await click('.mod-panel-menu [role=menuitem]');assert.equal(await read('window.fixture.removed'),1);assert.equal(await read('!!document.querySelector("[role=dialog]")'),false);await patch('{busy:true}');assert.equal(await read('document.querySelector(".mod-toolbar-button").disabled&&document.querySelector(".mod-panel-menu > button").disabled'),true);await patch('{busy:false}');
const layout=async()=>assert.equal(await read('(()=>{const chat=document.querySelector(".fixture-chat").getBoundingClientRect(),panel=document.querySelector(".mod-panel").getBoundingClientRect(),input=document.querySelector(".fixture-composer"),box=input.getBoundingClientRect();return chat.width>0&&panel.width>0&&chat.right<=panel.left+1&&panel.right<=innerWidth+1&&box.width>0&&box.height>0&&box.right<=panel.left+1&&box.bottom<=innerHeight+1&&document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===input})()'),true,'Mod must remain beside the visible chat composer');await layout();assert.equal(await read('document.querySelector(".mod-toolbar-button").getBoundingClientRect().width'),32);await fs.writeFile(path.join(${JSON.stringify(artifacts)},'panel-light-wide.png'),(await win.webContents.capturePage()).toPNG());await read('document.documentElement.dataset.theme="dark"');win.setSize(390,760);await frame();assert.equal(await read('(()=>{const chat=document.querySelector(".fixture-chat").getBoundingClientRect(),panel=document.querySelector(".mod-panel").getBoundingClientRect();return Math.abs(chat.width-innerWidth)<=1&&panel.right<=innerWidth+1&&getComputedStyle(document.querySelector(".mod-panel")).position==="absolute"})()'),true,'narrow panel overlays full width chat');assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);await fs.writeFile(path.join(${JSON.stringify(artifacts)},'panel-dark-narrow.png'),(await win.webContents.capturePage()).toPNG());await read('window.fixture.unmount()');await frame();assert.equal(await read('document.getElementById("root").childElementCount'),0);assert.equal(remote,0);console.log('PASS Mod components: toolbar states, keyboard, badges, mounted input, side chat, immediate removal, narrow layout');}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
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
        assert.match(output, /PASS Mod components:/);
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
