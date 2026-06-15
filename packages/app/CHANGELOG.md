# 0.12.0

_2026-06-15_

## English

### New

- Files: the file tree now has a right-click / long-press menu, and large files transfer with live progress, speed, and a cancel button (up to 2 GB).
- Files: dragging a file to your desktop now shows a brief notification once the download finishes.

### Improvements

- Files: better transfer feedback — a two-stage progress bar, dark-theme support, file sizes shown in the menu, and human-readable sizes in the preview.
- This changelog is now bilingual (English first, then Chinese).

### Fixes

- Terminal: fixed inconsistent line height across platforms and glyphs being clipped at the top or bottom.
- SSH: fixed connections that authenticate via an SSH config reference, and now show the real error when a connection fails.
- Files: fixed some downloads failing with a 500 error.
- Notifications: fixed pane links in Telegram messages failing to open because they were double-encoded.

---

## 中文

### 新增

- 文件浏览：文件树新增右键 / 长按菜单，大文件传输支持实时进度、速度与取消（最大 2GB）。
- 文件浏览：把文件拖到桌面，下载完成后会有一条轻提示。

### 改进

- 文件浏览：传输反馈更完善——两段式进度条、跟随暗色主题、菜单显示文件大小、预览大小以人类可读格式展示。
- 更新日志现在提供中英双语（先英文、后中文）。

### 修复

- 终端：修复文字行高在不同平台不一致、字形顶部或底部被裁切的问题。
- SSH：修复使用 SSH 配置引用进行认证的连接，连接失败时现在会显示真实错误。
- 文件浏览：修复部分文件下载失败（500）的问题。
- 通知：修复 Telegram 消息中 pane 链接因二次编码而无法打开的问题。
