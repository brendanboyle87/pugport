// Local synthetic preview. No native executor, user data, credentials or remote calls.
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const folder = resolve('reports/trajectory-preview');
await mkdir(folder, { recursive: true });
await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { TrajectoryPanel } from './src/ui/Trajectory';
import { AgentPresetDialog, AgentPresetPicker } from './src/ui/AgentPresets';
import { builtinAgentPresets, draftAgentPreset } from './src/shared/agent-presets';
import './src/ui/studio.css';
const at = (s:number)=>new Date(Date.UTC(2026,9,8,12)+s*1000).toISOString();
const longFixture=(line:string,tail:string)=>line.repeat(Math.ceil(100000/line.length)).slice(0,100000)+'\\n'+tail;
const readInput=longFixture('Synthetic Read input paragraph. No file is opened.\\n','SYNTHETIC_READ_INPUT_TAIL');
const readOutput=longFixture('Synthetic Read result paragraph. No command was executed.\\n','SYNTHETIC_READ_RESULT_TAIL');
const executionPrompt='合成 PugPort 执行提示词：仅用于本地界面预览。检查虚构配置并向虚构子任务发出核验请求，不读取用户数据、不执行命令、不调用模型。\\n工具范围：合成 Read 与合成核验。结果用于验证长文本详情窗口。\\nSYNTHETIC_APP_PROMPT_TAIL';
const main:any={id:'preview-main',workflowId:'preview-workflow',prompt:'Synthetic older prompt snapshot (superseded by recorded execution context)',projectPath:'C:/Fixture',kind:'routine',status:'completed',startedAt:at(0),endedAt:at(24),output:'已读取合成项目配置，发现一项合成检查失败，后续合成核验通过。所有数据均为示例，未执行真实任务。',auditVersion:1,eventsDropped:0,agentPreset:{id:'code-review',name:'代码审查'},route:{runtimeId:'fixture',model:'fixture',effort:'medium',kind:'routine',reasons:['Synthetic route: local preview fixture only'],warnings:['Synthetic data; no runtime or model is invoked']},events:[
{seq:1,at:at(0.1),type:'status',text:'合成应用执行上下文',data:{source:'pugport',kind:'execution-context',detail:{prompt:executionPrompt,permissionMode:'read-only',approvalMode:'ask',skills:['synthetic-read'],nativeSystemPrompt:'not-reported'}}},
{seq:2,at:at(0.2),type:'status',text:'合成路由决定',data:{source:'pugport',kind:'routing',detail:{runtimeId:'fixture',model:'fixture',effort:'medium',reasons:['合成示例：只使用页面内固定数据'],warnings:['没有模型调用、真实文件访问或命令执行']}}},
{seq:3,at:at(0.3),type:'status',text:'合成子任务指派',data:{source:'pugport',kind:'communication',detail:{messageId:'synthetic-assignment',fromRunId:'preview-main',toRunId:'preview-child',text:'合成指派：核验虚构配置并报告结果。',status:'delivered'}}},
{seq:4,at:at(1),type:'status',text:'开始读取合成项目配置'},
{seq:5,at:at(2),type:'tool',text:'Read synthetic config',data:{source:'native',toolCallId:'a',tool:'Read',status:'started',input:{path:'synthetic-package.json',text:readInput}}},
{seq:6,at:at(2.1),type:'tool',data:{source:'pugport',kind:'pugportToolCall',toolCallId:'bridge:synthetic-read',nativeToolCallId:'a',tool:'Read',status:'started',arguments:{path:'synthetic-package.json',fixture:'Synthetic bridge call with an explicit native link'},handler:'synthetic-file-reader',origin:'local-preview-fixture'}},
{seq:7,at:at(2.2),type:'status',text:'合成内部读取阶段开始',data:{source:'pugport',kind:'internal-step',parentToolCallId:'bridge:synthetic-read',stepId:'synthetic-read-step',detail:{name:'read-fixture',label:'读取页面内合成文字',status:'started',detail:'No disk read; text already exists in this fixture.'}}},
{seq:8,at:at(3.5),type:'status',text:'合成内部读取阶段完成',data:{source:'pugport',kind:'internal-step',parentToolCallId:'bridge:synthetic-read',stepId:'synthetic-read-step',detail:{name:'read-fixture',label:'读取页面内合成文字',status:'completed',detail:{characters:readOutput.length,fixture:true}}}},
{seq:9,at:at(3.8),type:'tool',data:{source:'pugport',kind:'pugportToolCall',toolCallId:'bridge:synthetic-read',nativeToolCallId:'a',tool:'Read',status:'completed',result:'Synthetic bridge result; complete native result appears alongside this record.',steps:[{name:'read-fixture',status:'completed'}],journal:[{path:'synthetic-package.json',action:'synthetic-read-only'}],moved:[]}},
{seq:10,at:at(4),type:'tool',data:{source:'native',toolCallId:'a',tool:'Read',status:'completed',output:readOutput}},
{seq:11,at:at(5),type:'text',text:'已读取合成配置，正在检查合成验证结果。'},
{seq:12,at:at(8),type:'tool',data:{source:'native',toolCallId:'b',tool:'Run checks',status:'started',command:'synthetic-check --scope fixture'}},
{seq:13,at:at(12),type:'tool',data:{source:'native',toolCallId:'b',tool:'Run checks',status:'completed',exitCode:1,detail:'Synthetic assertion failed; no real process was run.'}},
{seq:14,at:at(13),type:'error',text:'一次合成检查未通过'},
{seq:15,at:at(15),type:'tool',data:{source:'native',toolCallId:'c',tool:'Verify result',status:'started'}},
{seq:16,at:at(21),type:'status',text:'合成子任务回复',data:{source:'pugport',kind:'communication',detail:{messageId:'synthetic-child-reply',fromRunId:'preview-child',toRunId:'preview-main',text:'合成子任务已完成核验：虚构配置符合预设示例。',status:'received'}}},
{seq:17,at:at(22),type:'tool',data:{source:'native',toolCallId:'c',tool:'Verify result',status:'completed',output:'Synthetic verification passed'}},
{seq:18,at:at(24),type:'usage',data:{inputTokens:1200,outputTokens:240,totalTokens:1440}}
]};
function Preview(){
const [role,setRole]=useState('code-review'),[presets,setPresets]=useState<any[]>([...builtinAgentPresets]),[manage,setManage]=useState(false),[notice,setNotice]=useState(''),[run,setRun]=useState(main);
const child={...main,id:'preview-child',parentRunId:'preview-main',workflowId:'preview-workflow',prompt:'Synthetic child',output:'子任务合成核验已完成。',events:[]};
const api=async(path:string,body:any,method:string)=>{if(path.endsWith('/draft'))return {draft:draftAgentPreset(body.description)};if(method==='DELETE'){setPresets(p=>p.filter(item=>item.id!==path.split('/').pop()));return {ok:true}}const preset={...body,id:method==='PUT'?path.split('/').pop():'preview-custom'};setPresets(p=>[...p.filter(item=>item.id!==preset.id),preset]);return {preset}};
return <main style={{maxWidth:1000,margin:'32px auto',padding:24}}><p style={{color:'var(--muted)',marginBottom:20}}>PugPort · 功能验证 · 合成记录，不产生模型用量</p><div className="composer-controls" style={{marginBottom:24}}><AgentPresetPicker value={role} presets={presets} onChange={setRole} onManage={()=>setManage(true)}/><span role="status">{notice}</span></div><TrajectoryPanel run={run} userInput="检查这个项目，说明实际问题并核验结果。" relatedRuns={[main,child]} onInspectRun={id=>setRun(id===child.id?child:main)}/>{manage&&<AgentPresetDialog presets={presets} api={api as any} notify={v=>setNotice(v.message)} onClose={()=>setManage(false)} onSaved={p=>p&&setRole(p.id)}/>}</main>}
document.documentElement.dataset.theme='dark';createRoot(document.getElementById('root')!).render(<Preview/>);
`,
  },
  bundle: true,
  outfile: resolve(folder, 'preview.js'),
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
});
if (process.argv.includes('--build-only')) process.exit(0);
const html =
  '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PugPort feature preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>';
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  const asset = req.url === '/preview.js' ? 'preview.js' : req.url === '/preview.css' ? 'preview.css' : undefined;
  if (!asset) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : 'text/javascript');
  res.end(await readFile(resolve(folder, asset)));
});
server.listen(0, '127.0.0.1', () => console.log('PREVIEW_URL=http://127.0.0.1:' + server.address().port + '/'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
