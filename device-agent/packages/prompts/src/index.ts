/**
 * @device-agent/prompts —— 提示词模板与拼装。
 *
 * 当前只承载"拼装好的字符串片段的规约"，真正的模板组装在
 * `apps/agent-gateway/src/agent/system-prompt.ts` 里（M4）。
 * 后续 M5/M7 引入更多模板时，把可复用的片段挪到这里，
 * 让 `apps/` 只负责"取哪一段、按什么顺序拼"。
 *
 * 之所以现在就建这个包，是因为 tsconfig 的 paths 已经声明了
 * `@device-agent/prompts/*`——留空会让第一次 import 直接失败。
 */

/** 提示词片段的通用形状：一个标题 + 若干行正文。 */
export interface PromptSection {
  title: string;
  lines: string[];
}

/** 把一个片段渲染成 markdown 小标题 + 列表，供系统提示词拼接。 */
export function renderSection(section: PromptSection): string {
  if (section.lines.length === 0) return `## ${section.title}`;
  return [`## ${section.title}`, ...section.lines.map((l) => `- ${l}`)].join("\n");
}

/** 按顺序拼接多个片段，空片段自动跳过。 */
export function composeSections(sections: PromptSection[], separator = "\n\n"): string {
  return sections
    .filter((s) => s.title.trim().length > 0)
    .map(renderSection)
    .join(separator);
}
