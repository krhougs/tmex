import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useUIStore } from '../stores/ui';
import type { WsMessage, EventTmuxPayload, EventDevicePayload } from '@tmex/shared';

export function DevicePage() {
  const { deviceId, windowId, paneId } = useParams();
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const { inputMode, addEditorHistory } = useUIStore();
  const [editorText, setEditorText] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  
  // 检测设备类型
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || 'ontouchstart' in window);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  
  // 初始化终端
  useEffect(() => {
    if (!terminalRef.current) return;
    
    const term = new Terminal({
      fontFamily: 'SF Mono, Monaco, Inconsolata, "Fira Code", monospace',
      fontSize: 14,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#c9d1d9',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
      },
      cursorBlink: true,
      allowProposedApi: true,
    });
    
    const fit = new FitAddon();
    term.loadAddon(fit);
    
    term.open(terminalRef.current);
    fit.fit();
    
    terminal.current = term;
    fitAddon.current = fit;
    
    return () => {
      term.dispose();
    };
  }, []);
  
  // WebSocket 连接
  useEffect(() => {
    if (!deviceId) return;
    
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
      console.log('[ws] connected');
      setIsConnecting(false);
      setError(null);
      
      // 连接设备
      socket.send(JSON.stringify({
        type: 'device/connect',
        payload: { deviceId },
      }));
    };
    
    socket.onmessage = (event) => {
      if (event.data instanceof Blob) {
        // 二进制数据（终端输出）
        handleBinaryMessage(event.data);
      } else {
        // JSON 消息
        try {
          const msg = JSON.parse(event.data) as WsMessage<unknown>;
          handleJsonMessage(msg);
        } catch {
          console.error('[ws] failed to parse message');
        }
      }
    };
    
    socket.onerror = () => {
      setError('连接失败');
    };
    
    socket.onclose = () => {
      setError('连接已断开');
    };
    
    ws.current = socket;
    
    return () => {
      socket.close();
    };
  }, [deviceId]);
  
  // 处理二进制消息（终端输出）
  const handleBinaryMessage = async (blob: Blob) => {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    
    if (data[0] === 0x01) {
      // 终端输出
      const paneIdLen = (data[1] << 8) | data[2];
      const outputPaneId = new TextDecoder().decode(data.slice(3, 3 + paneIdLen));
      const output = data.slice(3 + paneIdLen);
      
      // 如果当前选中的 pane 匹配，显示输出
      if (outputPaneId === paneId || true) { // 暂时显示所有输出
        terminal.current?.write(output);
      }
    }
  };
  
  // 处理 JSON 消息
  const handleJsonMessage = (msg: WsMessage<unknown>) => {
    switch (msg.type) {
      case 'device/connected':
        // 选择默认 pane
        if (windowId && paneId) {
          ws.current?.send(JSON.stringify({
            type: 'tmux/select',
            payload: { deviceId, windowId, paneId },
          }));
        }
        break;
        
      case 'event/tmux':
        handleTmuxEvent(msg.payload as EventTmuxPayload);
        break;
        
      case 'event/device':
        handleDeviceEvent(msg.payload as EventDevicePayload);
        break;
        
      case 'state/snapshot':
        // 处理状态快照
        break;
    }
  };
  
  const handleTmuxEvent = (event: EventTmuxPayload) => {
    console.log('[tmux]', event);
    // 可以根据事件更新 UI
  };
  
  const handleDeviceEvent = (event: EventDevicePayload) => {
    console.log('[device]', event);
    if (event.type === 'error') {
      setError(event.message || '设备错误');
    }
  };
  
  // 终端输入处理
  useEffect(() => {
    const term = terminal.current;
    const socket = ws.current;
    if (!term || !socket) return;
    
    const disposable = term.onData((data) => {
      if (inputMode === 'direct' && !isComposing) {
        sendInput(data);
      }
    });
    
    return () => {
      disposable.dispose();
    };
  }, [inputMode, isComposing, paneId, deviceId]);
  
  // 窗口大小变化
  useEffect(() => {
    const handleResize = () => {
      fitAddon.current?.fit();
      
      const dims = terminal.current?.cols;
      if (dims && ws.current && paneId) {
        const rows = terminal.current?.rows ?? 24;
        ws.current.send(JSON.stringify({
          type: 'term/resize',
          payload: {
            deviceId,
            paneId,
            cols: dims,
            rows,
          },
        }));
      }
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [deviceId, paneId]);
  
  const sendInput = (data: string) => {
    if (!ws.current || !deviceId || !paneId) return;
    
    ws.current.send(JSON.stringify({
      type: 'term/input',
      payload: {
        deviceId,
        paneId,
        data,
        isComposing: false,
      },
    }));
  };
  
  const handleEditorSend = () => {
    if (!editorText.trim()) return;
    
    sendInput(editorText);
    addEditorHistory(editorText);
    setEditorText('');
  };
  
  const handleEditorSendLineByLine = () => {
    const lines = editorText.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        sendInput(line + '\r');
      }
    }
    addEditorHistory(editorText);
    setEditorText('');
  };
  
  if (!deviceId) {
    return <div className="p-6">未选择设备</div>;
  }
  
  return (
    <div className="flex flex-col h-full">
      {/* 状态栏 */}
      <div className="flex items-center justify-between px-4 py-2 bg-bg-secondary border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">设备: {deviceId}</span>
          {windowId && <span className="text-sm text-text-secondary">/ 窗口: {windowId}</span>}
          {paneId && <span className="text-sm text-text-secondary">/ Pane: {paneId}</span>}
        </div>
        
        {isMobile && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => useUIStore.setState({ inputMode: inputMode === 'direct' ? 'editor' : 'direct' })}
              className="btn btn-sm"
            >
              {inputMode === 'direct' ? '编辑器模式' : '直接输入'}
            </button>
          </div>
        )}
        
        {error && (
          <div className="text-danger text-sm">{error}</div>
        )}
      </div>
      
      {/* 终端 */}
      <div className="flex-1 relative overflow-hidden">
        <div ref={terminalRef} className="absolute inset-0" />
        
        {isConnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="text-text-secondary">连接中...</div>
          </div>
        )}
      </div>
      
      {/* 编辑器模式输入框 */}
      {isMobile && inputMode === 'editor' && (
        <div className="editor-mode-input">
          <textarea
            value={editorText}
            onChange={(e) => setEditorText(e.target.value)}
            placeholder="在此输入命令..."
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
          />
          <div className="actions">
            <button onClick={() => setEditorText('')} className="btn btn-sm">
              清空
            </button>
            <button onClick={handleEditorSendLineByLine} className="btn btn-sm">
              逐行发送
            </button>
            <button onClick={handleEditorSend} className="btn btn-primary btn-sm">
              发送
            </button>
          </div>
        </div>
      )}
      
      {/* 移动端直接输入的组合态保护 */}
      {isMobile && inputMode === 'direct' && (
        <input
          type="text"
          className="sr-only"
          aria-hidden="true"
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(e) => {
            setIsComposing(false);
            sendInput((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      )}
    </div>
  );
}
