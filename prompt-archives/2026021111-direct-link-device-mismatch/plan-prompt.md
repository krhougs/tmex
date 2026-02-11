# Prompt Archive

## 用户问题

我又发现一个新问题，通过类似 `/devices/xxx/windows/xxx/panes/xxx` 直接进入前端，前端会匹配错设备（怀疑可能连到了数据库里第一个设备）。

## 用户补充信息

- 串设备只出现在页面刷新或者从链接冷启动前端的时候。
- URL 里的 `deviceId` 通常是对的，但实际连接行为可能错。

