# Prompt Archive：enter echo newline semantic

## User Prompt 00

没有修复成功，给你个栗子:
```
krhougs@dev ~/tmex$ 111                                                                                                 ✹ ✭main 
111zsh: command not found: 111
```

## 分析结论

- 该样例更符合“回车后输出以 LF 续行但未回到行首”的换行语义问题，而非单纯双发。
- 需要同时在后端 `%output/%extended-output` 输出处理和前端实时写入链路做一致性修复。
