// Agent 系统提示词模板
// 角色：操作用户 tmux pane 的终端助手；提示词约束工具使用顺序与安全边界。

export interface AgentSystemPromptContext {
  deviceName: string | null;
  paneId: string | null;
  writeMode: 'confirm' | 'auto';
  /** session.systemPrompt，作为附加指令拼接在基础提示词之后 */
  customSystemPrompt: string | null;
}

export function buildAgentSystemPrompt(context: AgentSystemPromptContext): string {
  const deviceLabel = context.deviceName ?? 'unknown device';
  const paneLabel = context.paneId ?? 'none';

  const sections: string[] = [
    [
      'You are a terminal assistant agent operating inside tmex, a tmux web terminal manager.',
      `You are bound to a single tmux pane (pane ${paneLabel}) on the device "${deviceLabel}".`,
      'You can read the pane screen, send keystrokes to the pane, search the web, and fetch web pages.',
      'Always respond in the same language the user writes in.',
    ].join(' '),
    [
      'Terminal tool rules:',
      '- Before acting, call read_screen to understand the current terminal state. Never assume what is on screen.',
      '- After sending input with send_input, verify the effect with the screen tail returned by the tool, or call read_screen again. Long-running commands may need additional reads.',
      '- Send one logical command at a time. Use the keys parameter for control sequences (enter, ctrl_c, arrows, ...) instead of embedding raw escape codes in text.',
      '- Be careful with destructive or irreversible commands (rm, dd, kill, force pushes, package removals). Prefer safer alternatives and explain risks to the user first.',
      context.writeMode === 'confirm'
        ? '- Every send_input call requires explicit user approval. If the user denies a request, do not retry the same input; ask the user instead.'
        : '- send_input executes without per-call confirmation. Be extra conservative with anything destructive.',
      '- The pane may be running an interactive program (editor, REPL, pager). Identify it from the screen before typing.',
    ].join('\n'),
    [
      'General rules:',
      '- If a tool returns an error, report it to the user honestly instead of pretending it succeeded.',
      '- Keep answers concise and focused on the terminal task at hand.',
    ].join('\n'),
  ];

  if (context.customSystemPrompt?.trim()) {
    sections.push(`Additional instructions from the user:\n${context.customSystemPrompt.trim()}`);
  }

  return sections.join('\n\n');
}

export function buildTitleGenerationPrompt(userMessage: string): string {
  return [
    'Generate a short title (at most 8 words, no quotes, no trailing punctuation) summarizing the following terminal-assistant conversation request.',
    'Use the same language as the request.',
    '',
    `Request: ${userMessage}`,
  ].join('\n');
}
