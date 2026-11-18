import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import express from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { attachmentUploadRoute } from '../src/server/attachment-routes.ts';
import { canonicalQuote, messageQuoteSchema } from '../src/server/message-quotes.ts';
import { spawn } from '../src/server/platform/test-process.ts';
import type { ExecuteContext, RuntimeSnapshot } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'offscreen image markup: drawing, notes, focus, editing and executor delivery',
  { timeout: 150_000 },
  async (t) => {
    const root = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), 'pugport-image-markup-'));
    const artifacts = resolve('artifacts/annotations-screenshots');
    await mkdir(artifacts, { recursive: true });
    const controller = new Controller(directory, join(directory, 'data'), {
      readAccountIdentity: (target) => target.accountFingerprint,
    });
    clearInterval(controller.timer);
    controller.settings.taskJudgment = 'local';
    controller.settings.toolApprovalMode = 'auto';
    controller.settings.routineProvider = 'codex';
    controller.targets = [
      {
        id: 'fixture-codex',
        provider: 'codex',
        label: 'Fixture Codex',
        command: 'never-spawned',
        environment: 'native',
        enabled: true,
      },
    ];
    const runtime: RuntimeSnapshot = {
      id: 'fixture-codex',
      provider: 'codex',
      label: 'Fixture Codex',
      environment: 'native',
      installed: true,
      status: 'ready',
      models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium', 'high'] }],
      quota: {
        status: 'known',
        source: 'Fixture',
        observedAt: new Date().toISOString(),
        windows: [
          { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        ],
      },
      accounting: { mode: 'subscription', source: 'Fixture' },
      capabilities: { execute: true, resume: true, cancel: true, approvals: true },
      refreshedAt: new Date().toISOString(),
    };
    controller.snapshots = [runtime];
    const captures: ExecuteContext['input'][] = [];
    for (const adapter of [codexAdapter, claudeAdapter, grokAdapter]) {
      t.mock.method(adapter, 'discover', async () => runtime);
      t.mock.method(adapter, 'execute', async (ctx: ExecuteContext) => {
        captures.push(ctx.input);
        return { output: 'Synthetic annotation received.' };
      });
    }
    const workspace = new Workspace(controller, { autoTick: false, retryMs: 20 });
    const project = await workspace.createProject(directory);
    const conversation = workspace.createConversation(project.id);
    t.after(async () => {
      await workspace.close();
      await controller.close();
      assert.ok(
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
          basename(directory).startsWith('pugport-image-markup-'),
      );
      await rm(directory, { recursive: true, force: true });
    });
    // A synthetic product screen gives every colored mark a contrasting, non-private background.
    await writeFile(
      join(directory, 'photo.png'),
      await sharp(
        Buffer.from(
          `<svg width="1600" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="900" fill="#edf1f6"/><rect x="80" y="65" width="1440" height="770" rx="28" fill="white"/><rect x="80" y="65" width="1440" height="90" rx="28" fill="#17283c"/><text x="130" y="123" font-family="Arial" font-size="32" fill="white">Project overview</text><text x="160" y="240" font-family="Arial" font-size="42" fill="#17283c">A clearer workspace</text><text x="160" y="300" font-family="Arial" font-size="25" fill="#66758a">Review the details. Mark what should change.</text><rect x="180" y="365" width="340" height="220" rx="18" fill="#dce8f4"/><rect x="570" y="365" width="340" height="220" rx="18" fill="#e3eee4"/><rect x="960" y="365" width="340" height="220" rx="18" fill="#f5e9d7"/><rect x="180" y="650" width="210" height="62" rx="12" fill="#2f72bb"/><text x="219" y="691" font-family="Arial" font-size="25" fill="white">Continue</text><path d="M570 670H1300M570 710H1100" stroke="#c5ced8" stroke-width="16" stroke-linecap="round"/></svg>`,
        ),
      )
        .png()
        .toBuffer(),
    );
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
    );
    await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationWorkspace} from './src/ui/Workspace';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';import './src/ui/composer.css';import './src/ui/mods/mods.css';import './src/ui/ConversationModeView.css';
localStorage.setItem('comborunner.locale',new URLSearchParams(location.search).get('locale')||'zh-CN');
const project=${JSON.stringify({ ...project, name: 'Design review' })},conversation=${JSON.stringify({ ...conversation, title: 'Image annotations' })};
const initial={app:{name:'Fixture',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-first'},projects:[project],conversations:[conversation],targets:${JSON.stringify(controller.targets)},runtimes:${JSON.stringify(controller.snapshots)},runs:[],workflows:[],approvals:[],plugins:[],conversationMessages:[]};
window.notices=[];window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));
const api=async(path,body,method='POST')=>{
 const response=await fetch(path,{method:body===undefined?'GET':method,headers:body instanceof File?{'Content-Type':body.type,'x-attachment-name':encodeURIComponent(body.name)}:{'Content-Type':'application/json'},body:body instanceof File?body:body===undefined?undefined:JSON.stringify(body)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Fixture request failed');return result;
};
function Fixture(){const [revision,update]=useState(0);const [state,setState]=useState(initial);window.rerender=()=>update(x=>x+1);window.refresh=async()=>{const detail=await api('/api/conversations/'+conversation.id);setState({...initial,conversationMessages:detail.messages,workflows:detail.workflows});};return <main className="workspace-main" data-revision={revision} style={{height:'100vh'}}><ConversationWorkspace state={state} api={api} project={project} conversation={conversation} notify={notice=>window.notices.push(notice)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}}/><ConfirmDialogHost/></main>}
window.add=async(extra=false)=>{const input=document.querySelector('input[type=file]'),transfer=new DataTransfer();if(extra)for(let i=0;i<6;i++)transfer.items.add(new File(['Synthetic file '+i],'notes-'+i+'.txt',{type:'text/plain'}));else transfer.items.add(new File([await(await fetch('/photo.png')).blob()],'photo.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
window.pointer=(x,y,type)=>{const mark=document.querySelector('.image-markup'),rect=mark.getBoundingClientRect(),k=Number(mark.dataset.k);mark.querySelector('svg').dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:rect.left+x*k,clientY:rect.top+y*k}));};
window.setText=(selector,value)=>{const field=document.querySelector(selector);field.focus();Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));};
window.key=(key,ctrlKey=false)=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey,bubbles:true,cancelable:true}));
window.language=async locale=>{localStorage.setItem('comborunner.locale',locale);history.replaceState(null,'','?locale='+locale);await startInterfaceLanguage();};
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<Fixture/>));
`,
      },
      bundle: true,
      outfile: join(directory, 'fixture.js'),
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
    });
    const app = express();
    attachmentUploadRoute(app, workspace.attachments);
    app.use(express.json({ limit: '2mb' }));
    app.get('/api/conversations/:id', (req, res) => res.json(workspace.conversation(req.params.id)));
    app.get('/api/conversations/:id/attachments/:attachmentId/content', (req, res) =>
      res.sendFile(workspace.attachments.get(req.params.id, req.params.attachmentId).path),
    );
    const schema = z.object({
      content: z.string(),
      attachmentIds: z.array(z.string()).optional(),
      quotes: z.array(messageQuoteSchema).optional(),
    });
    app.post('/api/conversations/:id/messages', async (req, res) => {
      try {
        const body = schema.parse(req.body);
        const result = await workspace.send(req.params.id, {
          ...body,
          quotes: body.quotes?.map(canonicalQuote),
          mode: 'chat',
          permissionMode: 'read-only',
          executionPolicy: 'cli-first',
          autoEscalate: true,
        });
        res.json(result);
        await workspace.tickQueue();
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
      }
    });
    app.get('/fixture/captures', (_req, res) => res.json(captures));
    app.use('/api', (_req, res) => res.json({}));
    app.use(express.static(directory));
    const server = await listenForFetch(app);
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const runner = join(directory, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let win;
 try{
  win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith(${JSON.stringify(base)})&&!details.url.startsWith('blob:')&&!details.url.startsWith('data:')}));
  const evaluate=code=>win.webContents.executeJavaScript(code);
  const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const wait=async expression=>{for(let i=0;i<220;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+expression+'; notices '+await evaluate('JSON.stringify(window.notices)'));};
  const click=async selector=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
  const label=async(text,scope='.image-markup-toolbar')=>{await evaluate('(()=>{const b=[...document.querySelectorAll('+JSON.stringify(scope+' button')+')].find(b=>b.getAttribute("aria-label")==='+JSON.stringify(text)+'||b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw Error("Missing button: "+'+JSON.stringify(text)+');b.click();})()');await frame();};
  const key=async(key,ctrl=false)=>{await evaluate('window.key('+JSON.stringify(key)+','+ctrl+')');await frame();};
  const draw=async(from,to,moves=1)=>{await evaluate('window.pointer('+from[0]+','+from[1]+',"pointerdown")');for(let i=1;i<=moves;i++)await evaluate('window.pointer('+(from[0]+(to[0]-from[0])*i/moves)+','+(from[1]+(to[1]-from[1])*i/moves)+',"pointermove")');await evaluate('window.pointer('+to[0]+','+to[1]+',"pointerup")');await frame();};
  const badges=()=>evaluate('document.querySelectorAll(".image-mark-badge").length');
  const shot=async(name)=>{await frame();const image=await new Promise(resolve=>{win.webContents.once('paint',(_e,_r,image)=>resolve(image));win.webContents.invalidate();});assert.equal(image.isEmpty(),false);await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),image.toPNG());};
  for(const locale of ['zh-CN','en']){
   const en=locale==='en';
   if(en)await evaluate('window.language("en")');else await win.loadURL(${JSON.stringify(base)}+'/?locale='+locale);await wait('!!document.querySelector("#conversation-input")');await evaluate('window.add()');await wait('document.querySelector(".attachment-chip-preview img")?.naturalWidth>0');
   await click('.attachment-chip-preview');await wait('document.querySelector(".image-viewer img")?.naturalWidth>0');await click('.image-viewer img');await wait('!!document.querySelector(".image-markup-toolbar") && Number(document.querySelector(".image-markup")?.dataset.k)>0');
   assert.equal(await evaluate('document.activeElement.classList.contains("image-markup-stage")'),true);
   await draw([200,150],[500,350]);assert.equal(await badges(),1);assert.equal(await evaluate('!!document.querySelector(".image-markup ellipse")'),true);
   await evaluate('window.setText(".quote-editor textarea","改成蓝色")');await frame();await evaluate('window.rerender()');await frame();
   assert.equal(await evaluate('document.activeElement===document.querySelector(".quote-editor textarea")'),true,'D2: parent re-render keeps note focus');assert.equal(await evaluate('document.querySelector(".quote-editor textarea").value'),'改成蓝色');await evaluate('document.querySelector(".image-markup-swatch").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');await frame();assert.equal(await evaluate('!!document.querySelector(".quote-editor")'),false,'Outside press saves and closes the note');
   await label(en?'Blue':'蓝色');await label(en?'Arrow':'箭头');await draw([100,800],[400,600]);assert.equal(await badges(),2);assert.equal(await evaluate('[...document.querySelectorAll(".image-markup line")].some(line=>getComputedStyle(line).stroke==="rgb(59, 130, 246)")'),true);await evaluate('window.setText(".quote-editor textarea","对齐左边")');await frame();await evaluate('document.querySelector(".image-mark-badge").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');await frame();assert.equal(await evaluate('!!document.querySelector(".quote-editor")'),false,'Badge press saves and closes the note');
   await label(en?'Pen':'画笔');await draw([600,250],[900,300],10);assert.equal(await badges(),3);await key('Escape');
   await label(en?'Rectangle':'方框');await draw([950,360],[1310,590]);assert.equal(await badges(),4);await key('Escape');
   await label(en?'Text':'文字');await draw([1400,100],[1400,100]);await wait('!!document.querySelector(".image-markup-text")');await evaluate('window.setText(".image-markup-text","取消文字")');await frame();await key('Escape');assert.equal(await badges(),4,'Escape does not commit text through blur');
   await draw([1400,100],[1400,100]);await evaluate('window.setText(".image-markup-text","重点")');await frame();await key('Enter');await evaluate('document.querySelector(".image-markup-stage").focus()');await frame();assert.equal(await badges(),5,'Enter followed by blur commits once');assert.equal(await evaluate('!!document.querySelector(".quote-editor")'),false);
   assert.equal(await evaluate('document.querySelector(".image-mark-label").textContent'),'重点');await label(en?'Marker':'编号点');await draw([1500,200],[1500,200]);assert.equal(await badges(),6);await key('Escape');
   await evaluate('document.querySelectorAll(".image-mark-badge")[1].dispatchEvent(new MouseEvent("click",{bubbles:true}))');await frame();await label(en?'Remove':'移除','.quote-editor');assert.equal(await badges(),5);await key('z',true);assert.equal(await badges(),6);
   await evaluate('document.querySelectorAll(".image-mark-badge")[0].dispatchEvent(new MouseEvent("click",{bubbles:true}))');await frame();
   for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();await new Promise(r=>setTimeout(r,300));assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await shot('image-'+locale+'-'+theme);}
   await key('Escape');await key('Escape');await wait('!!document.querySelector("dialog.confirm-dialog[open]")');await label(en?'Cancel':'取消','.confirm-dialog');assert.equal(await badges(),6);
   await label(en?'Done':'完成');await wait('!document.querySelector(".image-viewer")');assert.equal(await evaluate('document.querySelectorAll(".attachment-chip-preview").length'),2);assert.equal(await evaluate('document.querySelectorAll(".quote-chip.markup").length'),1);
   await evaluate('document.querySelector("#conversation-input").closest(".conversation-composer").scrollIntoView({block:"center"})');await frame();
   for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();await new Promise(r=>setTimeout(r,300));await shot('composer-'+locale+'-'+theme);}
   await click('.quote-chip.markup > button');await wait('document.querySelectorAll(".image-mark-badge").length===6');await evaluate('document.querySelectorAll(".image-mark-badge")[5].dispatchEvent(new MouseEvent("click",{bubbles:true}))');await frame();await label(en?'Remove':'移除','.quote-editor');await label(en?'Done':'完成');await wait('!document.querySelector(".image-viewer")');assert.equal(await evaluate('document.querySelectorAll(".attachment-chip-preview").length'),2);assert.equal(await evaluate('document.querySelectorAll(".quote-chip.markup").length'),1);
   if(en)continue;
   await evaluate('window.add(true)');await wait('document.querySelectorAll(".attachment-chip").length===8');await click('.attachment-chip-preview');await wait('document.querySelector(".image-viewer img")?.naturalWidth>0');await click('.image-viewer img');await wait('Number(document.querySelector(".image-markup")?.dataset.k)>0');await draw([650,400],[850,550]);await key('Escape');await label('完成');await wait('window.notices.some(n=>n.message.includes("最多添加 8 个附件"))');assert.equal(await evaluate('!!document.querySelector(".image-viewer")'),true);await key('Escape');await wait('!!document.querySelector("dialog.confirm-dialog[open]")');await label('放弃','.confirm-dialog');await click('.image-viewer-close');
   await evaluate('window.setText("#conversation-input","按标注修改界面")');await frame();await key('Enter');await wait('window.notices.every(n=>!n.message.includes("failed")) && !document.querySelector(".attachment-chip")');
   await wait('fetch("/fixture/captures").then(r=>r.json()).then(c=>c.length>0)');await evaluate('window.refresh()');await wait('document.querySelectorAll(".message-attachment-link").length===2');
   assert.equal(await evaluate('!!document.querySelector(".image-viewer")||!!document.querySelector(".quote-editor")'),false);
   // The user-message attachment opens the same editor, using the stored original.
   await click('.message-attachment-link');await wait('document.querySelector(".image-viewer img")?.naturalWidth>0');await click('.image-viewer img');await wait('!!document.querySelector(".image-markup-toolbar")');await key('Escape');await click('.image-viewer-close');
   assert.deepEqual(await evaluate('window.errors'),[]);
  }
 }catch(error){console.error(error.stack||String(error));process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});`,
    );
    const require = createRequire(import.meta.url),
      environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron') as string, electronArgs(runner), {
      cwd: root,
      env: environment,
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
    const timer = setTimeout(() => child.kill(), 120_000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
    } finally {
      clearTimeout(timer);
    }
    const delivered = captures.find((input) => input.prompt.includes('标记 1（圆圈，红色）'));
    assert.ok(delivered, 'The real workspace dispatch reaches the mock executor.');
    assert.match(delivered.prompt, /\(0\.13, 0\.17\).*\(0\.31, 0\.39\)/);
    assert.match(delivered.prompt, /对引用 1 的要求：标记 1：改成蓝色/);
    assert.match(delivered.prompt, /标记 2：对齐左边/);
    assert.match(delivered.prompt, /局部放大图：photo-标注-1\.jpg/);
    const annotated = delivered.attachments!.find((file) => file.name === 'photo-标注.png');
    assert.ok(annotated);
    const metadata = await sharp(annotated.path).metadata();
    assert.equal(metadata.width, 1600);
    assert.equal(metadata.height, 900);
    const { data, info } = await sharp(annotated.path).raw().toBuffer({ resolveWithObject: true });
    const offset = (150 * info.width + 508) * info.channels;
    assert.ok(data[offset]! > 180 && data[offset + 1]! < 90, 'The composed PNG includes the red first badge.');
    const crops = delivered.attachments!.filter((file) => /^photo-标注-\d+\.jpg$/.test(file.name));
    assert.equal(crops.length, 5);
    for (const crop of crops) {
      const size = await sharp(crop.path).metadata();
      assert.equal(size.format, 'jpeg');
      assert.ok(size.width! <= 1024 && size.height! <= 1024);
    }
    const message = workspace.conversation(conversation.id).messages.find((message) => message.role === 'user')!;
    assert.equal(message.attachments!.length, 8);
    assert.equal(message.quotes![0]!.markup!.marks.length, 5);
    assert.equal(message.quotes![0]!.markup!.crops!.length, 5);
  },
);
