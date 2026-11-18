export type PlanningDecision = { strategy: 'direct' | 'native' | 'model' | 'resume'; reason: string };

const noToolsClause = String.raw`(?:(?:不|不要|无需)(?:调用|使用)工具(?:[，,]\s*(?:不|不要|无需)读取文件)?|(?:do not|don't) use (?:any )?tools(?: or read files)?)[。.!]?$`;
const noToolsRestriction = new RegExp(`[。.!，,]\\s*${noToolsClause}`, 'iu');
const noToolsReplyRestriction = new RegExp(`([。.!，,？?])\\s*${noToolsClause}`, 'iu');

/** Complete, self-contained speech requests only; short follow-ups still need their context. */
export function isSelfContainedChat(content: string, options: { explicitNoTools?: boolean } = {}): boolean {
  const original = content.trim();
  const text = original.replace(noToolsRestriction, '').trim();
  if (options.explicitNoTools && text === original) return false;
  if (
    /^(?:(?:hello|hi|hey)(?: there)?|good (?:morning|afternoon|evening)|你好|您好|嗨|哈喽|早上好|下午好|晚上好|谢谢|thanks|thank you)[！!。.,，\s]*$/iu.test(
      text,
    )
  )
    return true;
  if (
    /^(?:(?:你好|您好|嗨)[，,]\s*)?(?:请)?(?:只)?(?:回复一(?:句|声)(?:简短的?)?(?:问候|问候语)|打个招呼)[。.!！]?$/u.test(
      text,
    )
  )
    return true;
  if (/^(?:please\s+)?(?:just\s+)?(?:say (?:hello|hi)|greet me)(?: briefly)?[.!]?$/iu.test(text)) return true;
  const literal = '(?:"[^"\\r\\n]{1,200}"|“[^”\\r\\n]{1,200}”|\'[^\'\\r\\n]{1,200}\'|`[^`\\r\\n]{1,200}`)';
  return (
    new RegExp(
      `^(?:please\\s+)?(?:(?:just|only)\\s+)?(?:say|echo|repeat|reply(?:\\s+with)?)(?:\\s+(?:exactly|only))?\\s*:?[ \\t]*${literal}[.!]?$`,
      'iu',
    ).test(text) ||
    new RegExp(
      `^(?:请|再)?(?:只|仅)(?:回复|回答|说)(?:[：:]?\\s*${literal}|[一二两三四五六七八九十0-9]+个?字[：:]\\s*(?:收到|好的|你好|您好|谢谢|OK|okay|hi|hello|ack|pong))[。.!]?$`,
      'iu',
    ).test(text)
  );
}

/** Conversation recall may need earlier text without needing any execution tools. */
export function isExplicitNoToolsChat(content: string): boolean {
  const original = content.trim();
  const text = original.replace(noToolsReplyRestriction, '$1').trim();
  if (text === original) return false;
  if (isSelfContainedChat(content)) return true;
  // Match complete speech-only requests; an unknown operation keeps the ordinary tool policy.
  const prior = '(?:刚才|之前|上一(?:条|句)(?:消息)?(?:里|中)?)';
  const words = '(?:[一二两三四五六七八九十0-9]{1,3}个?字|句(?:话)?)';
  return (
    new RegExp(
      `^${prior}(?:我(?:让你(?:回复|回答|说)|说|问)|你(?:说|回复|回答))(?:了)?(?:什么|哪${words})[？?](?:\\s*(?:请)?(?:只|仅)(?:回复|回答|重复)(?:那|这)${words}[。.!！]?)?$`,
      'u',
    ).test(text) ||
    new RegExp(
      `^(?:请)?(?:只|仅)(?:重复|复述|回复)${prior}(?:我|你)(?:说|回复|回答)(?:过)?的(?:话|内容)[。.!！]?$`,
      'u',
    ).test(text) ||
    /^(?:please\s+)?(?:(?:only|just)\s+)?(?:repeat|echo) what (?:I|you) said in (?:my|your|the) (?:previous|last) message[.!]?$/iu.test(
      text,
    ) ||
    /^what did (?:I|you)(?: ask (?:you|me) to)? say in (?:my|your|the) (?:previous|last) message\?$/iu.test(text)
  );
}

// This saves one planning call for a small allowlist. It grants no execution permission.
// A false negative is preferable to guessing that an ambiguous request is a single edit.
const highRisk =
  /\b(?:security|auth(?:entication|orization)?|oauth|login|password|secret|credential|permission|encrypt\w*|cryptograph\w*|migration|database|schema|production|deploy\w*|publish\w*|payment|billing|purchase|install\w*|dependency|dependencies|concurren\w*|architect\w*|refactor\w*|redesign|rewrite|recursive|delete|remove|api|protocol|performance|logic|behavio[ur])\b|架构|重构|并发|数据库|迁移|认证|鉴权|授权|权限|安全|加密|密码|密钥|凭据|生产环境|部署|发布|购买|付款|依赖|安装|接口|协议|删除|递归|重写|行为|业务逻辑/iu;
// One operation after another: work worth splitting, whatever it is.
const severalSteps = /\b(?:and|then|also|after|before)\b|然后|同时|顺便|以及|并且/iu;
// A request to change files or run something, in broad strokes. Anything it matches keeps the cautious rules below;
// a miss only saves a planning call, so the list errs on the side of matching.
const changeRequest =
  /\b(?:format|fix|correct|rename|change|edit|modif\w*|update|rewrite|write|creat\w*|add|insert|append|remove|delete|move|copy|refactor|implement|build|patch|migrat\w*|extract|unzip|install|uninstall|replace|convert|merge|generat\w*|make|apply|commit|push|deploy|publish|release|revert|reset|clean\w*|organi[sz]e|sort|save|set\s?up|configur\w*|run|execute|upgrade)\b|格式化|修|改|重命名|写入|编写|创建|新建|搭建|添加|加上|加入|增加|删|移动|移到|复制|拷贝|重构|实现|开发|整理|分类|去重|替换|转换|合并|生成|安装|卸载|解压|压缩|提交|推送|部署|发布|回滚|还原|清理|保存|设置|配置|运行|执行|升级/iu;
// Wording that widens a change or leaves its scope open. A question mark, a second line, an "if" or an "all" says
// nothing about a request that changes no files, so this is checked only for requests that do.
const openScope =
  /[\r\n;；!?！？]|\b(?:or|maybe|perhaps|if|except|unless|whatever|everything|entire|all|across)\b|再|或者|可能|如果|整个|全部|所有|相关|随便|看情况|尽量|之类|等等/iu;
const pathPattern =
  '[\\p{L}\\p{N}_@-][\\p{L}\\p{N}_@.\\/-]*\\.(?:md|txt|rst|ts|tsx|js|jsx|css|scss|html|json|yaml|yml|py|go|rs|java|c|cpp|h|cs|svelte|vue)';
const wordPattern = '[\\p{L}\\p{N}_$-]{1,60}';
const identifierPattern = '[A-Za-z_$][A-Za-z0-9_$]{0,60}';
const quoted = (name: string, pattern: string) => `(?<${name}Quote>[\x60"']?)(?<${name}>${pattern})\\k<${name}Quote>`;
const file = (name = 'file') => quoted(name, pathPattern);
const word = (name: string) => quoted(name, wordPattern);
const identifier = (name: string) => quoted(name, identifierPattern);
const match = (text: string, expression: string) => new RegExp(`^(?:${expression})[。.]?$`, 'iu').exec(text)?.groups;

const lookupWord = '[\\p{L}\\p{N}_$-]+';
const lookupPath = '(?:[A-Za-z]:)?/?[\\p{L}\\p{N}_@.-]+(?:/[\\p{L}\\p{N}_@.-]+)*\\.[a-z][a-z0-9]{0,11}';
const lookupQuoted = (value: string) => `(?:\\x60${value}\\x60|"${value}"|'${value}'|${value})`;
const lookupNoun = '(?:files?|paths?|docs?|documents?|logs?|text|symbols?|director(?:y|ies)|folders?)';
const lookupObject = `(?:(?:the|a|an|this|these|those|all|our|my)\\s+)?(?:(?:named|specified|requested)\\s+)?(?:${lookupWord}\\s+)?${lookupNoun}(?:\\s+(?:paths?|names?|contents?))?`;
const lookupQuery = `(?:\\x60[^\\x60\\r\\n]{1,120}\\x60|"[^"\\r\\n]{1,120}"|'[^'\\r\\n]{1,120}'|(?:the\\s+)?${lookupWord})`;
const englishLookup = new RegExp(
  `^(?:(?:please|just|only)\\s+)*(?:(?:can|could|would)\\s+you\\s+(?:please\\s+)?)?` +
    `(?:find|locate|lookup|look up|search(?:\\s+for)?|list|read)\\s+` +
    `(?:${lookupQuoted(lookupPath)}|${lookupObject})` +
    `(?:\\s+(?:that\\s+)?(?:mention|contain|match|include|named|called)\\s+${lookupQuery})?` +
    `(?:\\s+(?:in|under|inside|within)\\s+${lookupQuoted('[\\p{L}\\p{N}_@./:-]+')})?` +
    `(?:\\s+and\\s+(?:list|show|return)\\s+(?:their|the|its)\\s+(?:(?:file\\s+)?paths?|names?|locations?))?[.?!]?$`,
  'iu',
);
const chineseLookupNoun = '(?:日志文件|文本文件|文件路径|文件夹|文件|路径|文档|日志|文本|符号|目录)';
const chineseLookupTopic = `(?:(?!${chineseLookupNoun}|并(?!发)|然后|接着|同时|顺便|以及|再)[\\p{L}\\p{N}_-]){1,40}`;
const chineseLookup = new RegExp(
  `^(?:(?:请你|请|帮我|替我|麻烦你|你|先|只读|只|仅)\\s*)*` +
    `(?:查找|找出|找一下|找|检索|搜索|定位|列出|读取|查看)\\s*` +
    `(?:${lookupQuoted(lookupPath)}(?:\\s*在哪个(?:文件夹|目录)(?:里|中)?)?|` +
    `(?:(?:这个|该|当前|文档|项目)?(?:目录|文件夹)(?:里|中)的)?(?:${chineseLookupTopic})?${chineseLookupNoun})` +
    `(?:\\s*并\\s*(?:返回|列出|显示)\\s*(?:其|它的|对应的)?(?:文件路径|路径|文件名|位置))?[。？！?!.]?$`,
  'iu',
);

/** A single retrieval request, not analysis or a change, even when its file name mentions a complex subject. */
export function isSimpleFileLookup(content: string): boolean {
  const text = content.trim().replaceAll('\\', '/');
  // Match the complete retrieval grammar; an unfamiliar trailing operation stays with normal classification.
  return text.length < 500 && !/[\r\n]/u.test(text) && (englishLookup.test(text) || chineseLookup.test(text));
}

function boundedFile(path: string): boolean {
  // Limit the shortcut to explicit relative source/document files, not folders, globs, or settings.
  return (
    !path.split('/').some((segment) => segment === '..' || segment === '.') &&
    !/(?:^|\/)(?:package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|[^/]*(?:lock|config|credential|secret|auth|migration)[^/]*)$/iu.test(
      path,
    )
  );
}

export function choosePlanningStrategy(
  content: string,
  options: { nativeCli?: boolean; selectedExecutor?: boolean; plan?: boolean } = {},
): PlanningDecision {
  const text = content.trim().replaceAll('\\', '/');
  const model = (reason: string): PlanningDecision =>
    options.nativeCli
      ? {
          strategy: 'native',
          reason: '由已选择的原生 CLI 在同一会话中规划、执行并验证，省去独立规划调用；当前权限与验收要求保持不变。',
        }
      : options.selectedExecutor
        ? {
            strategy: 'direct',
            reason: '由已选择的执行器在同一会话中安排步骤并完成任务，省去独立规划调用；当前权限与验收要求保持不变。',
          }
        : { strategy: 'model', reason: `${reason}，使用模型规划。` };
  if (options.plan !== undefined)
    return options.nativeCli || options.selectedExecutor || options.plan
      ? model('Laya')
      : { strategy: 'direct', reason: 'Laya: no dependent execution steps' };
  if (isSimpleFileLookup(text))
    return {
      strategy: 'direct',
      reason: '本地规则识别为单项文件检索或读取，省去独立规划调用；执行权限、审批和验收流程保持不变。',
    };
  if (!text || text.length > 300) return model('本地规则无法确认需求只有一项有限范围的改动');
  if (highRisk.test(text)) return model('需求涉及风险敏感内容或结构性改动');
  if (severalSteps.test(text)) return model('需求包含多项操作、条件或不明确的范围');

  const direct = (operation: string): PlanningDecision => ({
    strategy: 'direct',
    reason: `本地规则识别为${operation}，省去独立规划调用；执行权限、审批和验收流程保持不变。`,
  });
  // Planning splits and checks changes. A short request that changes nothing (a question that reached task
  // handling, a lookup, a summary) has nothing to split: the planner returned one step or none for 18 of 24 such
  // messages, after a median 29 s on a strong model. A chosen executor plans in its own session either way.
  if (!options.nativeCli && !options.selectedExecutor && !changeRequest.test(text)) return direct('不改动文件的短需求');
  if (openScope.test(text)) return model('需求包含多项操作、条件或不明确的范围');
  const prefix = '(?:(?:please|just|only)\\s+)*';
  const format =
    match(
      text,
      `${prefix}format\\s+${file()}(?:\\s+(?:using|with)\\s+(?:the\\s+)?(?:existing\\s+)?(?:project\\s+)?formatter)?`,
    ) || match(text, `(?:请|仅|只)?格式化\\s*${file()}(?:[，,]\\s*使用项目现有格式配置)?`);
  if (format && boundedFile(format.file!)) return direct('单文件格式化');

  const typo =
    match(
      text,
      `${prefix}(?:fix|correct)\\s+(?:the\\s+)?(?:typo|spelling(?:\\s+error)?)\\s+${word('from')}\\s+(?:to|->)\\s+${word('to')}\\s+in\\s+${file()}`,
    ) ||
    match(
      text,
      `(?:请)?(?:把|将)\\s*${file()}\\s*中的(?:拼写错误|错别字)\\s*${word('from')}\\s*(?:改为|改成|更正为)\\s*${word('to')}`,
    ) ||
    match(
      text,
      `(?:请)?(?:修正|更正)\\s*${file()}\\s*中的(?:拼写错误|错别字)[：:]\\s*(?:将|把)\\s*${word('from')}\\s*(?:改为|改成|更正为)\\s*${word('to')}`,
    );
  if (typo && typo.from !== typo.to && boundedFile(typo.file!)) return direct('单文件中明确的拼写替换');

  const renameVariable =
    match(
      text,
      `${prefix}rename\\s+(?:the\\s+)?variable\\s+${identifier('from')}\\s+to\\s+${identifier('to')}\\s+in\\s+${file()}`,
    ) ||
    match(
      text,
      `(?:请)?(?:把|将)\\s*${file()}\\s*中的变量\\s*${identifier('from')}\\s*(?:重命名为|改名为)\\s*${identifier('to')}`,
    );
  if (renameVariable && renameVariable.from !== renameVariable.to && boundedFile(renameVariable.file!))
    return direct('单文件中明确的变量改名');

  const renameFile =
    match(text, `${prefix}rename\\s+(?:the\\s+)?(?:file\\s+)?${file('from')}\\s+to\\s+${file('to')}`) ||
    match(text, `(?:请)?(?:把|将)\\s*${file('from')}\\s*(?:重命名为|改名为)\\s*${file('to')}`);
  if (renameFile && renameFile.from !== renameFile.to && boundedFile(renameFile.from!) && boundedFile(renameFile.to!)) {
    const directory = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
    const extension = (path: string) => path.slice(path.lastIndexOf('.')).toLowerCase();
    if (
      directory(renameFile.from!) === directory(renameFile.to!) &&
      extension(renameFile.from!) === extension(renameFile.to!)
    )
      return direct('同一目录内明确的单文件改名');
  }
  return model('本地规则未确认单项、目标明确的改动');
}
