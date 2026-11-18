// Hidden renderer with synthetic state and in-memory API responses; never starts the app or a model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-timeline-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationHistory} from './src/ui/Workspace';
import './src/ui/studio.css';
import './src/ui/pinned-messages.css';
document.documentElement.dataset.theme='dark';
const stamp=new Date(Date.now()-120000).toISOString();
const workflow=(id,status='queued')=>({
 id,status,conversationId:'conversation',projectId:'project',userMessageId:'user-'+id,
 input:{content:'Fixture '+id,mode:'build',permissionMode:'read-only',executionPolicy:'cli-first'},
 phase:status==='queued'?'queue':'execute',plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',
 createdAt:stamp,updatedAt:stamp
});
window.makeWorkflow=workflow;
window.makeMessage=(id,workflowId,role='user')=>({
 id,workflowId,role,conversationId:'conversation',content:'Fixture '+id,createdAt:stamp
});
const first={...workflow('first','completed'),finalMessageId:'reply-first'};
window.fixture={
 messages:[window.makeMessage('user-first','first'),window.makeMessage('user-second','second'),window.makeMessage('reply-first','first','assistant')],
 workflows:[first,workflow('second')],
 state:{targets:[],runtimes:[],runs:[],settings:{toolApprovalMode:'auto'}}
};
window.calls=[];window.notices=[];
const root=createRoot(document.getElementById('root'));
window.presentationReads=[];
const api=async(path,body,method)=>{
 // Task cards load their presentations lazily; those reads are not the user's actions.
 if(path.includes('/presentations?')){window.presentationReads.push(path);return {presentations:{}};}
 window.calls.push({path,body,method});
 const match=/^\\/api\\/workflows\\/([^/]+)(?:\\/(cancel))?$/.exec(path);
 if(!match)throw new Error('Unexpected fixture API: '+path);
 const task=window.fixture.workflows.find(item=>item.id===match[1]);
 if(!task)throw new Error('Unknown fixture task');
 if(match[2]==='cancel'){task.status='cancelled';task.error='Fixture: queue task cancelled';task.updatedAt=new Date().toISOString();}
 else if(method==='DELETE')task.deletedAt=new Date().toISOString();
 else throw new Error('Unexpected fixture mutation');
 window.renderFixture();return {...task};
};
window.renderFixture=()=>flushSync(()=>root.render(<ConversationHistory
 messages={[...window.fixture.messages]} workflows={[...window.fixture.workflows]}
 state={{...window.fixture.state,workflows:[...window.fixture.workflows]}}
 pendingMessages={window.fixture.pending ? [{id:"draft",scope:"conversation:conversation",conversationId:"conversation",content:"Sending",images:[],quotes:[],sentAt:new Date().toISOString(),snapshot:{content:"Sending",attachments:[]}}] : []}
 api={api} notify={notice=>window.notices.push(notice)} onInspect={()=>{throw new Error('Unexpected fixture inspection');}}
/>));
window.unmountFixture=()=>flushSync(()=>root.unmount());
window.renderFixture();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },

        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, COMBORUNNER_TIMELINE_SMOKE: fixture };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 30000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-timeline-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_TIMELINE_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-timeline-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const rows = () =>
    evaluate(
      "[...document.querySelector('.message-list').children].filter(row=>!row.classList.contains('message-day')).map(row=>row.dataset.messageId||row.dataset.stageId||row.id||(row.classList.contains('delegation-group-list')?'delegation-group':''))",
    );
  const messageIds = () =>
    evaluate("[...document.querySelectorAll('[data-message-id]')].map(row=>row.dataset.messageId)");
  const update = async (source) => {
    await evaluate(`(()=>{${source};window.renderFixture();})()`);
    await frame();
  };
  const click = async (id, text) => {
    await evaluate(`(()=>{
      const trace=document.getElementById(${JSON.stringify('workflow-' + id)});
      trace.querySelector('details').open=true;
      const button=[...trace.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)});
      if(!button)throw new Error('Missing fixture action');
      button.click();
    })()`);
    await frame();
  };
  void app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        width: 900,
        height: 750,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      await frame();
      const queuedRows = ['user-first', 'user-second', 'workflow-first', 'reply-first'];
      assert.deepEqual(await rows(), queuedRows, 'queued messages keep their saved user text without a task card');
      assert.equal(await evaluate("document.querySelector('#workflow-second')"), null);
      assert.equal(await evaluate('new Set(window.fixture.messages.map(message=>message.createdAt)).size'), 1);
      assert.equal(await evaluate("document.querySelectorAll('.message-day').length"), 1);
      await update(
        `const date=new Date();date.setDate(date.getDate()-1);window.fixture.messages[0].createdAt=date.toISOString();`,
      );
      assert.equal(await evaluate("document.querySelectorAll('.message-day').length"), 2);
      await update(`window.fixture.messages[0].createdAt=window.fixture.messages[1].createdAt;`);

      await update(`const task=window.fixture.workflows.find(item=>item.id==='second');
        task.status='running';task.phase='execute';task.startedAt=new Date(Date.now()-90000).toISOString();
        task.updatedAt=new Date().toISOString();`);
      assert.deepEqual(
        await rows(),
        [...queuedRows, 'workflow-second'],
        'promotion adds its card after saved messages',
      );
      assert.equal(
        await evaluate("document.querySelector('#workflow-second').classList.contains('workflow-running')"),
        true,
      );

      await update(`window.fixture.messages.push({...window.makeMessage('steer-second','second'),
        steering:{runId:'synthetic-run',status:'accepted'}})`);
      assert.deepEqual(await rows(), [
        'user-first',
        'user-second',
        'workflow-first',
        'reply-first',
        'steer-second',
        'workflow-second',
      ]);
      assert.equal(await evaluate("document.querySelectorAll('#workflow-second').length"), 1);
      assert.equal(
        await evaluate("document.querySelector('[data-message-id=steer-second] .steering-status').textContent.trim()"),
        '执行器已接收补充（steer）',
      );

      await update(`const task=window.fixture.workflows.find(item=>item.id==='second');
        task.status='completed';task.input.mode='chat';task.finalMessageId='reply-second';task.updatedAt=new Date().toISOString();
        window.fixture.messages.push(window.makeMessage('reply-second','second','assistant'))`);
      assert.deepEqual(
        await rows(),
        ['user-first', 'user-second', 'workflow-first', 'reply-first', 'steer-second', 'reply-second'],
        'completed plain chat keeps its reply without a task card',
      );
      assert.equal(await evaluate("document.querySelectorAll('#workflow-second').length"), 0);

      await update(`const template=window.fixture.workflows[0];
        window.fixture.workflows.push({...template,id:'third',status:'queued',phase:'queue',
          userMessageId:'user-third',finalMessageId:undefined,startedAt:undefined,
          input:{...template.input,content:'Fixture third',schedule:{deadlineAt:new Date(Date.now()+60000).toISOString()}}});
        window.fixture.messages.push(window.makeMessage('user-third','third'))`);
      const retainedMessages = await messageIds();
      await click('third', '取消');
      assert.equal(
        await evaluate("document.querySelector('#workflow-third').classList.contains('workflow-cancelled')"),
        true,
      );
      assert.deepEqual(await messageIds(), retainedMessages, 'cancellation retains every saved message');
      await click('third', '删除任务');
      assert.equal(await evaluate("document.getElementById('workflow-third')"), null);
      assert.deepEqual(await messageIds(), retainedMessages, 'deletion retains every saved message');
      assert.equal(await evaluate("document.getElementById('workflow-second')"), null);
      assert.deepEqual(await messageIds(), retainedMessages, 'deleting a completed card retains its reply and steer');
      assert.deepEqual(await evaluate('window.calls.map(call=>[call.path,call.method])'), [
        ['/api/workflows/third/cancel', undefined],
        ['/api/workflows/third', 'DELETE'],
      ]);
      assert.deepEqual(await evaluate("window.notices.filter(notice=>notice.tone==='error')"), []);

      await update(`const parent=window.makeWorkflow('parent','running');
        const child=id=>({...window.makeWorkflow(id,'running'),delegation:{parentId:'parent',role:'scout',requestId:id}});
        window.fixture.workflows=[child('beta'),window.makeWorkflow('next'),parent,child('alpha')];
        window.fixture.messages=[window.makeMessage('user-parent','parent'),window.makeMessage('user-alpha','alpha'),
          window.makeMessage('user-next','next'),window.makeMessage('user-beta','beta')];
        window.fixture.pending=true;`);
      assert.deepEqual(
        await rows(),
        ['user-parent', 'user-next', 'pending:draft', 'delegation-group', 'workflow-parent'],
        'child requests share one parent group below pending main messages',
      );
      assert.equal(
        await evaluate("document.querySelector('#workflow-next')"),
        null,
        'the plain queued task stays in the queue panel while its saved user message remains in history',
      );
      assert.equal(
        await evaluate("document.querySelector('.delegation-group').open"),
        false,
        'delegations start folded',
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.delegation-progress-heading > span')].map(node=>node.textContent)",
        ),
        ['正在执行', '正在执行'],
      );
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.delegation-group .workflow-trace')].map(row=>row.id)"),
        ['workflow-alpha', 'workflow-beta'],
        'child presentation follows request order, not workflow response order',
      );

      await update(`window.fixture.pending=false;
        window.fixture.messages.push(window.makeMessage('reply-beta','beta','assistant'),
          {...window.makeMessage('steer-parent','parent'),steering:{runId:'parent-run',status:'accepted'}},
          {...window.makeMessage('steer-alpha','alpha'),steering:{runId:'alpha-run',status:'failed',error:'Fixture delivery failure'}},
          window.makeMessage('reply-alpha','alpha','assistant'));
        for(const id of ['beta','alpha']){const task=window.fixture.workflows.find(item=>item.id===id);
          task.status='completed';task.finalMessageId='reply-'+id;}`);
      assert.deepEqual(
        await rows(),
        ['user-parent', 'user-next', 'steer-parent', 'steer-alpha', 'delegation-group', 'workflow-parent'],
        'parallel child replies never interleave the main queue and steer conversation',
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.delegation-progress-heading > span')].map(node=>node.textContent)",
        ),
        ['已完成', '已完成'],
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[data-message-id=steer-alpha]').classList.contains('conversation-message')",
        ),
        true,
      );
      assert.equal(
        await evaluate("document.querySelector('[data-message-id=steer-alpha] .steering-status').textContent"),
        'Fixture delivery failure',
        'a correction directed at a child keeps visible delivery status',
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.delegation-group')].map(child=>[...child.querySelectorAll('[data-message-id]')].map(message=>message.dataset.messageId))",
        ),
        [
          ['user-alpha', 'reply-alpha'],
          ['user-beta', 'reply-beta'],
        ],
      );

      await update(`const parent=window.fixture.workflows.find(item=>item.id==='parent');
        parent.status='completed';parent.finalMessageId='reply-parent';
        window.fixture.messages.push(window.makeMessage('reply-parent','parent','assistant'));`);
      assert.deepEqual(
        await rows(),
        [
          'user-parent',
          'user-next',
          'steer-parent',
          'steer-alpha',
          'delegation-group',
          'workflow-parent',
          'reply-parent',
        ],
        'finished parent keeps its single child group beside its final response',
      );
      const delegatedMessages = await messageIds();
      await click('alpha', '删除任务');
      assert.equal(await evaluate("document.getElementById('workflow-alpha')"), null);
      assert.deepEqual(
        await messageIds(),
        delegatedMessages,
        'deleting a child card retains its folded request and result',
      );

      await update(`window.fixture.workflows=window.fixture.workflows.filter(item=>item.id!=='parent');
        window.fixture.messages=window.fixture.messages.filter(item=>!['user-parent','user-alpha','user-beta'].includes(item.id));`);
      assert.equal(await evaluate("document.querySelectorAll('.delegation-group-list').length"), 1);
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.delegation-group [data-message-id]')].map(message=>message.dataset.messageId)",
        ),
        ['reply-alpha', 'reply-beta'],
        'partial history keeps child results when parent metadata and child origins are absent',
      );
      assert.deepEqual(await rows(), ['user-next', 'delegation-group', 'steer-parent', 'steer-alpha', 'reply-parent']);
      await update(`window.timeAt=s=>new Date(Date.now()-100000+s*1000).toISOString();
        const m=(id,task,second,role='user')=>({...window.makeMessage(id,task,role),createdAt:window.timeAt(second)});
        const child=(id,n)=>({...window.makeWorkflow(id,'running'),createdAt:window.timeAt(n),runIds:['run-'+id],
          delegation:{parentId:'parent',role:n===1?'worker':'reviewer',requestId:id,
          checkpoints:[{at:window.timeAt(7),progress:'已核对三处记录',next:'继续核对剩余项目'}]}});
        window.fixture.workflows=[{...window.makeWorkflow('parent','running'),runIds:['run-parent']},child('alpha',1),child('beta',2)];
        window.fixture.messages=[m('user-parent','parent',0),m('user-alpha','alpha',1),m('user-beta','beta',2),
          {...m('queued-correction','cancelled-queue',3),content:'请先核对目录，不要开始移动。',
          steering:{runId:'run-parent',status:'accepted',acceptedAt:window.timeAt(5)}},m('interim-parent','parent',4,'assistant')];
        const r=id=>({id:'run-'+id,workflowId:id,prompt:'Synthetic request',projectPath:'',kind:'routine',status:'running',
          route:{runtimeId:'codex',model:'requested',effort:'high',kind:'routine',reasons:[],warnings:[]},
          effectiveModel:{model:'confirmed-sol',effort:'medium',source:'native'},account:{id:'codex-b',label:'Codex B',provider:'codex'},
          startedAt:window.timeAt(0),reasoning:'PRIVATE_CHILD_REASONING',output:'STALE_BEFORE_RECEIPT',events:[]});
        window.fixture.state.runs=[r('beta'),r('parent'),r('alpha')];
        window.fixture.state.runs.find(r=>r.workflowId==='alpha').events=[{type:'text',at:window.timeAt(7),text:'已收到新范围，只检查指定目录。'},
          {type:'tool',at:window.timeAt(7),data:{tool:'list_files',arguments:{secret:'HIDDEN_TOOL_ARGS'}}}];`);
      assert.deepEqual(await rows(), [
        'user-parent',
        'delegation-group',
        'queued-correction',
        'interim-parent',
        'steer:queued-correction',
        'delegation-group',
        'workflow-parent',
      ]);
      assert.equal(await evaluate("document.querySelector('.steering-stage').textContent.includes('阶段 2')"), true);
      assert.equal(
        await evaluate("[...document.querySelectorAll('.delegation-group')].every(group=>!group.open)"),
        true,
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.delegation-group-list')].at(-1).querySelectorAll('[data-child-sequence]').length",
        ),
        2,
      );
      assert.deepEqual(
        await evaluate(
          "[...[...document.querySelectorAll('.delegation-group-list')].at(-1).querySelectorAll('[data-child-sequence]')].map(node=>[node.dataset.childId,node.dataset.childSequence])",
        ),
        [
          ['alpha', '1'],
          ['beta', '2'],
        ],
      );
      assert.equal(
        await evaluate(
          "document.body.textContent.includes('PRIVATE_CHILD_REASONING') || document.body.textContent.includes('HIDDEN_TOOL_ARGS') || document.body.textContent.includes('STALE_BEFORE_RECEIPT')",
        ),
        false,
      );
      assert.equal(
        await evaluate(
          "document.body.textContent.includes('confirmed-sol') && document.body.textContent.includes('medium') && document.body.textContent.includes('已收到新范围，只检查指定目录。')",
        ),
        true,
      );
      await evaluate(
        "window.liveAlpha=[...document.querySelectorAll('[data-child-id=alpha]')].at(-1); document.querySelectorAll('.delegation-group').forEach(group=>group.open=true)",
      );
      await update(`const beta=window.fixture.workflows.find(task=>task.id==='beta');beta.status='completed';beta.updatedAt=window.timeAt(9);
        window.fixture.messages.push({...window.makeMessage('reply-beta','beta','assistant'),createdAt:window.timeAt(9),content:'第二项已核对，无需修改。'});`);
      assert.equal(
        await evaluate("window.liveAlpha===[...document.querySelectorAll('[data-child-id=alpha]')].at(-1)"),
        true,
        'another child finishing does not remount the running child',
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.delegation-group-list')[1].querySelector('[data-message-id=reply-beta]')!==null",
        ),
        true,
      );
      await update(
        `const alpha=window.fixture.workflows.find(task=>task.id==='alpha');alpha.status='completed';alpha.updatedAt=window.timeAt(10);`,
      );
      assert.equal(
        await evaluate("window.liveAlpha===[...document.querySelectorAll('[data-child-id=alpha]')].at(-1)"),
        true,
        'terminal state arriving before its reply does not jump back into the old phase',
      );
      await update(
        `window.fixture.messages.push({...window.makeMessage('reply-alpha','alpha','assistant'),createdAt:window.timeAt(11),content:'第一项核对完毕，尚未移动。'});`,
      );
      assert.deepEqual(
        await evaluate(
          "[...[...document.querySelectorAll('.delegation-group-list')].at(-1).querySelectorAll('[data-child-sequence]')].map(node=>[node.dataset.childId,node.dataset.childSequence])",
        ),
        [
          ['alpha', '1'],
          ['beta', '2'],
        ],
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.message-list > .conversation-message')].map(node=>node.dataset.messageId)",
        ),
        ['user-parent', 'queued-correction', 'interim-parent'],
      );
      assert.equal(
        await evaluate("[...document.querySelectorAll('.delegation-execution-details')].every(node=>!node.open)"),
        true,
        'execution detail stays collapsed by default',
      );
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.delegation-task-progress')).display"),
        'grid',
        'progress summary retains its own layout without colliding with older status classes',
      );
      if (process.env.COMBORUNNER_TIMELINE_SCREENSHOT) {
        await update(`window.fixture.messages.find(m=>m.id==='user-parent').content='请核对这个项目的重复文件，并检查之前的整理结果。';
          window.fixture.messages.find(m=>m.id==='user-alpha').content='核对文件目录与重复记录';
          window.fixture.messages.find(m=>m.id==='user-beta').content='独立审查已经整理的文件';
          window.fixture.messages.find(m=>m.id==='interim-parent').content='两个子任务已开始核对，新的范围将在收到补充后应用。';
          window.fixture.workflows.find(w=>w.id==='alpha').input.content='核对文件目录与重复记录';
          window.fixture.workflows.find(w=>w.id==='beta').input.content='独立审查已经整理的文件';`);
        const width = Number(process.env.COMBORUNNER_TIMELINE_WIDTH || 900);
        assert.ok(width >= 400 && width <= 1600);
        win.setSize(width, 1200);
        await frame();
        await evaluate(
          "document.querySelector('.delegation-group').open=false; [...document.querySelectorAll('.delegation-group')].at(-1).open=true",
        );
        await frame();
        assert.equal(await evaluate("[...document.querySelectorAll('.delegation-group')].at(-1).open"), true);
        assert.equal(
          await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
          true,
          'wide and narrow summaries do not force horizontal scrolling',
        );
        await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
        const snapshot = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Fixture screenshot timed out')), 5000);
          let frames = 0;
          const paint = (_event, _dirtyRect, image) => {
            if (++frames < 2) {
              win.webContents.invalidate();
              return;
            }
            clearTimeout(timeout);
            win.webContents.off('paint', paint);
            resolve(image.toPNG());
          };
          win.webContents.on('paint', paint);
          win.webContents.invalidate();
        });
        await fs.writeFile(process.env.COMBORUNNER_TIMELINE_SCREENSHOT, snapshot);
      }
      await evaluate('window.unmountFixture()');
      console.log(
        'PASS timeline renderer: queue placement, accepted receipt stages, stable child numbering, public progress and model metadata, late results, pending send, partial history, cancel/delete retaining messages',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
