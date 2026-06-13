// Prompt 模板基础组件（纯函数，返回字符串）。
import { type PromptComponent, blocks, cat, lines } from './jsx';

/** 文档根：子段落用空行分隔。 */
export const Doc: PromptComponent = ({ children }) => blocks(children);

/** 带可选标题的段落块：标题单独成行，正文逐行。 */
export const Section: PromptComponent<{ title?: string }> = ({ title, children }) =>
  (title ? `${title}\n` : '') + lines(children);

/** 逐行容器。 */
export const Lines: PromptComponent = ({ children }) => lines(children);

/** 列表项：`- ` 前缀，内容无分隔拼接。 */
export const Item: PromptComponent = ({ children }) => `- ${cat(children)}`;
