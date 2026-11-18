/** UI-language guidance is delivered to the executor, never saved as the user's message. */
export const chineseSteeringPrompt = (content: string) =>
  `${content}\n\n回复语言：按照应用界面语言，面向用户的解释、分析和提问必须用简体中文写（文件名、路径、代码、命令保持原样）；不要因上下文或工具输出改用其他语言。用户要发送或发布给他人的文本（回复邮件、消息、帖子、评论、求职信等）按原始材料或收件人的语言起草，除非用户指定草稿语言；收件人不明确时按原始消息的语言，英文邮件或截图应给出英文草稿。`;
