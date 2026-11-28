/**
 * 健康检查注册表。
 *
 * 契约：GET /health →
 *   { "status": "ok" | "degraded",
 *     "checks": { "<name>": { "ready": boolean, ...detail } } }
 * readiness 与 liveness 语义分离（NFR O-02/03）：
 *   /health   → liveness，进程活着就 200
 *   /ready    → readiness，任一关键依赖未就绪则 503
 */
export interface CheckResult {
  ready: boolean;
  [key: string]: unknown;
}

export type CheckFn = () => CheckResult;

export interface HealthRegistry {
  register(name: string, fn: CheckFn, opts?: { critical?: boolean }): void;
  snapshot(): { status: "ok" | "degraded"; checks: Record<string, CheckResult> };
  readiness(): { ready: boolean; checks: Record<string, CheckResult> };
}

interface Entry {
  fn: CheckFn;
  critical: boolean;
}

export function createHealthRegistry(): HealthRegistry {
  const entries = new Map<string, Entry>();

  function run(): Record<string, CheckResult> {
    const out: Record<string, CheckResult> = {};
    for (const [name, entry] of entries) {
      try {
        out[name] = entry.fn();
      } catch (err) {
        out[name] = { ready: false, error: (err as Error).message };
      }
    }
    return out;
  }

  return {
    register(name, fn, opts) {
      entries.set(name, { fn, critical: opts?.critical ?? false });
    },
    snapshot() {
      const checks = run();
      const degraded = Object.values(checks).some((c) => !c.ready);
      return { status: degraded ? "degraded" : "ok", checks };
    },
    readiness() {
      const checks = run();
      const criticalNames = [...entries.entries()].filter(([, e]) => e.critical).map(([n]) => n);
      const ready = criticalNames.every((n) => checks[n]?.ready === true);
      return { ready, checks };
    },
  };
}
