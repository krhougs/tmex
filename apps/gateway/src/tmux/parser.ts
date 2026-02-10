/**
 * tmux -CC 控制模式协议解析器
 * 
 * tmux -CC 输出格式：
 * - %window-add <id>
 * - %window-close <id>
 * - %window-renamed <id> <name>
 * - %pane-mode-changed <id>
 * - %pane-close <id>
 * - %session-changed <id> <name>
 * - %sessions-changed
 * - %layout-change <window-id> <layout>
 * - %output <pane-id> <data>
 * - %bell <window-id>
 * - ... 等等
 * 
 * 同时会输出普通终端数据（直接发送到 pane）
 */

import type { TmuxWindow, TmuxPane, TmuxSession, TmuxEventType } from '@tmex/shared';

export interface TmuxEvent {
  type: TmuxEventType;
  data: unknown;
}

export class TmuxControlParser {
  private buffer = '';
  private onEvent: (event: TmuxEvent) => void;
  private onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  
  constructor(
    onEvent: (event: TmuxEvent) => void,
    onTerminalOutput: (paneId: string, data: Uint8Array) => void
  ) {
    this.onEvent = onEvent;
    this.onTerminalOutput = onTerminalOutput;
  }
  
  /**
   * 处理从 tmux -CC 接收到的数据
   */
  processData(data: Uint8Array | string): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.buffer += text;
    this.parseBuffer();
  }
  
  private parseBuffer(): void {
    // tmux -CC 输出以 \n 或 \r\n 结束
    while (true) {
      const nlIndex = this.buffer.indexOf('\n');
      if (nlIndex === -1) break;
      
      const line = this.buffer.slice(0, nlIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nlIndex + 1);
      
      this.parseLine(line);
    }
  }
  
  private parseLine(line: string): void {
    // 忽略空行
    if (!line.trim()) return;
    
    // 检查是否以 % 开头（tmux 控制序列）
    if (line.startsWith('%')) {
      this.parseControlLine(line);
    } else {
      // 普通输出（可能是未解析的 pane 输出）
      // 在 -CC 模式下，大部分输出应该通过 %output 传递
      // 这里可能是错误信息或其他输出
      console.log('[tmux] non-control output:', line);
    }
  }
  
  private parseControlLine(line: string): void {
    // 解析格式: %command args...
    const spaceIndex = line.indexOf(' ');
    const command = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);
    
    switch (command) {
      case '%window-add':
        this.onEvent({ type: 'window-add', data: { windowId: args } });
        break;
        
      case '%window-close':
        this.onEvent({ type: 'window-close', data: { windowId: args } });
        break;
        
      case '%window-renamed': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'window-renamed',
          data: { windowId: parts[0], name: parts[1] },
        });
        break;
      }
      
      case '%pane-close':
        this.onEvent({ type: 'pane-close', data: { paneId: args } });
        break;
        
      case '%pane-mode-changed':
        // Pane 模式变化（如进入/退出复制模式）
        break;
        
      case '%session-changed': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'window-add', // 映射到 window-add 或创建新类型
          data: { sessionId: parts[0], name: parts[1] },
        });
        break;
      }
      
      case '%sessions-changed':
        // 会话列表变化
        break;
        
      case '%layout-change': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'layout-change',
          data: { windowId: parts[0], layout: parts[1] },
        });
        break;
      }
      
      case '%output': {
        // 格式: %output <pane-id> <base64-data>
        const firstSpace = args.indexOf(' ');
        if (firstSpace !== -1) {
          const paneId = args.slice(0, firstSpace);
          const base64Data = args.slice(firstSpace + 1);
          try {
            const data = Buffer.from(base64Data, 'base64');
            this.onTerminalOutput(paneId, new Uint8Array(data));
          } catch {
            console.error('[tmux] failed to decode output for pane', paneId);
          }
        }
        break;
      }
      
      case '%bell':
        this.onEvent({ type: 'bell', data: { windowId: args } });
        break;
        
      case '%extended-output':
        // 扩展输出（包含更多元数据）
        break;
        
      case '%pause':
      case '%resume':
        // 暂停/恢复输出
        break;
        
      case '%exit':
        this.onEvent({ type: 'pane-close', data: { reason: 'exit', message: args } });
        break;
        
      default:
        // 忽略未知的控制序列（包括 iTerm2 相关的 Window Position 等）
        if (this.isITerm2Sequence(command)) {
          console.log('[tmux] ignoring iTerm2 sequence:', command);
        } else {
          console.log('[tmux] unknown control sequence:', command, args);
        }
    }
  }
  
  /**
   * 解析带引号的参数
   * 支持格式: arg1 "arg with spaces" arg3
   */
  private parseArgs(args: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < args.length; i++) {
      const char = args[i];
      
      if (char === '"' && args[i - 1] !== '\\') {
        inQuotes = !inQuotes;
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          result.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    
    if (current) {
      result.push(current);
    }
    
    return result;
  }
  
  /**
   * 检测 iTerm2 专有控制序列
   * 这些序列包含窗口位置等信息，应该被忽略
   */
  private isITerm2Sequence(command: string): boolean {
    const iTerm2Prefixes = [
      '%begin',      // iTerm2 响应开始
      '%end',        // iTerm2 响应结束
      '%error',      // iTerm2 错误
      '%notify',     // iTerm2 通知
      '%noop',       // iTerm2 空操作
      '%window-pane-changed',
      '%client-session-changed',
      '%pane-title-changed',
    ];
    
    return iTerm2Prefixes.some(prefix => command.startsWith(prefix));
  }
  
  /**
   * 清空缓冲区
   */
  flush(): void {
    if (this.buffer) {
      console.log('[tmux] flushing remaining buffer:', this.buffer);
      this.buffer = '';
    }
  }
}
