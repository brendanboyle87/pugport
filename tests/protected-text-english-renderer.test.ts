import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';
import { buildSpendOverview } from '../src/server/spend-ledger.ts';
import { insightFixture, insightNow } from './helpers/usage-insights-fixture.ts';

// Real components in hidden offscreen Electron, English UI, synthetic data and no backend.
test(
  'Electron: placeholders beside protected text translate in English while user and agent text stays as written',
  { timeout: 90000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-protected-en-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-protected-en-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = resolve(process.env.ROUTING_FLOW_ARTIFACTS ?? 'reports/protected-text-english');
    await mkdir(screenshots, { recursive: true });
    // The Spend page's ledger parts with no runs; the fixture fills in the names under test.
    const emptySpend = buildSpendOverview({
      report: insightFixture({ range: '7d', kind: 'all' }, true).report,
      accounts: new Map(),
      workflows: [],
      projects: [],
      now: insightNow,
    });
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {TrajectoryPanel, TrajectoryDetailDialog} from './src/ui/Trajectory';
import {ExternalReplyPanel} from './src/ui/ExternalAgents';
import {ConversationQueue} from './src/ui/ConversationQueue';
import {QueueItem} from './src/ui/TaskQueue';
import {DelegationProgress} from './src/ui/DelegationProgress';
import {SideChatHistory} from './src/ui/SideChatHistory';
import {ConfirmDialog, ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {NoticeToast} from './src/ui/Studio';
import {WorkflowTrace, SystemNoticeView, ConversationHistory} from './src/ui/Workspace';
import {ConversationTrace} from './src/ui/ConversationTrace';
import {meteringContract} from './src/shared/context-trace';
import {StepReport} from './src/ui/ClaimsCheck';
import {DevicesCard} from './src/ui/Devices';
import {SlackGateway} from './src/ui/SlackGateway';
import {ExtensionChoice, InstalledRow} from './src/ui/Extensions';
import {CardName} from './src/ui/CardName';
import {ChatFolders} from './src/ui/ConversationFolders';
import {QuotaCard, TargetEditor} from './src/ui/App';
import {CompactQuotaCard, ApiQuotaCard, ExpiryChip, compactResetLabel} from './src/ui/UsageQuota';
import {resetCardSuggestion} from './src/ui/ResetCreditsSummary';
import {BackgroundTasks} from './src/ui/BackgroundTasks';
import {ExecutorChecklist} from './src/ui/ExecutorChecklist';
import {ScheduledTasks} from './src/ui/ScheduledTasks';
import {TasteTestCard, WritingPreferences} from './src/ui/TasteTest';
import {MentionMenu} from './src/ui/Mentions';
import {ImageViewer} from './src/ui/ImageViewer';
import {ConnectorsPage} from './src/ui/Connectors';
import {QuoteEditor, QuoteChips} from './src/ui/Quotes';
import {PinnedMessages} from './src/ui/PinnedMessages';
import {SwarmWorkspaceView, swarmMembers, swarmPlan, swarmChatLines, savedTimeText} from './src/ui/SwarmWorkspace';
import {UsageSpend} from './src/ui/UsageSpend';
import {insightFixture} from './tests/helpers/usage-insights-fixture';
import {FolderMoveDialog} from './src/ui/ConversationFolders';
import {webQuotaLabel} from './src/shared/external-agents';
import {startInterfaceLanguage, shownTitle} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
import './src/ui/ConversationQueue.css';
import './src/ui/ConversationTrace.css';
import './src/ui/composer.css';
import './src/ui/ExternalAgents.css';
import './src/ui/SideChatPanel.css';
import './src/ui/settings.css';
import './src/ui/Devices.css';
import './src/ui/SlackGateway.css';
import './src/ui/ConversationFolders.css';
import './src/ui/ExecutorChecklist.css';
import './src/ui/TasteTest.css';
import './src/ui/Connectors.css';
import './src/ui/SwarmWorkspace.css';
import './src/ui/pinned-messages.css';
const locale=new URLSearchParams(location.search).get('locale')||'en';
localStorage.setItem('comborunner.locale',locale);
window.errors=[];
window.addEventListener('error',event=>window.errors.push(event.message));
window.fetch=()=>{throw Error('Unexpected real fetch');};
const stamp='2026-10-19T14:00:00Z';
const at=seconds=>new Date(Date.parse(stamp)+seconds*1000).toISOString();
const route={runtimeId:'fixture',model:'gpt-5.5',effort:'medium',kind:'routine',reasons:[],warnings:[]};
// A long recorded reply (cut after 300 characters), a PugPort stage that reported no stage ID and one with no name.
// The run went through an unknown provider on an account the user named 设置 ("Settings").
const traced={id:'traced',prompt:'Internal instructions',projectPath:'C:/Fixture',kind:'routine',status:'completed',route,startedAt:stamp,endedAt:at(9),output:'Done.',events:[
 {at:at(0),type:'status',text:'Routing',data:{source:'pugport',kind:'routing',detail:{provider:'mystery',executor:'设置'}}},
 {at:at(1),type:'text',text:'继续整理。'.repeat(80)},
 {at:at(2),type:'tool',data:{source:'pugport',tool:'find_files',toolCallId:'bridge-a',status:'started',arguments:{query:'plan'}}},
 {at:at(3),type:'status',text:'Validate scope',data:{source:'pugport',kind:'internal-step',parentToolCallId:'bridge-a',status:'completed'}},
 {at:at(3.5),type:'status',data:{source:'pugport',kind:'internal-step',parentToolCallId:'bridge-a',status:'completed'}},
 {at:at(4),type:'tool',data:{source:'pugport',toolCallId:'bridge-a',status:'completed',result:{count:3}}},
 // Native status rows: on PugPort's default account (Codex · 本机, "Codex · Local"), on an account named Work · 设置
 // (piece by piece that would read "Work · Settings"), and the executor start, which takes the recorded route's executor.
 {at:at(5),type:'status',text:'Codex process started',data:{source:'native',kind:'process-start',detail:{provider:'codex',executor:'Codex · 本机'}}},
 {at:at(6),type:'status',text:'Permission fields',data:{source:'native',kind:'permission-config',detail:{provider:'claude',executor:'Work · 设置'}}},
 {at:at(7),type:'status',text:'Launching the executor',data:{}},
]};
// Everything else the user named 设置 as well: the project, a device, the device running Slack and a found skill.
const project={id:'project',name:'设置',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp};
const conversation={id:'chat',projectId:'project',title:'Spring launch',createdAt:stamp,updatedAt:stamp};
// The user's queued message equals an interface string ("继续" is "Continue").
const queued={id:'queued',status:'queued',conversationId:'chat',projectId:'project',userMessageId:'message-queued',
 input:{content:'继续',mode:'build',permissionMode:'workspace-write',executionPolicy:'cli-first'},
 phase:'queue',plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp};
// A running task's elapsed time and deadline.
const running={...queued,id:'running',status:'running',phase:'execute',startedAt:stamp,
 input:{...queued.input,content:'Running fixture',schedule:{deadlineAt:at(86400)}}};
// Subtasks: what agents wrote equals interface strings (完成 is "Done", 继续 "Continue", 设置 "Settings");
// PugPort's own error and file-check summary are interface text.
const childRun=(id,fields)=>({id:id+'-run',workflowId:id,prompt:'',projectPath:'C:/Fixture',kind:'routine',status:'failed',route,startedAt:at(1),endedAt:at(5),output:'',events:[],...fields});
const subtask=(id,delegation)=>({...queued,id,status:'running',phase:'execute',runIds:[id+'-run'],delegation:{parentId:'parent',role:'worker',requestId:id,...delegation}});
const child=subtask('child',{checkpoints:[{at:at(3),progress:'完成',next:'继续',blocker:'设置'}]});
const pugportChild=subtask('pugport-child');
const outputChild=subtask('output-child');
const shortChild=subtask('short-child',{checkpoints:[{at:at(3),progress:'完成'}]});
// A relay from PugPort's default account to one the user named 设置.
const relayChild={...subtask('relay-child'),runIds:['relay-child-prior','relay-child-run']};
// Subtasks on API sources: PugPort's own second Qwen source (通义千问 2) and one the user named 通义千问 · 公司号.
const qwenChild=subtask('qwen-child');
const namedQwenChild=subtask('named-qwen-child');
const runs=[
 childRun('child',{route:{...route,reasons:['设置 周额度后天重置，还剩 60%，按平时用量会剩约 40% 用不掉，先用它','续接本对话的原生会话，留在 设置；快浪费的额度留给新任务','赠金落后 $80，新任务换卡：这条后续消息不续接原会话，换到 设置，带上下文继续']},taskOutcome:{status:'partial',source:'executor-report',summary:'完成'}}),
 childRun('pugport-child',{error:'验收命令未经桌面批准，已跳过',taskOutcome:{status:'completed',source:'file-receipts',summary:'PugPort 执行的验收命令已通过，已确认请求的文件结果（可能无需改动）。'}}),
 childRun('output-child',{output:'完成'}),
 {...childRun('relay-child',{account:{id:'local',label:'Codex · 本机',provider:'codex'}}),id:'relay-child-prior'},
 childRun('relay-child',{account:{id:'named',label:'设置',provider:'codex'},relay:{fromRunId:'relay-child-prior',fromRuntimeId:'codex-native',reason:'quota'}}),
 childRun('qwen-child',{route:{...route,runtimeId:'api-qwen'}}),
 childRun('named-qwen-child',{route:{...route,runtimeId:'api-qwen-named'}}),
];
const apiTarget=(id,label)=>({id,label,provider:'pi',command:'',environment:'native',enabled:true});
const state={app:{version:'test'},projects:[project],conversations:[conversation],workflows:[queued,running,child],runs,
 conversationMessages:[{id:'message-queued',conversationId:'chat',role:'user',content:'继续',createdAt:stamp}],
 runtimes:[],targets:[apiTarget('named','设置'),apiTarget('api-qwen','通义千问 2'),apiTarget('api-qwen-named','通义千问 · 公司号')],approvals:[],plugins:[],settings:{toolApprovalMode:'auto'}};
const applied={id:'external',conversationId:'chat',role:'assistant',content:'…',createdAt:stamp,externalAgent:{
 agentId:'codex-cloud',name:'Codex 云端',status:'done',request:'改问候语',updatedAt:stamp,
 task:{id:'task_e_1',state:'ready',projectPath:'D:/repo',diff:'继续'}}};
const api=async()=>({});
const devicesApi=async()=>({slackHost:null,devices:[{id:'device',name:'设置',address:'100.64.0.1',pairedAt:stamp,online:true,platform:'linux',executors:[]}]});
const slackApi=async(path)=>path==='/api/slack/admission'?{version:1,rules:[]}:path==='/api/devices'?{slackHost:'device',devices:[{id:'device',name:'设置',online:true}]}:{enabled:true,status:'off',users:[{id:'U1',name:'设置',pairedAt:stamp}],activeTasks:0,hostedBy:'设置'};
// A found skill, and a tool connection named like one already installed.
const found={token:'preview',drafts:[{key:'skill',kind:'skill',name:'设置',description:'Synthetic skill',origin:'GitHub synthetic/skills'},
 {key:'tool',kind:'mcp',name:'设置',description:'Synthetic tool',origin:'Claude Desktop',existingId:'tool'}],selected:new Set(['skill','tool']),fills:{},options:{}};
// Names inside attributes and next to interface text: an account, a category, an installed tool, a routine, a Slack
// user, an image, a taste-test writer and @@ names called 设置 ("Settings"), beside PugPort's own default names.
const now=Date.parse(stamp)+1000;
const named={id:'named',label:'设置',provider:'codex',command:'codex',environment:'native',enabled:true};
const local={id:'codex-native',label:'Codex · 本机',provider:'codex',command:'codex',environment:'native',enabled:true};
const snapshot=target=>({id:target.id,label:target.label,provider:'codex',environment:'native',installed:true,status:'ready',models:[],
 quota:{status:'known',source:'fixture',observedAt:stamp,windows:[{id:'five',label:'Codex · primary',usedPercent:40,resetsAt:at(3600),durationMinutes:300}]}});
const qwen={targetId:'api-qwen',preset:'qwen',label:'通义千问 2',enabled:true,console:'fixture',currency:'USD',budget:{policy:{limitUsd:200,
 expiresAt:at(518400),startedAt:at(-86400),perRunUsd:1,maxConcurrentRuns:2,burstConcurrentRuns:2,preferExpiring:true},
 spentUsd:20,remainingUsd:180,reservedUsd:0,unreportedRuns:0,phase:'priority',maxConcurrentRuns:2}};
const tool={kind:'mcp',id:'tool',name:'设置',description:'Synthetic tool',transport:'stdio',command:'fixture',args:[],source:'fixture',enabled:true,env:{},headers:{}};
const worker=(workerId,accountLabel,status,fields)=>({workerId,accountLabel,direction:'back',status,checked:12,startedAt:stamp,updatedAt:stamp,elapsedSeconds:5,...fields});
const background={id:'background',conversationId:'chat',title:'Synthetic check',detail:'',done:1,total:3,startedAt:stamp,
 assistance:{maxWorkers:2,baseWorkers:2,maxFrameReaders:1,workers:[worker('w1','设置','running',{model:'gpt-5.5',effort:'high'}),worker('w2','Codex · 本机','waiting')]}};
const routinesApi=async path=>path==='/api/scheduled-tasks'?[{id:'routine',name:'设置',prompt:'Synthetic',schedule:{type:'daily',time:'09:00'},
 permissionMode:'read-only',enabled:false,createdAt:stamp,nextRunAt:at(3600),history:[]}]:{};
// The writers' passages (继续 is "Continue") and the reason the user gave stay as written too.
const writer=(key,label)=>({key,provider:'codex',runtimeId:'named',model:'gpt-5.5',label,status:'done',text:'继续'});
const chosenTest={id:'taste',projectId:'project',conversationId:'chat',topic:'prose',brief:'Synthetic brief',status:'chosen',chosen:'A',verdict:'good',
 createdAt:stamp,updatedAt:stamp,candidates:[writer('A','设置 · gpt-5.5 · high'),writer('B','Codex · 本机 · gpt-5.5 · medium')]};
const readyTest={...chosenTest,id:'taste-ready',status:'ready',chosen:undefined,verdict:undefined};
const novel={...project,writingPreferences:[{topic:'prose',provider:'codex',model:'gpt-5.5',effort:'high',label:'设置 · gpt-5.5 · high',reason:'继续',chosenAt:stamp,testId:'taste',tested:[]}]};
const writingApi=async path=>path.includes('manuscript-candidates')?[]:{};
// @@ names: PugPort's free chain, a built-in role and an outside agent translate; what people named does not.
const mentions=[{kind:'executor',id:'named',name:'设置'},{kind:'executor',id:'free-chain',name:'免费'},{kind:'role',id:'investigation',name:'只读调查'},
 {kind:'role',id:'my-role',name:'设置'},{kind:'external',id:'muse',name:'Muse'},{kind:'device',id:'device:device',name:'设置'}];
const pixel='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// What people and agents wrote beside interface text: a connected account called 设置 (and its owner's name), a quote
// and its note, a pinned message, an image search described as 设置, swarm members (a custom role, a device, PugPort's
// own names), usage rows and categories named 设置.
const connectorProvider=(provider,configured)=>({provider,configured,clientId:'',hasClientSecret:configured,tenant:'',redirectUri:''});
let reauthorized=false;
const connectorsApi=async path=>{
 if(path==='/api/connectors/connect'){reauthorized=true;return {authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture',expiresAt:'2099-01-01T00:00:00Z'};}
 return {providers:[connectorProvider('google',true),connectorProvider('microsoft',false)],accounts:[{id:'account',provider:'google',alias:'设置',email:'',
  displayName:'设置',capabilities:['mail_read'],status:'connected',enabled:true,connectedAt:stamp,updatedAt:stamp,authorizationRevision:reauthorized?'two':'one'}]};
};
const search={id:'search',conversationId:'chat',title:'后台找图：设置',detail:'准备中',done:0,total:0,startedAt:stamp,state:'running'};
const swarmTask=(id,fields)=>({...queued,id,status:'running',phase:'execute',input:{...queued.input,content:'设置'},...fields});
const delegated=(id,agent,fields)=>swarmTask(id,{delegation:{parentId:'swarm-root',role:'worker',requestId:id,...(agent?{agent}:{})},...fields});
// The coordinator's list names who it means to give each item to, as written in the participant list.
const swarmTasks=[swarmTask('swarm-root',{taskList:{updatedAt:stamp,items:[{id:'auto-item',title:'设置',kind:'read',assignee:'自动选择'},
 {id:'named-item',title:'设置',kind:'read',assignee:'设置'}]}}),delegated('custom',undefined,{agentPreset:{id:'my-role',name:'设置'}}),
 delegated('builtin',undefined,{agentPreset:{id:'investigation',name:'只读调查'}}),delegated('device',{label:'设备「设置」',deviceId:'device'}),
 delegated('auto',{label:'自动选择'}),delegated('provider',{label:'Codex · 自动选择账号',provider:'codex'}),
 delegated('account',{label:'Codex · 本机',runtimeId:'codex-native'})];
// Members' names are worked out while rendering, once the interface language is ready.
const swarm=()=>swarmMembers(swarmTasks,[],[]);
// Subtasks not started yet show who they were handed to: an account named 设置, and PugPort's choice among accounts.
const handed=(id,agent)=>({...subtask(id),runIds:[],delegation:{parentId:'parent',role:'worker',requestId:id,agent}});
const measures={inputTokens:10,outputTokens:5,cacheReadTokens:null,cacheWriteTokens:null,reasoningOutputTokens:null,totalTokens:15,estimatedCostUsd:null};
const counted={...measures,runs:1,reportedRuns:1,tokenReportedRuns:1,costReportedRuns:0,historyImportedRuns:0,uncertainRuns:0,accountingRuns:{subscription:1,usage:0,unknown:0},
 metricReportedRuns:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,reasoningOutputTokens:0,totalTokens:1,estimatedCostUsd:0}};
const usageRun=(runId,runtimeId,runtimeLabel)=>({...measures,runId,projectPath:'C:/Fixture/设置',runtimeId,runtimeLabel,provider:'codex',model:'gpt-5.5',
 accountingMode:'subscription',status:'completed',startedAt:stamp,eventCount:1,historyImported:false,uncertain:false,sources:[],notes:[]});
const usageReport={generatedAt:stamp,filters:{},totals:counted,byProject:[{...counted,projectPath:'C:/Fixture'}],byModel:[{...counted,runtimeId:'named',model:'gpt-5.5'}],
 byRuntime:[{...counted,runtimeId:'named',label:'设置',provider:'codex'},{...counted,runtimeId:'codex-native',label:'Codex · 本机',provider:'codex'}],
 perRun:[usageRun('run-named','named','设置'),usageRun('run-local','codex-native','Codex · 本机')],note:''};
const taskCosts=[{...measures,taskId:'task',conversationId:'chat',title:'设置',startedAt:stamp,status:'completed',runs:1,subtasks:0,reviews:0,fixes:0,retries:0,executors:['设置','Codex · 本机'],
 projectPath:'C:/Fixture/设置',billedUsd:null,referenceUsd:null,missingCost:0,subscriptionRuns:1,handoffs:0,accountKeys:[],runtimeIds:['named','codex-native'],traceWorkflowId:'task'}];
window.usageCalls=[];
const emptySpend=${JSON.stringify(emptySpend)};
const usageApi=async path=>{
 window.usageCalls.push(path);
 const query=new URL(path,'https://fixture.invalid').searchParams;
 const data=insightFixture({range:query.get('range'),kind:query.get('kind'),project:query.get('project')||'',runtime:query.get('runtime')||''},true);
 const executors=usageReport.byRuntime.map(row=>({...data.summary,runtimeId:row.runtimeId,label:row.label,executionKinds:['cli'],spendTrend:[],models:[]}));
 const insights={...emptySpend.insights,...data,report:usageReport,tasks:taskCosts,projects:['C:/Fixture'],runtimes:executors.map(row=>({id:row.runtimeId,label:row.label})),
  executors:executors.map(row=>({...row,models:[{...row,model:'设置'}]}))};
 // The Spend page reads an overview, and a details page per grouping when its table is open.
 const url=new URL(path,'https://fixture.invalid');
 if(url.pathname.endsWith('/details')){const group=query.get('group');
  return {query:{range:query.get('range'),kind:query.get('kind'),billing:query.get('billing'),group,offset:0,limit:20},interval:data.interval,report:usageReport,
   tasks:group==='task'?taskCosts:[],projects:group==='project'?[{...counted,projectPath:'C:/Fixture'}]:[],total:1,offset:0,limit:20};}
 return {...emptySpend,insights,options:{projects:['C:/Fixture'],runtimes:insights.runtimes,accounts:[]}};
};
// Web agents' usage lines: at the limit, read, and an older reading.
const webWindow={id:'five',label:'5h',usedPercent:60,resetsAt:at(3600)};
const webLabels=[{cooldown:{resetsAt:at(10800),observedAt:stamp}},{quota:{status:'known',source:'fixture',observedAt:stamp,windows:[webWindow]}},
 {quota:{status:'known',source:'fixture',observedAt:stamp,stale:true,windows:[webWindow]}}].map(agent=>webQuotaLabel(agent,now));
// The main conversation's group chat. Swarm members' lines: a device and a custom role named 设置, and a built-in role.
const peerLines=()=>swarmChatLines(swarm(),[{id:'peer-a',from:'device',to:'custom',text:'设置',at:at(10),runId:'peer-run'},
 {id:'peer-b',from:'custom',to:'builtin',text:'设置',at:at(11),runId:'peer-run'},{id:'peer-c',from:'builtin',to:'custom',text:'完成',at:at(12),runId:'peer-run'}]);
// A subtask PugPort's default account handed to one the user named Work · 设置 (piece by piece "Work · Settings"), which
// answered 完成 ("Done"); replies from a device named 设置 on PugPort's default account, an outside agent, and a role
// named 设置 on PugPort's second Qwen source.
const chatTask=(id,fields)=>({...queued,id,status:'completed',phase:'done',...fields});
const chatWorkflows=[chatTask('chat-parent'),chatTask('chat-child',{finalMessageId:'chat-reply',runIds:['chat-child-run'],delegation:{parentId:'chat-parent',
 role:'reviewer',requestId:'chat-review',agent:{label:'Work · 设置',provider:'codex',runtimeId:'named',caller:'Codex · 本机'}}}),
 chatTask('chat-role',{agentPreset:{id:'my-role',name:'设置'},input:{...queued.input,runtimeId:'api-qwen'}}),
 // Subtasks whose last word is PugPort's own: an outside agent's queued status and a system notice.
 chatTask('chat-grok',{delegation:{parentId:'chat-parent',role:'worker',requestId:'chat-grok',agent:{label:'Grok Bot',externalAgentId:'grok-bot',caller:'Codex · 本机'}}}),
 chatTask('chat-notice',{delegation:{parentId:'chat-parent',role:'worker',requestId:'chat-notice',agent:{label:'Work · 设置',runtimeId:'named',caller:'Codex · 本机'}}})];
const said=(id,workflowId,role,content,seconds,fields)=>({id,conversationId:'chat',workflowId,role,content,createdAt:at(seconds),...fields});
const chatMessages=[said('chat-ask','chat-parent','user','Synthetic request',1),said('chat-task','chat-child','user','Codex · 本机 请你完成以下子任务：\n设置',2),
 said('chat-reply','chat-child','assistant','完成',3),said('chat-device',undefined,'assistant','设置',4,{device:{id:'device',name:'设置',executor:'Codex · 本机'}}),
 {...applied,id:'chat-external',createdAt:at(5),externalAgent:{...applied.externalAgent,agentId:'muse',name:'Muse'}},said('chat-role-reply','chat-role','assistant','完成',6,{replyIdentity:{automatic:true,kind:'model',
  runs:[{runId:'chat-role-run',runtimeId:'named',accountLabel:'设置',model:'gpt-5.5',effort:'high',confirmed:true}]}}),
 said('chat-grok-task','chat-grok','user','设置',2.2),said('chat-grok-reply','chat-grok','assistant','已交给 Grok Bot，排队中…',2.4,
  {externalAgent:{agentId:'grok-bot',name:'Grok Bot',status:'queued',request:'设置',updatedAt:stamp}}),
 said('chat-notice-task','chat-notice','user','设置',2.6),said('chat-notice-reply','chat-notice','assistant','已授权写入，正在重跑同一请求。',2.8,
  {systemNotice:{text:'已授权写入，正在重跑同一请求。'}})];
// Reply identities are shown, so the account a reply ran on (named 设置) appears in its heading.
const chatState={...state,settings:{...state.settings,showAutomaticReplyIdentity:true},workflows:chatWorkflows,runs:[...runs,{...childRun('chat-child',{status:'completed'}),account:{id:'named',label:'Work · 设置',provider:'codex'}}]};
// Reset-card hints for a Codex account near its limit, and a credit's last day.
const lowCodex=(details,availableCount)=>({provider:'codex',quota:{status:'known',source:'fixture',observedAt:stamp,windows:[{id:'five',usedPercent:95,resetsAt:null}],
 resetCredits:{availableCount,details,observedAt:stamp,source:'fixture'}}});
const resetCard=seconds=>({key:'card-'+seconds,kind:'full',status:'available',grantedAt:stamp,expiresAt:at(seconds)});
const resetHints=[lowCodex([resetCard(1800)],1),lowCodex([resetCard(72000)],1),lowCodex([resetCard(432000),resetCard(216000)],2),lowCodex(null,1),lowCodex(null,3)]
 .map(runtime=>resetCardSuggestion(runtime,now));
const mount=(id,element)=>createRoot(document.getElementById(id)).render(element);
const reportRuns=['report-a','report-b'].map(id=>({id,taskOutcome:{status:'completed',source:'executor-report',summary:'完成',claims:[{claim:'继续',evidence:'设置'}]}}));
const reportSteps=reportRuns.map((run,index)=>({id:'step-'+index,title:'设置',runIds:[run.id]}));
const reportTask={plan:reportSteps,review:{round:0,status:'passed',claims:[{claim:'继续',status:'verified'}]}};
void startInterfaceLanguage().then(()=>{
 mount('reports',<><div className="studio-main"><button className="icon-button sidebar-restore" aria-label="展开侧边栏">☰</button><div className="conversation-toolbar"><div><strong translate="no">合成任务：步骤清单和执行小结</strong></div></div></div><ol className="plan-list">{reportSteps.map((step,index)=><li key={step.id}><span className="step-marker">{index+1}</span><div><strong translate="no">{step.title}</strong><StepReport workflow={reportTask} step={step} runs={reportRuns} open={index===1}/></div></li>)}</ol><SystemNoticeView notice={{text:'本轮任务尚未完成，可继续未完成的工作。',stop:{step:2,title:'设置',reason:'继续'}}}/></>);
 // Traditional Chinese: a sentence written with the same characters as its source matches the source pattern
 // again once shown, so the filled-in name must be protected there too (设置 would become 設定).
 if(locale==='zh-TW'){
  mount('notice',<NoticeToast notice={{tone:'success',message:'已移除「{0}」。',names:['设置']}} onClose={()=>{}}/>);
  mount('confirm',<ConfirmDialog options={{title:'移除「{0}」？',names:['设置'],action:'移除',tone:'danger'}} onAnswer={()=>{}}/>);
  mount('devices',<DevicesCard api={devicesApi} notify={()=>{}}/>);
  return;
 }
 mount('trajectory',<TrajectoryPanel run={traced}/>);
 mount('external',<ExternalReplyPanel message={applied} notify={()=>{}}/>);
 mount('queue',<ConversationQueue conversation={conversation} state={state} api={api} notify={()=>{}}/>);
 mount('task',<QueueItem workflow={queued} state={state} api={api} now={Date.parse(stamp)} notify={()=>{}} onConversation={()=>{}} onInspect={()=>{}}/>);
 mount('running-task',<QueueItem workflow={running} state={state} api={api} now={Date.parse(stamp)+65000} notify={()=>{}} onConversation={()=>{}} onInspect={()=>{}}/>);
 mount('delegation',<DelegationProgress workflow={child} state={state} sequence={1} messages={[{id:'brief',conversationId:'chat',role:'user',content:'继续',createdAt:stamp}]}/>);
 mount('pugport-delegation',<DelegationProgress workflow={pugportChild} state={state} sequence={2} messages={[]}/>);
 mount('output-delegation',<DelegationProgress workflow={outputChild} state={state} sequence={3} messages={[]}/>);
 mount('relay-delegation',<DelegationProgress workflow={relayChild} state={state} sequence={4} messages={[]}/>);
 mount('qwen-delegation',<DelegationProgress workflow={qwenChild} state={state} sequence={5} messages={[]}/>);
 mount('named-qwen-delegation',<DelegationProgress workflow={namedQwenChild} state={state} sequence={6} messages={[]}/>);
 mount('handed-delegation',<><DelegationProgress workflow={handed('handed-named',{label:'设置',runtimeId:'named'})} state={state} sequence={7} messages={[]}/>
  <DelegationProgress workflow={handed('handed-auto',{label:'Codex · 自动选择账号',provider:'codex'})} state={state} sequence={8} messages={[]}/></>);
 mount('trace',<WorkflowTrace workflow={child} state={state} api={api} notify={()=>{}} onInspect={()=>{}}/>);
 mount('trace-short',<WorkflowTrace workflow={shortChild} state={state} api={api} notify={()=>{}} onInspect={()=>{}}/>);
 // Open the moved route details only while checking them, so the overlay does not cover the other fixtures.
 // The route reasons live in the trace's Context tab, which reads its own context page.
 const contextPage={workflowId:child.id,contract:meteringContract,scope:{attempts:1,subtasks:0,handoffs:0},total:1,offset:0,limit:50,runs:[{
  runId:runs[0].id,workflowId:child.id,depth:0,attempt:1,label:null,executor:'Codex',runtimeId:runs[0].route.runtimeId,provider:null,transport:'cli',
  status:runs[0].status,startedAt:runs[0].startedAt,endedAt:runs[0].endedAt,relay:null,error:null,sessionMode:null,carriedTools:null,unconfirmedTools:null,
  textOnly:false,toolless:false,promptRecorded:false,parts:[],sent:{chars:0,tokens:0,method:'estimate'},transcript:null,reported:null,
  requests:{count:0,coverage:'not-reported',sources:[]},usage:null,tools:{count:0,coverage:'none'},partialHistory:false,
  route:{reasons:runs[0].route.reasons,warnings:runs[0].route.warnings,targetTier:null,shortQuotaLeft:null,shortQuotaWindow:null},measuredFiles:null}]};
 window.openTraceOverview=()=>{
  const host=document.body.appendChild(document.createElement('div'));host.id='trace-overview';
  const root=createRoot(host);window.closeTraceOverview=()=>{root.unmount();host.remove();};
  root.render(<ConversationTrace conversation={conversation} workflows={[child]} messages={[]} state={state}
   api={async path=>path.includes('/context?')?contextPage:path.endsWith('/context')?Promise.reject(Error('Not recorded')):({workflow:child,runs:[runs[0]],relatedRuns:[]})} notify={()=>{}} initialWorkflowId={child.id}
   initialRunId={runs[0].id} onClose={window.closeTraceOverview} onInspect={()=>{}}/>);
 };
 // A side chat of a main conversation named 设置, and one the user renamed to 设置 (the interface string "Settings").
 mount('side-chat',<SideChatHistory conversations={[{...conversation,id:'side',title:'设置 · 侧聊'},{...conversation,id:'side-renamed',title:'设置'}]} onOpen={()=>{}} onNew={()=>{}} onDelete={async()=>{}}/>);
 mount('confirm',<ConfirmDialogHost/>);
 mount('notice',<NoticeToast notice={{tone:'success',message:'已移除「{0}」。',names:['设置']}} onClose={()=>{}}/>);
 mount('dialog',<TrajectoryDetailDialog title="Fixture record" text="" onClose={()=>{}}/>);
 mount('devices',<DevicesCard api={devicesApi} notify={()=>{}}/>);
 mount('slack',<SlackGateway api={slackApi} notify={()=>{}}/>);
 mount('extension',<ExtensionChoice choice={found} busy={false} onChange={()=>{}} onInstall={()=>{}} onCancel={()=>{}}/>);
 mount('card-name',<><CardName label="设置" onRename={async()=>{}}/><CardName label="Codex · 本机" onRename={async()=>{}}/></>);
 const organizeNotice=createRoot(document.getElementById('organize-notice'));
 window.organizeCounts=[1,1,1];
 let organizeNumber=0;
 const organizeApi=async path=>path.endsWith('/classify')?{
  id:'organize-fixture-'+(++organizeNumber),status:'applied',total:2,processed:2,
  changed:window.organizeCounts[0],renamed:window.organizeCounts[1],createdFolders:window.organizeCounts[2],skipped:0,
  proposals:[],runIds:[],createdAt:stamp,updatedAt:stamp,
 }:{};
 mount('folders',<ChatFolders chats={[{...conversation,id:'filed',folderId:'folder'}]} state={{...state,conversationFolders:[{id:'folder',name:'设置',createdAt:stamp,updatedAt:stamp}]}}
  row={chat=><div key={chat.id}>{chat.title}</div>} api={organizeApi} reload={async()=>{}}
  notify={notice=>organizeNotice.render(<NoticeToast notice={notice} onClose={()=>{}}/>)} onVisibleOrder={()=>{}}/>);
 mount('installed',<InstalledRow item={tool} busy={false} onToggle={()=>{}} onRemove={()=>{}} onCheck={()=>{}} onSave={async()=>{}}/>);
 // In WSL, so the card does not load this computer's manual reset notes.
 mount('quota-card',<QuotaCard runtime={{...snapshot(named),environment:'wsl'}} now={now} maxAge={600} zoomable/>);
 mount('compact-quota',<CompactQuotaCard runtime={snapshot(local)} now={now} maxAge={600} onOpen={()=>{}}/>);
 mount('api-quota',<ApiQuotaCard provider={qwen} now={now} zoomable onOpen={()=>{}}/>);
 mount('target',<TargetEditor target={named} snapshot={snapshot(named)} api={api} reload={async()=>{}} notify={()=>{}}/>);
 mount('background',<BackgroundTasks tasks={[background]} conversationId="chat" onPause={()=>{}} onResume={()=>{}} onClose={()=>{}}/>);
 mount('checklist',<ExecutorChecklist state={{...state,targets:[named,local]}} onChange={()=>{}}/>);
 mount('routines',<ScheduledTasks api={routinesApi} state={state} notify={()=>{}} onConversation={()=>{}}/>);
 mount('taste',<TasteTestCard test={chosenTest} project={novel} api={api} notify={()=>{}} onClose={()=>{}}/>);
 mount('taste-ready',<TasteTestCard test={readyTest} project={novel} api={api} notify={()=>{}} onClose={()=>{}}/>);
 mount('writing',<WritingPreferences conversation={conversation} state={{...state,projects:[novel]}} api={writingApi} notify={()=>{}}/>);
 mount('mentions',<MentionMenu items={mentions} active={0} onHover={()=>{}} onPick={()=>{}} onCreate={()=>{}}/>);
 mount('connectors',<ConnectorsPage api={connectorsApi} notify={()=>{}}/>);
 const quote=createRoot(document.getElementById('quote-editor'));
 quote.render(<QuoteEditor text="设置" note="" left={20} top={20} onSave={()=>{}} onCancel={()=>{}}/>);
 window.closeQuote=()=>quote.unmount();
 mount('quote-chips',<QuoteChips quotes={[{id:'quote',text:'设置',note:'设置'}]} onEdit={()=>{}} onRemove={()=>{}}/>);
 mount('pinned',<PinnedMessages conversationId="chat" pins={[{messageId:'pinned',pinnedAt:stamp},{messageId:'gone',pinnedAt:stamp}]}
  messages={[{id:'pinned',conversationId:'chat',role:'user',content:'设置',createdAt:stamp}]} workflows={[]} pending={false}
  onUpdate={()=>{}} onJump={()=>{}} onTask={()=>{}} onRefresh={()=>{}}/>);
 mount('search',<BackgroundTasks tasks={[search]} conversationId="chat" onPause={()=>{}} onResume={()=>{}} onClose={()=>{}}/>);
 mount('swarm',<SwarmWorkspaceView members={swarm()} selectedId="custom" loading={false} sending={false} draft="" memberMessages={[]}
  messages={[{id:'reply',conversationId:'chat',role:'assistant',content:'设置',createdAt:stamp}]}
  communications={[{id:'peer',from:'device',to:'custom',text:'设置',at:stamp,runId:'peer-run'}]}
  plan={swarmPlan(swarmTasks,swarm())} saved={savedTimeText(12*60000)}
  onSelect={()=>{}} onDraft={()=>{}} onSend={()=>{}} onInspect={()=>{}}/>);
 // Without a task list, the time saved goes in the summary.
 mount('swarm-summary',<>{[{members:swarm(),saved:savedTimeText(65*60000)},{members:swarm().slice(0,1)}].map((view,index)=>
  <SwarmWorkspaceView key={index} {...view} loading={false} sending={false} draft="" memberMessages={[]} messages={[]} communications={[]}
   onSelect={()=>{}} onDraft={()=>{}} onSend={()=>{}} onInspect={()=>{}}/>)}</>);
 mount('peer-lines',<ConversationHistory messages={[]} workflows={[]} peerLines={peerLines()} state={state} api={api} notify={()=>{}} onInspect={()=>{}}/>);
 mount('chat-history',<ConversationHistory messages={chatMessages} workflows={chatWorkflows} state={chatState} api={api} notify={()=>{}} onInspect={()=>{}}/>);
 mount('reset-hints',<>{resetHints.map(hint=><p key={hint} className="quota-note">{hint}</p>)}</>);
 mount('expiry',<><ExpiryChip at={at(3600)} now={now} label="活动赠金"/><p>{compactResetLabel(new Date(now+86400000).toISOString(),now)}</p></>);
 mount('usage',<UsageSpend state={{...state,targets:[named,local],projects:[{...project,path:'C:/Fixture',name:'设置'}]}} api={usageApi} onInspect={()=>{}}/>);
 mount('folder-move',<FolderMoveDialog chat={{...conversation,title:'设置'}} folders={[{id:'folder',name:'设置',createdAt:stamp,updatedAt:stamp}]}
  api={api} reload={async()=>{}} notify={()=>{}} onClose={()=>{}}/>);
 mount('web-quota',<>{webLabels.map(label=><p key={label}>{label}</p>)}</>);
 const viewer=createRoot(document.getElementById('viewer'));
 viewer.render(<ImageViewer images={[{src:pixel,name:'设置',detail:'1 KB'}]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
 window.closeViewer=()=>viewer.unmount();
 // A conversation nobody named yet, and ones titled from a first message that names a source or an account.
 window.titles=['新对话','通义千问','Codex · 本机 · 看看'].map(shownTitle);
});`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{display:grid;grid-template-columns:600px 520px;gap:20px;align-items:start;padding:20px}#side,#names{display:grid;gap:16px}#names .mention-menu{position:static}#notice .notice{position:static}#dialog{display:none}#written{display:grid;gap:16px;grid-column:1/-1}#written .modal-backdrop,#written .quote-editor,#written .side-sheet{position:static}#written .side-sheet{max-height:none}</style></head><body><div id="trajectory"></div><div id="side"><div id="external"></div><div id="queue"></div><div id="task"></div><div id="running-task"></div><div id="delegation"></div><div id="pugport-delegation"></div><div id="output-delegation"></div><div id="relay-delegation"></div><div id="qwen-delegation"></div><div id="named-qwen-delegation"></div><div id="handed-delegation"></div><div id="trace"></div><div id="trace-short"></div><div id="side-chat"></div><div id="notice"></div><div id="reports"></div><div id="devices"></div><div id="slack"></div><div id="extension"></div></div><div id="names"><div id="card-name"></div><div id="folders"></div><div id="installed"></div><div id="quota-card"></div><div id="compact-quota"></div><div id="api-quota"></div><div id="target"></div><div id="background"></div><div id="checklist"></div><div id="routines"></div><div id="taste"></div><div id="taste-ready"></div><div id="writing"></div><div id="mentions"></div></div><div id="written"><div id="connectors"></div><div id="quote-editor"></div><div id="quote-chips"></div><div id="pinned"></div><div id="search"></div><div id="swarm"></div><div id="swarm-summary"></div><div id="usage"></div><div id="folder-move"></div><div id="organize-notice"></div><div id="web-quota"></div><div id="peer-lines"></div><div id="chat-history"></div><div id="reset-hints"></div><div id="expiry"></div></div><div id="confirm"></div><div id="dialog"></div><div id="viewer"></div><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
let win;const network=[];
const evaluate=source=>win.webContents.executeJavaScript(source);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const wait=async(expression)=>{for(let n=0;n<250;n++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+expression);};
const textOf=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+')?.textContent.trim()');
const count=selector=>evaluate('document.querySelectorAll('+JSON.stringify(selector)+').length');
// Texts matching selector inside the trajectory row whose header button mentions label.
const inRow=(label,selector)=>evaluate('[...[...document.querySelectorAll(".trajectory-row")].find(row=>row.querySelector("button").textContent.includes('+JSON.stringify(label)+')).querySelectorAll('+JSON.stringify(selector)+')].map(node=>node.textContent.trim())');
const click=async(selector,text)=>{if(!await evaluate('(()=>{const node=[...document.querySelectorAll('+JSON.stringify(selector)+')].find(node=>node.textContent.includes('+JSON.stringify(text)+'));node?.click();return !!node;})()'))throw Error('Missing '+selector+' '+text);await frame();};
const shot=async(name)=>{await evaluate('document.fonts.ready');await frame();await new Promise(resolve=>setTimeout(resolve,300));await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG());};
void app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
  await win.loadFile(path.join(__dirname,'index.html'));
  await wait('!!document.querySelector(".trajectory-row") && !!document.querySelector(".delegation-task-title") && !!document.querySelector("#devices .settings-row") && !!document.querySelector("#slack .settings-row")');
  assert.equal(await count('#reports details[open]'),1);
  assert.ok(await evaluate('document.querySelector("#reports .conversation-toolbar strong").getBoundingClientRect().left >= document.querySelector("#reports .sidebar-restore").getBoundingClientRect().right + 4'));
  // Cut-off recorded text stays as written; the note after the cut is interface text.
  const [cut]=await inRow('Model reply','.trajectory-row-text');
  assert.ok(cut.startsWith('继续整理。继续整理。'),cut);
  assert.ok(cut.endsWith('…(view full details)'),cut);
  // A stage without an ID: the fallback is interface text, not a protected code element.
  assert.equal(await count('.trajectory-row-detail'),0);
  assert.deepEqual(await inRow('find_files','.trajectory-tool-summary'),['query: plan · count: 3']);
  await shot('trajectory-collapsed-light');
  await click('.trajectory-row-heading','find_files');
  assert.equal(await textOf('.trajectory-stage small'),'Parent call · bridge-a · Stage · ID not reported');
  assert.equal(await count('.trajectory-stage small code'),2);
  // A reported stage name stays as written; PugPort's name for an unnamed one translates.
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".trajectory-stage strong")].map(node=>node.textContent)'),['Validate scope','Unnamed stage']);
  // The task input row has no recorded text: its placeholder is a translatable note, not protected output.
  await click('.trajectory-row > button','Task input');
  await wait('[...document.querySelectorAll(".trajectory-row")].some(row=>row.textContent.includes("Task input")&&row.querySelector(".trajectory-row-detail"))');
  assert.deepEqual(await inRow('Task input','.trajectory-row-detail .trajectory-note'),['No further details were reported.']);
  assert.deepEqual(await inRow('Task input','.trajectory-row-detail pre'),[]);
  // The historical diff is user content and stays protected from interface translation.
  assert.equal(await textOf('.external-reply-diff pre'),'继续');
  assert.equal(await count('#external button'),0);
  // What the user queued and what the parent agent wrote stay as written.
  assert.equal(await textOf('.conversation-queue-content'),'继续');
  assert.equal(await textOf('.queue-title'),'继续');
  assert.equal(await textOf('#delegation .delegation-task-title'),'继续');
  // A label with a full-width colon keeps a space before its value in English.
  const texts=selector=>evaluate('[...document.querySelectorAll('+JSON.stringify(selector)+')].map(node=>node.textContent.trim())');
  // The queue no longer shows the filler "Estimated duration: Not estimated yet".
  assert.deepEqual(await texts('#task .queue-brief > span'),[]);
  const brief=await texts('#running-task .queue-brief > span');
  assert.equal(brief[0],'Running for: 1m 05s');
  assert.match(brief[1],/^Deadline: [^\s]/);
  // What agents wrote stays as written after its label; PugPort's own error and check summary translate.
  assert.deepEqual(await texts('#delegation .delegation-task-progress > p:not([class])'),['Progress: 完成','Next: 继续']);
  assert.equal(await textOf('#delegation .delegation-blocker'),'Needs attention: 设置');
  assert.equal(await textOf('#delegation .delegation-judgment'),'Executor report: 完成');
  assert.equal(await textOf('#pugport-delegation .delegation-blocker'),'Needs attention: Verification command skipped: desktop approval is missing');
  assert.equal(await textOf('#pugport-delegation .delegation-judgment'),'Executor report: The acceptance commands run by PugPort passed. The requested file results are confirmed (changes may not have been needed).');
  assert.equal(await textOf('#output-delegation .delegation-output'),'Latest output: 完成');
  assert.deepEqual(await texts('#trace .delegation-progress > span'),['Progress: 完成','Next: 继续','Stuck on: 设置']);
  assert.equal(await count('#trace .route-details'),0);
  await evaluate('window.openTraceOverview()');
  await wait('!!document.querySelector("#trace-overview [role=tab][aria-selected=true]")');
  assert.equal(await textOf('#trace-overview [role=tab][aria-selected=true]'),'Overview');
  // The route reasons moved to the Context tab's "why" card; its raw view opens the same full-text dialog.
  await click('#trace-overview [role=tab]','Context');
  const routeRow='[...document.querySelectorAll("#trace-overview .trace-context-card dt")].find(node=>node.textContent==="Route")';
  await wait('!!'+routeRow);
  await evaluate(routeRow+'.nextElementSibling.querySelector("button").click()');
  await wait('!!document.querySelector("#trace-overview .trajectory-full-text")');
  assert.equal(await textOf('#trace-overview .trajectory-detail-modal h2'),'Why this route was chosen');
  assert.deepEqual((await textOf('#trace-overview .trajectory-full-text')).split('\n'),["设置's Week usage limit resets The day after tomorrow with 60% left; at the usual pace about 40% would go unused, so use it first","Continue this chat's native session and stay with 设置; save unused capacity for new tasks",'Credit behind by $80; new task, so switching: this follow-up leaves the earlier session and moves to 设置 with the context']);
  await evaluate('window.closeTraceOverview()');
  // The tooltip listing the checkpoints keeps the agent's words; only "stuck on" is interface text.
  const titles=id=>evaluate('[...document.querySelectorAll("#'+id+' .delegation-progress, #'+id+' .delegation-progress *")].map(node=>node.title).filter(Boolean)');
  assert.deepEqual(await titles('trace'),['完成 → 继续 (stuck on: 设置)']);
  assert.deepEqual(await titles('trace-short'),['完成']);
  // An unknown provider's fallback CLI name translates; the account label the user chose does not.
  assert.deepEqual(await inRow('find_files','.trajectory-source'),['Native CLI / 设置 · PugPort tool execution · Executor inferred from the recorded route']);
  // Native status rows: PugPort's action and its default account label translate, the named account does not.
  const rowTitles=await texts('.trajectory-row-title > strong');
  for(const title of ['Codex CLI / Codex · Local · Process started','Claude CLI / Work · 设置 · Permission configuration','Native CLI / 设置 · Start executor'])
   assert.ok(rowTitles.includes(title),rowTitles.join(' | '));
  assert.deepEqual(await inRow('Process started','.trajectory-source'),['Codex CLI / Codex · Local · Native execution event']);
  // The row's full-record dialog is titled the same way.
  await evaluate('[...document.querySelectorAll(".trajectory-row")].find(row=>row.querySelector("button").textContent.includes("Permission configuration")).querySelector(".trajectory-read-more:last-child").click()');
  await wait('!!document.querySelector("#trajectory .trajectory-detail-modal h2")');
  assert.equal(await textOf('#trajectory .trajectory-detail-modal h2'),'Claude CLI / Work · 设置 · Permission configuration · Full details');
  await click('#trajectory .trajectory-detail-actions button','Close');
  // And so are its tooltips: the "view full details" button and the row's marker on the time track.
  assert.equal(await evaluate('[...document.querySelectorAll(".trajectory-row")].find(row=>row.querySelector("button").textContent.includes("Permission configuration")).querySelector(".trajectory-read-more:last-child").title'),'Claude CLI / Work · 设置 · Permission configuration · View full details');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".trajectory-marker")].map(node=>node.getAttribute("aria-label")).filter(label=>label.includes("Permission"))'),['Claude CLI / Work · 设置 · Permission configuration · Record · 6.0s · Event time']);
  // Account labels in a subtask: PugPort's default translates, the named one does not.
  assert.equal(await textOf('#relay-delegation .delegation-executor'),'设置 · gpt-5.5 · medium');
  assert.equal(await textOf('#qwen-delegation .delegation-executor'),'Qwen 2 · gpt-5.5 · medium');
  assert.equal(await textOf('#named-qwen-delegation .delegation-executor'),'通义千问 · 公司号 · gpt-5.5 · medium');
  assert.deepEqual(await texts('#handed-delegation .delegation-executor'),['设置','Codex · Auto-select account']);
  assert.equal(await textOf('#relay-delegation .delegation-relay'),'Account handoff: Codex · Local · gpt-5.5 · medium → 设置 · gpt-5.5 · medium · Original account at usage limit');
  // Names next to interface text: the task's project, a device (also inside a translated aria-label), the device
  // that runs Slack, and a skill found for installing.
  assert.equal(await textOf('#task .queue-item-heading > span:nth-child(2)'),'设置');
  assert.equal(await textOf('#devices .settings-row-expand'),'设置');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#devices button")].filter(node=>node.textContent.includes("Remove device")).map(node=>node.getAttribute("aria-label"))'),['Remove 设置']);
  // The GitHub maintenance device picker moved to Extensions → Connections → GitHub (UI simplicity audit, 10-31).
  assert.equal(await count('#devices select'),0);
  assert.equal(await count('#slack .side-sheet'),0);
  await click('#slack button','Manage');
  await wait('!!document.querySelector("#slack .side-sheet select")');
  assert.deepEqual(await texts('#slack .side-sheet select option'),['This computer','设置']);
  assert.equal(await textOf('#slack .side-sheet .slack-note'),"Running on “设置”, so this computer stays off Slack. Change it below.");
  assert.equal(await textOf('#extension .ext-draft-title strong'),'设置');
  // The same names inside attributes (filled in with data-names) and next to interface text; PugPort's default names
  // (Codex · 本机, 通义千问 2) translate, and so does the interface text around every name.
  await wait('!!document.querySelector("#routines .routine-card") && !!document.querySelector("#writing .writing-preference-choice")');
  const attr=(selector,name)=>evaluate('[...document.querySelectorAll('+JSON.stringify(selector)+')].map(node=>node.getAttribute('+JSON.stringify(name)+'))');
  assert.equal(await textOf('#devices .settings-row-description'),'Linux · 0 AI tools available');
  assert.deepEqual(await texts('#card-name .card-name h3'),['设置','Codex · Local']);
  assert.deepEqual(await attr('#card-name .card-name-edit','aria-label'),['Rename 设置','Rename Codex · Local']);
  assert.deepEqual(await attr('#card-name .card-name-edit','title'),['Rename (other executors call it by this name)','Rename (other executors call it by this name)']);
  // Renaming a default name starts from the name as shown.
  await evaluate('document.querySelectorAll("#card-name .card-name-edit")[1].click()');
  await frame();
  assert.equal(await evaluate('document.querySelector("#card-name .card-name.editing input").value'),'Codex · Local');
  await evaluate('document.querySelector("#card-name .card-name.editing button:last-child").click()');
  await frame();
  assert.equal(await textOf('#folders .chat-folder-toggle span'),'设置');
  assert.deepEqual(await attr('#folders .chat-folder-heading .icon-button','aria-label'),['Actions for category 设置']);
  assert.equal(await textOf('#installed .settings-row-expand'),'设置');
  assert.deepEqual(await attr('#installed input[type=checkbox]','aria-label'),['Disable 设置']);
  assert.deepEqual(await attr('#installed .ext-more','aria-label'),['More actions for 设置']);
  assert.equal(await count('#installed .settings-detail-actions button'),0);
  await click('#installed .ext-more','');
  assert.equal(await count('#installed .context-menu [role="menuitem"]'),3);
  await click('#installed .context-menu [role="menuitem"]','');
  assert.equal(await textOf('#installed .side-sheet-title strong'),'设置');
  assert.deepEqual(await attr('#installed .side-sheet input:not([type=password])','aria-label'),['Connection name for 设置']);
  await click('#installed .side-sheet-head button','');
  assert.deepEqual(await attr('#extension .ext-instance-fields select','aria-label'),['How to add 设置']);
  assert.deepEqual(await attr('#extension .ext-instance-fields input','aria-label'),['Connection name for 设置']);
  assert.deepEqual(await attr('#extension .ext-instance-fields input','placeholder'),['设置']);
  assert.equal(await textOf('#quota-card .quota-heading h3'),'设置');
  assert.deepEqual(await attr('#quota-card .quota-card','aria-label'),['设置 usage details']);
  assert.deepEqual(await attr('#quota-card .quota-track','aria-label'),['设置 5-hour limit usage left']);
  assert.equal(await textOf('#compact-quota h3'),'Codex · Local');
  assert.deepEqual(await attr('#compact-quota .quota-card','aria-label'),['Codex · Local usage details']);
  assert.deepEqual(await attr('#compact-quota .quota-track','aria-label'),['Codex · Local 5-hour limit usage left']);
  assert.equal(await textOf('#api-quota h3'),'Qwen 2');
  assert.deepEqual(await attr('#api-quota .quota-card','aria-label'),['Qwen 2 usage details']);
  assert.deepEqual(await attr('#api-quota .quota-track','aria-label'),['Qwen 2 Usage limit usage left']);
  assert.equal(await textOf('#target .target-heading h3'),'设置');
  assert.deepEqual(await attr('#target .target-heading .switch input','aria-label'),['Disable 设置']);
  assert.deepEqual(await attr('#target .target-test select','aria-label'),['设置 connection test model']);
  assert.deepEqual(await texts('#background .background-task-assistant > span'),['设置','Codex · Local']);
  assert.deepEqual((await attr('#background .background-task-assistant','title'))[0],'设置 · gpt-5.5 high · running');
  assert.deepEqual(await texts('#checklist .executor-checklist-card'),['设置','Codex · Local']);
  assert.deepEqual(await attr('#checklist input[type=checkbox]','aria-label'),['Automatically select 设置','Automatically select Codex · Local']);
  assert.equal(await textOf('#routines .routine-card h2'),'设置');
  assert.deepEqual(await attr('#routines .routine-switch','aria-label'),['设置 · Enable']);
  assert.deepEqual(await attr('#slack .slack-users button','aria-label'),['Remove 设置']);
  assert.deepEqual(await attr('#slack .slack-users button','title'),['Remove']);
  assert.equal(await textOf('#taste .taste-test-heading strong'),'You picked A: 设置 · gpt-5.5 · high');
  assert.deepEqual(await texts('#taste .taste-test-reveal li'),['A 设置 · gpt-5.5 · high','B Codex · Local · gpt-5.5 · medium']);
  assert.deepEqual(await texts('#taste-ready .taste-test-text p'),['继续','继续']);
  assert.equal(await textOf('#writing .writing-preference-choice > span'),'设置 · gpt-5.5 · high');
  assert.match(await textOf('#writing .writing-preference-choice small'),/picked in a taste test · 继续$/);
  assert.deepEqual(await texts('#mentions .mention-row strong'),['设置','Free','Read-only investigation','设置','Muse','设置']);
  assert.deepEqual(await attr('.image-viewer','aria-label'),['Image preview 设置']);
  assert.deepEqual(await attr('.image-viewer-name','title'),['设置']);
  assert.deepEqual(await attr('.image-viewer-stage img','alt'),['设置']);
  assert.deepEqual(await attr('.image-viewer-stage img','title'),['Click for actual size']);
  // Interface text on elements whose attributes carry names is translated where it is built: no Chinese is left
  // there apart from the names.
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-names]")].flatMap(node=>["title","aria-label","placeholder","alt"].map(name=>node.getAttribute(name)||"")).filter(value=>/[㐀-鿿]/.test(value.replaceAll("设置","")))'),[]);
  assert.ok(await count('[data-names]')>=40);
  assert.deepEqual(await evaluate('window.titles'),['New chat','通义千问','Codex · 本机 · 看看']);
  await shot('names-image-viewer-light');
  await evaluate('window.closeViewer()');
  await frame();
  // What people and agents wrote stays as written beside translated interface text: a connected account and its
  // owner's name, in the account's menu, the disconnect question and the authorization notes.
  await wait('!!document.querySelector("#connectors .connector-account") && !!document.querySelector("#search .background-task-title")');
  assert.equal(await textOf('#connectors .connector-account-title strong'),'设置');
  assert.equal(await textOf('#connectors .connector-account-identity'),'设置');
  assert.deepEqual(await attr('#connectors .connector-account-menu summary','aria-label'),['Manage 设置']);
  assert.deepEqual(await attr('#connectors .connector-account-menu summary','title'),['Manage 设置']);
  assert.deepEqual(await attr('#connectors .connector-account-actions [aria-label]','aria-label'),['Enable 设置','Edit permissions for 设置','Rename 设置','Disconnect 设置']);
  await evaluate('document.querySelector("#connectors .connector-disconnect").click()');
  await wait('!!document.querySelector("#connectors .connector-remove p")');
  assert.equal(await textOf('#connectors .connector-remove p'),'Disconnect “设置” and remove its locally saved credentials? Mail, cloud files, calendars, tasks and contacts will be kept.');
  await click('#connectors .connector-remove button','Keep');
  await click('#connectors .connector-account-actions button','Reauthorize');
  await wait('!!document.querySelector("#connectors .connector-authorization strong")');
  assert.equal(await textOf('#connectors .connector-authorization strong'),'Finish authorizing “设置”');
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait('document.querySelector("#connectors .connector-authorization strong")?.textContent.startsWith("Connected")');
  assert.equal(await textOf('#connectors .connector-authorization strong'),'Connected “设置”');
  // A quote and its note, in the note box and on the capsule's tooltip.
  assert.equal(await textOf('#quote-editor blockquote'),'设置');
  assert.deepEqual(await attr('#quote-editor blockquote','title'),['设置']);
  assert.deepEqual(await attr('#quote-chips .quote-chip > button:first-child','title'),['设置\n\nNote: 设置']);
  await evaluate('window.closeQuote()');
  // A pinned message's words; the note for a missing one is interface text.
  assert.deepEqual(await attr('#pinned .pinned-messages-summary .pinned-message-preview','title'),['设置']);
  await evaluate('document.querySelector("#pinned .pinned-messages-toggle").click()');
  await wait('!!document.querySelector("#pinned .pinned-messages-list")');
  assert.deepEqual(await texts('#pinned .pinned-message-preview'),['设置','设置','Original message unavailable']);
  // An image search titled with what the agent searched for.
  assert.equal(await textOf('#search .background-task-title'),'Background image search: 设置');
  assert.deepEqual(await attr('#search .background-task-title','title'),['Background image search: 设置']);
  // Swarm members: a custom role and a device by their names, PugPort's own names translated; the task list, what
  // members said and the member sheet keep what was written.
  const roles=(await attr('#swarm .swarm-avatar','aria-label')).map(label=>label.replace(/ · [^·]+$/,''));
  assert.deepEqual(roles,['Primary agent','设置','Read-only investigation','Device “设置”','Automatic','Codex · Auto-select account','Codex · Local']);
  assert.ok((await attr('#swarm .swarm-avatar','title')).every(title=>title.endsWith('\n设置')));
  // Each count in the summary is its own sentence (was "6 members · 6 位在干活").
  assert.equal(await textOf('#swarm .swarm-bar-summary'),'7 members · 7 working');
  assert.deepEqual(await texts('#swarm .swarm-plan-title'),['设置','设置']);
  assert.deepEqual(await texts('#swarm .swarm-plan-meta'),['Read-only · Automatic','Read-only · 设置']);
  assert.deepEqual(await attr('#swarm .side-sheet','aria-label'),['Member 设置']);
  assert.equal(await textOf('#swarm .side-sheet-title strong'),'设置');
  assert.ok((await texts('#swarm .swarm-history-message header strong')).includes('From Device “设置”'));
  assert.deepEqual(await texts('#swarm .swarm-complete-text'),['设置','设置']);
  assert.deepEqual(await attr('#swarm .swarm-member-composer textarea','aria-label'),['Message 设置']);
  assert.match((await attr('#swarm .swarm-member-composer textarea','placeholder'))[0],/^Message 设置 directly/);
  // The time saved is one sentence, in the task list and in the summary (was "Parallel work savedabout 12 min", and
  // "约 1 h 5 min" left in Chinese).
  assert.equal(await textOf('#swarm .swarm-saved'),'Parallel work saved about 12 min');
  assert.deepEqual(await texts('#swarm-summary .swarm-bar-summary'),['7 members · 7 working · Parallel work saved about 1 h 5 min','1 member · 1 working']);
  // Usage: task titles, projects, accounts and folders as written, in every grouping and in the filters.
  // The per-task, per-project and per-call tables sit in the Spend page's folded details.
  await wait('!!document.querySelector("#usage .spend-health > details > summary")');
  await evaluate('document.querySelector("#usage .spend-health > details > summary").click()');
  const details='#usage .spend-health > details .usage-table';
  await wait('!!document.querySelector('+JSON.stringify(details+' th[scope=row] > span[title]')+')');
  const rowNames=()=>texts(details+' th[scope=row] > span');
  assert.deepEqual(await rowNames(),['设置']);
  assert.deepEqual(await attr(details+' th[scope=row] > span','title'),['设置']);
  assert.deepEqual(await texts(details+' td > span'),['设置、Codex · Local']);
  // One call is "1 call" (was "1 calls in all"), and each count beside the totals is its own piece.
  assert.deepEqual(await texts(details+' td > small'),['1 call in all']);
  assert.equal(await evaluate('document.querySelectorAll("#usage .usage-explanation").length'),0);
  const group=async (index,caption)=>{await evaluate('document.querySelectorAll("#usage .insight-details-heading .insight-segmented button")['+index+'].click()');
   await wait('document.querySelector('+JSON.stringify(details+' caption')+')?.textContent==='+JSON.stringify(caption));};
  await group(1,'Project');
  assert.deepEqual(await rowNames(),['设置']);
  await group(2,'Cost per call');
  assert.deepEqual(await texts(details+' td > span'),['设置','Codex · Local']);
  assert.deepEqual(await texts(details+' th[scope=row] > small[title]'),['设置','设置']);
  assert.deepEqual(await texts('#usage .insight-executor-name > span'),['设置','Codex · Local']);
  assert.deepEqual(await attr('#usage .insight-executor-name > span','title'),['设置','Codex · Local']);
  await evaluate('document.querySelector("#usage .insight-expand").click()');await frame();
  assert.deepEqual(await texts('#usage .insight-model-row .insight-executor-name > span'),['设置']);
  assert.deepEqual(await attr('#usage .insight-model-row .insight-executor-name > span','title'),['设置']);
  // Project selection preserves its name and reaches the insights query.
  await evaluate('(()=>{const select=document.querySelectorAll("#usage .insight-filters select")[0];select.value="C:/Fixture";select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await wait('window.usageCalls.at(-1).includes("project=C%3A%2FFixture")');
  assert.equal(await textOf('#usage .insight-filters select option:checked'),'设置');
  const options=index=>evaluate('[...document.querySelectorAll("#usage .insight-filters select")['+index+'].options].slice(1).map(node=>node.textContent.trim())');
  assert.deepEqual(await options(0),['设置']);
  assert.deepEqual(await options(1),['设置','Codex · Local']);
  // Categories: moving a chat and deleting a category; organizing has no executor dialog.
  assert.equal(await textOf('#folder-move .folder-move-title'),'设置');
  assert.deepEqual(await texts('#folder-move select option'),['Uncategorized','设置']);
  assert.equal(await evaluate('document.querySelector("#folders .folder-heading-actions button").title'),'Organize chats');
  await evaluate('document.querySelector("#folders .chat-folder-heading .icon-button").click()');
  await click('.context-menu [role=menuitem]','Delete category');
  await wait('!!document.querySelector("#folders .folder-dialog p")');
  assert.equal(await textOf('#folders .folder-dialog p'),'Deleting “设置” will return its chats to Uncategorized. Their content and pinned status will be kept.');
  await click('#folders .folder-dialog button','Cancel');
  await evaluate('document.querySelector("#folders .folder-heading-actions button").click()');
  await wait('document.querySelector("#organize-notice .notice > span")?.textContent === "Organized 1 chat · 1 renamed · 1 new category"');
  assert.equal(await textOf('#organize-notice .archive-text-button'),'Undo');
  assert.equal(await evaluate('!!document.querySelector("#folders [role=dialog]")'),false);
  await evaluate('window.organizeCounts=[2,0,2];document.querySelector("#folders .folder-heading-actions button").click()');
  await wait('document.querySelector("#organize-notice .notice > span")?.textContent === "Organized 2 chats · 2 new categories"');
  await evaluate('window.organizeCounts=[0,0,0];document.querySelector("#folders .folder-heading-actions button").click()');
  await wait('document.querySelector("#organize-notice .notice > span")?.textContent === "Your chats are already tidy."');
  // Whole sentences: the reset countdown (was "Resets in 1 hours 0 minutes"), web agents' usage lines and the taste
  // test's default-writer choice (was "this project'sProsegoes to it by default").
  // The exact reset time moved into the hover title (usage simplification, 10-31).
  assert.equal(await textOf('#quota-card .reset-time'),'Resets in 1 h 0 min');
  assert.equal((await attr('#quota-card .reset-time','title')).length,1);
  assert.deepEqual(await texts('#web-quota p'),['Usage limit reached · Resets in 3 h 0 min','40% left · Resets in 1 h 0 min','Last reading · 40% left · Resets in 1 h 0 min']);
  assert.equal(await evaluate('[...document.querySelectorAll("#taste-ready .taste-test-verdict label")].at(-1).textContent.trim()'),"From now on, this project's Prose goes to it by default");
  // The main conversation's group chat: members' names as shown (a device and a role named 设置 as written, PugPort's
  // built-in role translated), what they said as written, and the turn count as a whole phrase ("1 turn").
  await wait('!!document.querySelector("#peer-lines .conversation-exchange") && !!document.querySelector("#chat-history .delegation-group")');
  assert.deepEqual(await texts('#peer-lines .conversation-exchange summary strong'),['Device “设置” ↔ 设置 · 1 turn','设置 ↔ Read-only investigation · 2 turns']);
  assert.deepEqual(await texts('#peer-lines .exchange-preview'),['设置','完成']);
  assert.deepEqual(await texts('#peer-lines .participant-heading > strong'),['Device “设置”','设置','Read-only investigation']);
  assert.deepEqual(await texts('#peer-lines .participant-addressee'),['→ 设置','→ Read-only investigation','→ 设置']);
  // A subtask from PugPort's default account to one named Work · 设置, whose answer (完成) stays as written.
  const subtask=id=>'#chat-history details.delegation-group:has([data-child-id="'+id+'"])';
  assert.deepEqual(await texts(subtask('chat-child')+' > summary strong'),['Codex · Local ↔ Work · 设置 · 2 turns']);
  assert.deepEqual(await texts(subtask('chat-child')+' .exchange-preview'),['完成']);
  assert.deepEqual(await texts(subtask('chat-child')+' .delegated-message .participant-heading > strong'),['Codex · Local','Work · 设置']);
  assert.deepEqual(await texts(subtask('chat-child')+' .delegated-message .participant-addressee'),['→ Work · 设置','→ Codex · Local']);
  // PugPort's own last word in a subtask still translates: an outside agent's queued status and a system notice.
  assert.deepEqual(await texts(subtask('chat-grok')+' .exchange-preview'),['Handed to Grok Bot, queued…']);
  assert.deepEqual(await texts(subtask('chat-notice')+' .exchange-preview'),['Write access granted. Rerunning this request.']);
  // Who answered: a device named 设置 on PugPort's default account, an outside agent, a role named 设置 on Qwen 2, and
  // the account that reply ran on (named 设置) in its reply identity.
  assert.deepEqual(await texts('#chat-history .conversation-message .participant-heading > strong'),['设置 · Codex · Local','Muse','设置 · Qwen 2']);
  assert.deepEqual(await texts('#chat-history .reply-identity > span'),['设置 · gpt-5.5 · High']);
  // Reset-card hints and expiry countdowns read as whole sentences, with one card, hour and day said in the singular
  // (was "There are 1 reset cards（20 小时后到期）" and "Expires in 1 days").
  assert.deepEqual(await texts('#reset-hints p'),[
   "Near the usage limit. There's 1 reset card (it expires within an hour); use it in Details.",
   "Near the usage limit. There's 1 reset card (it expires in 20 hours); use it in Details.",
   'Near the usage limit. There are 2 reset cards (the earliest expires in 3 days); use one in Details.',
   "Near the usage limit. There's 1 reset card; use it in Details.",
   'Near the usage limit. There are 3 reset cards; use one in Details.',
  ]);
  assert.match(await textOf('#expiry .usage-chip'),/ Expires within a day$/);
  assert.equal(await textOf('#expiry p'),'Resets in 24 h 0 min');
  await evaluate('document.querySelectorAll("#peer-lines details.conversation-exchange, #chat-history details.conversation-exchange").forEach(node=>node.open=true)');
  await evaluate('document.getElementById("peer-lines").scrollIntoView({block:"start"})');
  await shot('written-chat-lines-light');
  await evaluate('document.getElementById("swarm-summary").scrollIntoView({block:"start"})');
  await shot('written-swarm-saved-light');
  await evaluate('document.getElementById("reset-hints").scrollIntoView({block:"center"})');
  await shot('written-reset-hints-light');
  await evaluate('document.getElementById("written").scrollIntoView({block:"start"})');
  await shot('written-text-light');
  await evaluate('document.getElementById("swarm").scrollIntoView({block:"start"})');
  await shot('written-swarm-light');
  await evaluate('document.getElementById("usage").scrollIntoView({block:"start"})');
  await shot('written-usage-light');
  // A name equal to an interface string stays as written, in a list and inside an interface sentence.
  assert.equal(await textOf('#notice .notice > span'),'Removed “设置”.');
  await click('#side-chat .toolbar-button','');
  const time=await textOf('#side-chat .side-chat-history-list time');
  assert.deepEqual(await texts('#side-chat .side-chat-history-list > button > span'),['设置 · Side chat'+time,'设置'+time]);
  await evaluate('document.querySelector("#side-chat .side-chat-history-list > button").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:40,clientY:40}))');
  await frame();
  await click('.context-menu [role=menuitem]','Delete');
  await wait('!!document.querySelector(".confirm-dialog h2")');
  assert.equal(await textOf('.confirm-dialog h2'),'Delete “设置 · Side chat”?');
  await shot('side-chat-confirm-light');
  await click('.confirm-dialog button','Cancel');
  await evaluate('document.querySelector("#trace").scrollIntoView({block:"start"})');
  await shot('names-and-progress-light');
  await evaluate('scrollTo(0,0)');
  await evaluate('document.querySelectorAll("details").forEach(node=>node.open=true)');
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('protected-text-'+theme);}
  await evaluate('document.documentElement.dataset.theme="light";document.querySelector(".trajectory-stages").scrollIntoView({block:"center"})');
  await shot('trajectory-stage-light');
  // Native status rows and the names next to interface text.
  await evaluate('[...document.querySelectorAll(".trajectory-row")].find(row=>row.textContent.includes("Process started")).scrollIntoView({block:"start"})');
  await shot('trajectory-status-rows-light');
  await evaluate('document.querySelector("#devices").scrollIntoView({block:"start"})');
  await shot('names-in-settings-light');
  for(const [id,name] of [['card-name','names-in-cards-light'],['background','names-in-tasks-light'],['taste','names-in-writing-light']]){
   await evaluate('document.getElementById('+JSON.stringify(id)+').scrollIntoView({block:"start"})');
   await shot(name);
  }
  await evaluate('scrollTo(0,0)');
  // An empty full record: the placeholder is a translatable note and no empty protected block is shown.
  await evaluate('document.getElementById("dialog").style.display="block"');
  assert.equal(await textOf('.trajectory-detail-modal > .trajectory-note'),'No further content was captured for this record.');
  assert.equal(await count('.trajectory-full-text'),0);
  await shot('empty-record-light');
  await click('#side-chat .toolbar-button','');
  await evaluate('document.getElementById("dialog").style.display="none";document.getElementById("reports").scrollIntoView({block:"start"})');
  assert.equal(await textOf('#reports .system-notice-stop'),'Stopped at step 2: 设置');
  assert.equal(await textOf('#reports .system-notice-reason > span:last-child'),'继续');
  assert.deepEqual(await texts('#reports .step-summary'),['完成','完成']);
  assert.deepEqual(await texts('#reports .claim-text'),['继续设置','继续设置']);
  assert.equal(await count('#reports li:first-child .claim-verified'),0);
  assert.equal(await count('#reports .claim-verified'),1);
  assert.equal(await count('#reports details[open]'),2);
  await click('#reports details:first-of-type > summary','');
  assert.equal(await count('#reports details[open]'),1);
  await click('#reports details:first-of-type > summary','');
  assert.equal(await count('#reports details[open]'),2);
  for(const theme of ['light','dark']){
    await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();
    const rect=await evaluate('(()=>{const r=document.getElementById("reports").getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()');
    await fs.writeFile(path.join(SCREENSHOTS,'step-reports-'+theme+'.png'),(await win.webContents.capturePage(rect)).toPNG());
  }
  assert.deepEqual(await evaluate('window.errors'),[]);
  await win.loadFile(path.join(__dirname,'index.html'),{query:{locale:'zh-TW'}});
  await wait('!!document.querySelector(".confirm-dialog h2") && !!document.querySelector("#devices .settings-row") && document.documentElement.lang==="zh-Hant"');
  assert.equal(await textOf('#notice .notice > span'),'已移除「设置」。');
  assert.equal(await textOf('.confirm-dialog h2'),'移除「设置」？');
  assert.equal(await textOf('#reports .system-notice-stop'),'停在第 2 步：设置');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#reports .claim-text")].map(node=>node.textContent.trim())'),['继续设置','继续设置']);
  // The same for a name inside an attribute (data-names): its sentence is translated, the button text still is too.
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#devices button")].filter(node=>node.textContent.includes("移除裝置")).map(node=>node.getAttribute("aria-label"))'),['移除 设置']);
  assert.deepEqual(await evaluate('window.errors'),[]);assert.deepEqual(network,[]);
  console.log('PASS protected text English');app.exit(0);
 }catch(error){console.error(error);if(win)console.error(await evaluate("document.body.textContent.slice(0,3000)").catch(()=>''));app.exit(1);}
});`.replaceAll('SCREENSHOTS', JSON.stringify(screenshots)),
    );
    const env: NodeJS.ProcessEnv = { PUGPORT_UNDER_TEST: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'XAUTHORITY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      {
        env,
        windowsHide: true,
        timeout: 75000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS protected text English/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
