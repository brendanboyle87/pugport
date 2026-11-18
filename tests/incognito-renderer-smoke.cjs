// Real Studio and CSS in hidden Electron; all HTTP/SSE data is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pugport-incognito-ui-'));
    await fs.mkdir(path.join(directory, 'profile'));
    await fs.writeFile(
      path.join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await require('esbuild').build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Studio from './src/ui/Studio';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import './src/ui/studio.css';
import './src/ui/ConversationPanel.css';
import './src/ui/ConversationQueue.css';
import './src/ui/ConversationFolders.css';
import './src/ui/composer.css';
const at='2026-10-14T12:00:00Z';
const project={id:'p',name:'Synthetic',path:'C:/Synthetic',scope:'chat',createdAt:at,updatedAt:at};
const workProject={...project,id:'work',name:'Synthetic project',scope:'project',path:'C:/Synthetic/work'};
const ordinary={id:'ordinary',projectId:'p',title:'普通对话',createdAt:at,updatedAt:at};
localStorage.setItem('agent-studio-conversation',ordinary.id);
localStorage.setItem('agent-studio-project',project.id);
localStorage.setItem('agent-studio-theme','light');
window.fixture={calls:[],deleted:[],quit:null,state:{app:{name:'PugPort',version:'fixture',platform:'win32'},settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',unknownQuotaPolicy:'manual-only',maxConcurrentRuns:1},targets:[],runtimes:[],runs:[],approvals:[],plugins:[],projects:[project,workProject],conversations:[ordinary],workflows:[],conversationMessages:[],backgroundTasks:[],tasteTests:[],conversationFolders:[]}};
const f=window.fixture;
window.comboRunnerDesktop={pickDirectory:async()=>null,onConfirmation:handler=>{f.quit=handler;return()=>{f.quit=null}}};
window.EventSource=class{constructor(){f.events=this;this.listeners={}}addEventListener(name,handler){this.listeners[name]=handler}close(){}};
const emit=()=>f.events?.listeners.state?.({data:JSON.stringify(f.state)});
window.fetch=async(url,init={})=>{
 const method=init.method||'GET',body=init.body?JSON.parse(init.body):{};
 f.calls.push({url,method,body});
 if(url==='/api/modes'){
  if(method!=='GET')throw Error('Mode catalog must use GET');
  return new Response(JSON.stringify({catalog:[],installed:[]}),{status:200,headers:{'Content-Type':'application/json'}});
 }
 let answer={};
 if(url==='/api/app-info')answer={paths:{dataDir:'C:/Synthetic/data',memoryDir:'C:/Synthetic/memory'},tools:{ripgrep:false,markitdown:false,everything:'missing',voice:false}};
 else if(url==='/api/devices')answer={devices:[{id:'synthetic-node',name:'Synthetic Node',online:true}],slackHost:null};
 else if(url==='/api/session')answer={token:'synthetic'};
 else if(url==='/api/state')answer=f.state;
 else if(String(url).split('?')[0]==='/api/extensions')answer={items:[{id:'synthetic-skill',kind:'skill',name:'Synthetic skill',description:'Fixture',enabled:true}]};
 else if(url==='/api/projects/p/memory')answer={projectId:'p',content:'',revision:0,recentWork:[]};
 else if(url==='/api/projects/p/local-memory')answer={exportEnabled:true,cliEnabled:false,files:[],warnings:[],legacyFiles:[]};
 else if(url==='/api/conversations'&&method==='POST'){
   answer={...ordinary,id:crypto.randomUUID(),title:body.incognito?'隐身对话':'新对话',...(body.incognito?{incognito:true,memory:'off'}:{})};
   f.state.conversations.push(answer);queueMicrotask(emit);
 } else {
   const id=String(url).split('/')[3],conversation=f.state.conversations.find(item=>item.id===id);
   if(String(url).endsWith('/close-incognito')||method==='DELETE'){
     f.deleted.push(id);f.state.conversations=f.state.conversations.filter(item=>item.id!==id);answer={deleted:!f.failDelete};queueMicrotask(emit);
   } else if(String(url).endsWith('/memory')&&method==='PATCH'){
     if(body.off)conversation.memory='off';else delete conversation.memory;answer=conversation;queueMicrotask(emit);
   } else if(String(url).endsWith('/swarm'))answer={workflows:[],messages:[]};
   else if(conversation)answer={conversation,messages:[],workflows:[],runs:[]};
 }
 return new Response(JSON.stringify(answer),{status:200,headers:{'Content-Type':'application/json'}});
};
createRoot(document.getElementById('root')).render(<><Studio/><ConfirmDialogHost/></>);
`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl' },
      outfile: path.join(directory, 'fixture.js'),
    });
    const env = { ...process.env, PUGPORT_INCOGNITO_UI: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const directory = process.env.PUGPORT_INCOGNITO_UI;
  app.setPath('userData', path.join(directory, 'profile'));
  app.disableHardwareAcceleration();
  let window;
  let checks = 0;
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      console.error('SCRIPT: ' + source);
      throw error;
    });
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await frame();
  };
  const textClick = async (text) => {
    await evaluate(
      `[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)}).click()`,
    );
    await frame();
  };
  const check = async (source, expected) => {
    assert.deepEqual(await evaluate(source), expected);
    checks++;
  };
  const screenshot = async (name) => {
    const file = path.join(directory, name + '.png');
    await fs.writeFile(file, (await window.webContents.capturePage()).toPNG());
    console.log('SCREENSHOT ' + file);
  };
  void app.whenReady().then(async () => {
    try {
      window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 850,
        webPreferences: { backgroundThrottling: false },
      });
      await window.loadFile(path.join(directory, 'index.html'));
      await frame();
      await click('[aria-label="新建隐身对话"]');
      await check("document.querySelector('.conversation-title-line strong').textContent", '隐身对话');
      await check("document.querySelectorAll('.incognito-label').length", 2);
      await check("Boolean(document.querySelector('[aria-label=新侧聊]'))", false);
      await click('[aria-label="对话设置"]');
      for (let round = 0; round < 3; round++) {
        for (const tab of ['路由规则', '记忆', 'Skills', '路由规则']) {
          await textClick(tab);
          await check(
            "document.querySelector('.conversation-panel [role=tab][aria-selected=true]').textContent.trim()",
            tab,
          );
          await check("Boolean(document.querySelector('.conversation-panel .routing-tab'))", tab === '路由规则');
          await check("Boolean(document.querySelector('.conversation-panel .skills-tab'))", tab === 'Skills');
          await check("document.querySelector('.conversation-panel').textContent.includes('对话记忆')", tab === '记忆');
          await check(
            "document.querySelector('.conversation-panel').textContent.includes('使用全局设置')",
            tab === '路由规则',
          );
        }
      }
      await textClick('记忆');
      await check("document.querySelector('.conversation-panel input[type=checkbox]').disabled", true);
      await screenshot('incognito-light');
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))");
      await frame();
      await evaluate(
        "[...document.querySelectorAll('button')].find(item=>item.textContent.includes('切换主题')).click()",
      );
      await frame();
      await check("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()", '#1a1b1f');
      await screenshot('incognito-dark');
      window.setSize(420, 850);
      await frame();
      await check('document.documentElement.scrollWidth<=window.innerWidth', true);
      await screenshot('incognito-narrow');
      window.setSize(1280, 850);
      await frame();
      await click('[aria-label="关闭对话设置"]');
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true}))");
      await frame();
      await check("Boolean(document.querySelector('dialog'))", false);
      await check('window.fixture.deleted.length', 0);
      await check(
        "Boolean(document.querySelector('.settings-page'))||document.body.textContent.includes('设置')",
        true,
      );
      await click('.conversation-link[title^="隐身对话"]');
      await check("document.querySelector('.conversation-title-line strong').textContent", '隐身对话');
      await evaluate(
        "(()=>{const box=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,'/side');box.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
      await frame();
      await check("Boolean(document.querySelector('.composer-command-menu button'))", false);
      await evaluate(
        "(()=>{const box=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,'@@');box.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
      await frame();
      await check("document.body.textContent.includes('Synthetic Node')", false);
      await check("window.fixture.calls.filter(item=>item.url==='/api/devices').length", 0);
      await evaluate(
        "(()=>{const box=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,'');box.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
      await frame();
      await click('.project-name');
      await check('window.fixture.deleted.length', 0);
      await check("document.querySelector('dialog').textContent.includes('离开后这个隐身对话会被永久删除')", true);
      await textClick('取消');
      await check("document.querySelector('.conversation-title-line strong').textContent", '隐身对话');
      await check('window.fixture.deleted.length', 0);
      await textClick('普通对话');
      await check("document.querySelector('dialog').textContent.includes('离开后这个隐身对话会被永久删除')", true);
      await textClick('取消');
      await check('window.fixture.deleted.length', 0);
      await textClick('普通对话');
      await textClick('离开并删除');
      await check('window.fixture.deleted.length', 1);
      await check("document.querySelector('.conversation-title-line strong').textContent", '普通对话');
      await click('[aria-label="对话设置"]');
      await textClick('记忆');
      await click('.conversation-panel input[type=checkbox]');
      await check("window.fixture.state.conversations.find(item=>item.id==='ordinary').memory", 'off');
      await click('.conversation-panel input[type=checkbox]');
      await check("window.fixture.state.conversations.find(item=>item.id==='ordinary').memory", undefined);
      await click('[aria-label="关闭对话设置"]');
      await evaluate(
        "(()=>{const box=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,'/side');box.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
      await frame();
      await check("Boolean(document.querySelector('.composer-command-menu button'))", true);
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))");
      await frame();
      await check(
        "[...document.querySelectorAll('button')].some(item=>item.textContent.includes('新建隐身对话'))",
        true,
      );
      await evaluate(
        "[...document.querySelectorAll('button')].find(item=>item.textContent.includes('新建隐身对话')).click()",
      );
      await frame();
      await check("document.querySelector('.conversation-title-line strong').textContent", '隐身对话');
      await textClick('普通对话');
      await textClick('离开并删除');
      await evaluate(
        "window.dispatchEvent(new KeyboardEvent('keydown',{key:'N',ctrlKey:true,shiftKey:true,bubbles:true}))",
      );
      await frame();
      await check("document.querySelector('.conversation-title-line strong').textContent", '隐身对话');
      await evaluate(
        "window.fixture.quit({title:'退出 PugPort？',summary:'离开后这个隐身对话会被永久删除',action:'退出 PugPort',incognito:window.fixture.state.conversations.filter(item=>item.incognito).map(item=>item.id)}).then(result=>window.fixture.quitResult=result);void 0",
      );
      await frame();
      await textClick('退出 PugPort');
      await check('window.fixture.quitResult', true);
      await check('window.fixture.deleted.length', 3);
      await click('[aria-label="新建隐身对话"]');
      await click('[aria-label="对话 隐身对话 的更多操作"]');
      await textClick('删除');
      await check("document.querySelector('[role=alertdialog]').textContent.includes('永久删除，不能撤销')", true);
      await screenshot('incognito-delete');
      await textClick('删除');
      await check('window.fixture.deleted.length', 4);
      await check("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='撤销')", false);
      await click('[aria-label="新建隐身对话"]');
      await evaluate('window.fixture.failDelete=true');
      await click('[aria-label="对话 隐身对话 的更多操作"]');
      await textClick('删除');
      await textClick('删除');
      await check("document.querySelector('.notice').textContent.includes('隐身对话已关闭。')", true);
      await check("[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='撤销')", false);

      console.log(
        `PASS incognito renderer: ${checks} checks, 0 failures; synthetic API, light/dark/narrow screenshots: ${directory}`,
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      console.log(
        await evaluate('JSON.stringify({text:document.body.textContent,calls:window.fixture.calls.slice(-10)})'),
      );
      await screenshot('failure');
      app.exit(1);
    }
  });
}
