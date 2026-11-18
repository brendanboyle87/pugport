// Real browser File/ClipboardEvent/DragEvent interactions against a fixture-only React workspace.
// Does not start a CLI, read account data, or send a model request.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { electronArgs } = require('../tests/helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const out = path.join(root, 'reports', `attachments-ui-${version}`);
const reportPath = path.join(out, 'smoke.json');
const prefix = 'comborunner-attachment-ui-';
const imageBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwa9uNFTEMLQkAgKRdwYaouw4AAAAASUVORK5CYII=';

if (!process.versions.electron) {
  void (async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      const source = `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ConversationWorkspace } from './src/ui/Workspace.tsx';
        const at = '2026-09-27T18:00:00Z';
        const project = { id: 'project', name: '附件功能验证', path: 'C:/Fixture/Attachments', createdAt: at, updatedAt: at };
        const conversations = ['a','b'].map(id=>({ id, projectId:'project', title:'Fixture '+id,createdAt:at,updatedAt:at }));
        const fixture = window.__fixture = { requests:[], notifications:[], uploads:{}, creates:0, next:0, failNextUpload:false, failNextMessage:false, holdNextUpload:false };
        function Fixture() {
          const [conversation,setConversation]=useState(conversations[0]);
          const [messages,setMessages]=useState([]);
          fixture.select=(id)=>setConversation(id ? conversations.find(item=>item.id===id) : undefined);
          const api = async (path,body) => {
            fixture.requests.push({path,body});
            if (path==='/api/conversations') {
              const created={...conversations[0],id:'created-'+(++fixture.creates),title:'Created'}; conversations.push(created); return created;
            }
            const upload=/^\\/api\\/conversations\\/([^/]+)\\/attachments$/.exec(path);
            if (upload) {
              if(fixture.failNextUpload){fixture.failNextUpload=false;throw Error('fixture upload failed');}
              if(fixture.holdNextUpload){fixture.holdNextUpload=false;fixture.waiting=true;await new Promise(resolve=>fixture.release=resolve);fixture.waiting=false;}
              const item={id:'attachment-'+(++fixture.next),name:body.name,mimeType:body.type,size:body.size,kind:body.type.startsWith('image/')?'image':'file'};
              fixture.uploads[item.id]=item;return item;
            }
            const message=/^\\/api\\/conversations\\/([^/]+)\\/messages$/.exec(path);
            if(message){
              if(fixture.failNextMessage){fixture.failNextMessage=false;throw Error('fixture message failed');}
              setMessages(previous=>[...previous,{id:'message-'+fixture.requests.length,conversationId:message[1],role:'user',content:body.content,createdAt:at,attachments:(body.attachmentIds||[]).map(id=>fixture.uploads[id])}]);
              return {message:{id:'message-'+fixture.requests.length,conversationId:message[1],role:'user',content:body.content,createdAt:at,clientMessageId:body.clientMessageId}};
            }
            throw Error('Unexpected API '+path);
          };
          const state={app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'fixture'},targets:[],runtimes:[],runs:[],approvals:[],plugins:[],refreshing:false,settings:{refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',unknownQuotaPolicy:'allow',defaultProjectPath:project.path,maxConcurrentRuns:1},projects:[project],conversations,conversationMessages:messages,workflows:[]};
          return <main className="studio-main" style={{height:'100vh'}}><ConversationWorkspace state={state} api={api} project={project} conversation={conversation} notify={notice=>fixture.notifications.push(notice)} onConversation={setConversation} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} /></main>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `;
      await require('esbuild').build({
        stdin: { contents: source, loader: 'tsx', resolveDir: root },
        outfile: path.join(temporary, 'fixture.js'),
        bundle: true,
        platform: 'browser',
        format: 'esm',
        jsx: 'automatic',
        logLevel: 'silent',
      });
      const environment = { ...process.env, COMBORUNNER_ATTACHMENT_UI_PROFILE: temporary };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        windowsHide: true,
        stdio: 'inherit',
        env: environment,
      });
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
    } finally {
      const resolved = await fs.realpath(temporary),
        tempRoot = await fs.realpath(os.tmpdir());
      assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith(prefix));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
      report.temporaryProfileRemoved = true;
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ passed: report.passed, checks: report.checks, temporaryProfileRemoved: true }));
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = process.env.COMBORUNNER_ATTACHMENT_UI_PROFILE;
  assert.ok(profile && path.basename(profile).startsWith(prefix));
  app.setPath('userData', path.join(profile, 'profile'));
  const checks = [],
    errors = [],
    sockets = new Set();
  let window, server;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = (source) => window.webContents.executeJavaScript(source, true);
  async function wait(source) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(source)) return;
      await pause(50);
    }
    throw Error('UI timeout: ' + source);
  }
  async function click(selector) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await pause(30);
  }
  async function setText(value) {
    await evaluate(
      `(()=>{const el=document.querySelector('#conversation-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await pause(30);
  }
  async function paste(name = 'pasted.png') {
    await evaluate(
      `(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(imageBase64)}),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],${JSON.stringify(name)},{type:'image/png'}));document.querySelector('#conversation-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`,
    );
  }
  async function drop(name = 'requirements.pdf') {
    await evaluate(
      `(()=>{const data=new DataTransfer();data.items.add(new File(['fixture document'],${JSON.stringify(name)},{type:'application/pdf'}));const el=document.querySelector('.conversation-workspace');el.dispatchEvent(new DragEvent('dragenter',{dataTransfer:data,bubbles:true,cancelable:true}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));})()`,
    );
  }
  const uploadCount = () => evaluate(`window.__fixture.requests.filter(r=>r.path.endsWith('/attachments')).length`);
  const messageCount = () => evaluate(`window.__fixture.requests.filter(r=>r.path.endsWith('/messages')).length`);
  void app
    .whenReady()
    .then(async () => {
      await fs.mkdir(out, { recursive: true });
      const report = {
        at: new Date().toISOString(),
        passed: false,
        fixture: true,
        realModelRequests: 0,
        checks,
        errors,
      };
      try {
        server = require('node:http').createServer(async (request, response) => {
          try {
            if (request.url === '/fixture.js') {
              response.setHeader('Content-Type', 'text/javascript');
              response.end(await fs.readFile(path.join(profile, 'fixture.js')));
            } else if (request.url === '/style.css') {
              response.setHeader('Content-Type', 'text/css');
              response.end(await fs.readFile(path.join(root, 'src', 'ui', 'studio.css')));
            } else if (request.url.startsWith('/api/conversations/')) {
              response.setHeader('Content-Type', 'image/png');
              response.end(Buffer.from(imageBase64, 'base64'));
            } else {
              response.setHeader('Content-Type', 'text/html');
              response.end(
                '<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
              );
            }
          } catch {
            response.statusCode = 500;
            response.end();
          }
        });
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        window = new BrowserWindow({
          show: false,
          width: 1300,
          height: 940,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            offscreen: true,
            backgroundThrottling: false,
          },
        });
        window.webContents.on('console-message', (_event, level, message) => {
          if (level >= 3) errors.push(message);
        });
        await window.loadURL(`http://127.0.0.1:${server.address().port}`);
        await wait(`!!document.querySelector('#conversation-input')`);
        await setText('请查看截图中的问题');
        await paste();
        await wait(`document.querySelectorAll('.attachment-chip').length===1`);
        assert.equal(await evaluate(`document.querySelector('#conversation-input').value`), '请查看截图中的问题');
        await wait(`document.querySelector('.attachment-chip img')?.naturalWidth>0`);
        await drop();
        await wait(`document.querySelectorAll('.attachment-chip').length===2`);
        await click('button[aria-label="移除附件 requirements.pdf"]');
        await wait(`document.querySelectorAll('.attachment-chip').length===1`);
        checks.push('real ClipboardEvent image paste, DragEvent document drop, local thumbnail and removal work');

        await evaluate('window.__fixture.failNextUpload=true');
        await click('button[aria-label="发送消息"]');
        await wait(
          `window.__fixture.notifications.some(n=>n.message==='fixture upload failed') && !document.querySelector('#conversation-input').disabled`,
        );
        assert.equal(await evaluate(`document.querySelectorAll('.attachment-chip').length`), 1);
        assert.equal(await evaluate(`document.querySelector('#conversation-input').value`), '请查看截图中的问题');
        await evaluate('window.__fixture.failNextMessage=true');
        await click('button[aria-label="发送消息"]');
        await wait(
          `window.__fixture.notifications.some(n=>n.message==='fixture message failed') && !document.querySelector('#conversation-input').disabled`,
        );
        assert.ok(
          await evaluate(`document.querySelector('.attachment-chip-preview').title.includes('已上传，待发送')`),
        );
        const beforeRetry = await uploadCount();
        await click('button[aria-label="发送消息"]');
        await wait(
          `document.querySelectorAll('.attachment-chip').length===0 && !!document.querySelector('.message-attachment-link img')`,
        );
        assert.equal(await uploadCount(), beforeRetry);
        assert.equal(await evaluate(`document.querySelector('#conversation-input').value`), '');
        checks.push(
          'failed upload or message keeps text/files; retry reuses the uploaded ID and history renders the image',
        );

        await paste('image-only.png');
        await wait(`document.querySelectorAll('.attachment-chip').length===1`);
        assert.equal(await evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), false);
        await evaluate(
          `document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
        );
        await wait(`document.querySelectorAll('.attachment-chip').length===0`);
        assert.ok(
          await evaluate(
            `window.__fixture.requests.filter(r=>r.path.endsWith('/messages')).at(-1).body.content.includes('请查看所附文件或图片')`,
          ),
        );
        checks.push('attachment-only Enter sends a default prompt and attachment IDs');

        await setText('仅属于对话 A');
        await drop('scope.pdf');
        await wait(`document.querySelectorAll('.attachment-chip').length===1`);
        await evaluate('window.__fixture.holdNextUpload=true');
        const messagesBeforeSwitch = await messageCount();
        await click('button[aria-label="发送消息"]');
        await wait('window.__fixture.waiting===true');
        await evaluate('window.__fixture.select("b")');
        await wait(
          `document.querySelector('#conversation-input').value==='' && document.querySelectorAll('.attachment-chip').length===0`,
        );
        await evaluate('window.__fixture.release()');
        await wait(`!document.querySelector('#conversation-input').disabled`);
        assert.equal(await messageCount(), messagesBeforeSwitch);
        await evaluate('window.__fixture.select("a")');
        await wait(
          `document.querySelector('#conversation-input').value==='仅属于对话 A' && document.querySelectorAll('.attachment-chip').length===1`,
        );
        const scopeUploads = await uploadCount();
        await click('button[aria-label="发送消息"]');
        await wait(`document.querySelectorAll('.attachment-chip').length===0`);
        assert.equal(await uploadCount(), scopeUploads);
        assert.equal(
          await evaluate(`window.__fixture.requests.filter(r=>r.path.endsWith('/messages')).at(-1).path`),
          '/api/conversations/a/messages',
        );
        checks.push(
          'switching conversation mid-upload stops sending, retains original draft and does not cross-send attachments',
        );

        await evaluate('window.__fixture.select()');
        await wait(`document.querySelector('.conversation-toolbar strong').innerText==='新对话'`);
        await setText('新会话失败后可重试');
        await paste('new-chat.png');
        await evaluate('window.__fixture.failNextMessage=true');
        await click('button[aria-label="发送消息"]');
        await wait(`window.__fixture.creates===1 && !document.querySelector('#conversation-input').disabled`);
        assert.equal(await evaluate(`document.querySelector('#conversation-input').value`), '新会话失败后可重试');
        const newUploads = await uploadCount();
        await click('button[aria-label="发送消息"]');
        await wait(
          `document.querySelector('.conversation-toolbar strong').innerText==='Created' && document.querySelectorAll('.attachment-chip').length===0`,
        );
        assert.equal(await evaluate('window.__fixture.creates'), 1);
        assert.equal(await uploadCount(), newUploads);
        checks.push(
          'new conversation is created before upload and retry reuses both conversation and completed upload',
        );

        // Replace only the browser clipboard object, so this test does not alter the user's clipboard.
        await evaluate(
          `Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:async(items)=>{const blob=await items[0].getType('image/png');window.__fixture.copiedImage={type:blob.type,size:blob.size,signature:[...new Uint8Array(await blob.arrayBuffer()).slice(0,8)]};}}});undefined`,
        );
        await click('.message-attachment-link[aria-label="new-chat.png"]');
        await click('button[aria-label="复制图片 new-chat.png"]');
        await wait(
          `!!window.__fixture.copiedImage && document.querySelector('.attachment-copy').innerText.includes('已复制')`,
        );
        assert.deepEqual(await evaluate('window.__fixture.copiedImage.signature'), [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(await evaluate('window.__fixture.copiedImage.type'), 'image/png');
        await evaluate(
          `navigator.clipboard.write=()=>Promise.reject(new DOMException('fixture denied','NotAllowedError'));undefined`,
        );
        await click('button[aria-label="复制图片 new-chat.png"]');
        await wait(`document.querySelector('.attachment-copy')?.title.includes('剪贴板写入权限')`);
        assert.ok(await evaluate(`!!document.querySelector('.image-viewer [download="new-chat.png"]')`));
        await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});undefined`);
        await click('button[aria-label="复制图片 new-chat.png"]');
        await wait(`document.querySelector('.attachment-copy')?.title.includes('不支持复制图片')`);
        checks.push(
          'history copy-image button writes PNG ClipboardItem data; denied/unsupported clipboard gives a clear fallback without changing original downloads',
        );

        await evaluate(
          `(()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);const bytes=Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]),c=>c.charCodeAt(0));window.__fixture.originalJpeg=[...bytes];const originalFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/attachments/')?Promise.resolve(new Response(bytes,{headers:{'Content-Type':'image/jpeg'}})):originalFetch(url,options);window.__fixture.restoreFetch=()=>window.fetch=originalFetch;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:async(items)=>{const blob=await items[0].getType('image/png');window.__fixture.convertedImage={type:blob.type,signature:[...new Uint8Array(await blob.arrayBuffer()).slice(0,8)]};}}});})()`,
        );
        await click('button[aria-label="复制图片 new-chat.png"]');
        await wait(
          `!!window.__fixture.convertedImage && document.querySelector('.attachment-copy').innerText.includes('已复制')`,
        );
        assert.deepEqual(
          await evaluate('window.__fixture.convertedImage.signature'),
          [137, 80, 78, 71, 13, 10, 26, 10],
        );
        assert.deepEqual(await evaluate('window.__fixture.originalJpeg.slice(0,2)'), [255, 216]);
        await evaluate('window.__fixture.restoreFetch();undefined');
        await click('.image-viewer-close');
        checks.push('non-PNG image is converted to a clipboard-only PNG while original JPEG bytes are preserved');

        await evaluate(
          `(()=>{const data=new DataTransfer();data.items.add(new File(['notes'],'picked.md',{type:'text/markdown'}));const input=document.querySelector('input[type=file]');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await paste('desktop-preview.png');
        await wait(
          `document.querySelectorAll('.attachment-chip').length===2 && document.querySelector('.attachment-chip img').complete`,
        );
        await fs.writeFile(path.join(out, 'attachments-dark.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate(`document.documentElement.dataset.theme='light'`);
        await pause(100);
        await fs.writeFile(path.join(out, 'attachments-light.png'), (await window.webContents.capturePage()).toPNG());
        checks.push('native file input accepts documents; draft and history render in light/dark themes');
        assert.deepEqual(errors, []);
        report.passed = true;
      } catch (error) {
        errors.push(error.stack || String(error));
      } finally {
        report.requestSummary = await evaluate(
          `window.__fixture.requests.map(r=>({path:r.path,name:r.body?.name,attachmentIds:r.body?.attachmentIds}))`,
        ).catch(() => []);
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        window?.destroy();
        for (const socket of sockets) socket.destroy();
        server?.close();
        app.exit(report.passed ? 0 : 1);
      }
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}
