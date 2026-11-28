/**
 * @device-agent/skitter —— 面向 App / Agent 目录的轻量编排。
 *
 * 原工程用它把"应用目录、Agent 卡片、能力清单"编排成可检索的索引。
 * 本项目在 M4 阶段还不需要它；先放一个最小可用的目录容器，
 * 避免 tsconfig 里声明的 `@device-agent/skitter/*` 路径指向不存在的文件。
 *
 * M9（控制台 / 应用市场）落地时，这里会长出：
 *   - listApps / getApp
 *   - 按 productId 反查可用 Agent
 *   - capability 卡片生成
 */

export interface AppEntry {
  id: string;
  name: string;
  /** 该应用绑定的产品；空表示通用 */
  productId?: string;
  /** A2A 能力卡片等元数据 */
  metadata?: Record<string, unknown>;
}

export class AppCatalog {
  private readonly apps = new Map<string, AppEntry>();

  register(entry: AppEntry): void {
    if (!entry.id.trim()) throw new Error("app id is required");
    this.apps.set(entry.id, entry);
  }

  get(id: string): AppEntry | undefined {
    return this.apps.get(id);
  }

  list(productId?: string): AppEntry[] {
    const all = [...this.apps.values()];
    return productId ? all.filter((a) => a.productId === productId) : all;
  }

  clear(): void {
    this.apps.clear();
  }
}
