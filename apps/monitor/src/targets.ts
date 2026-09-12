// Maps status.config.json's monitoring.sources (adapter "https") onto scheduler targets,
// each carrying every component bound to that source by sourceId.
import type { SiteConfig } from "@uptime-status/domain";
import type { SchedulerTarget } from "@uptime-status/monitor";

export type MonitorTarget = SchedulerTarget & {
  url: string;
  timeoutMs?: number;
  acceptedStatus?: string[];
  confirmRetries?: number;
  componentIds: string[];
};

export function buildMonitorTargets(site: SiteConfig): MonitorTarget[] {
  return site.monitoring.sources
    .filter((source) => source.adapter === "https")
    .map((source) => ({
      id: source.sourceId,
      url: source.url,
      // timeoutMs/acceptedStatus/confirmRetries stay undefined when absent: checker.ts
      // already applies the documented defaults (10000 / ["200-299"] / 1), no need to repeat them.
      timeoutMs: source.timeoutMs,
      acceptedStatus: source.acceptedStatus,
      confirmRetries: source.confirmRetries,
      intervalSeconds: source.intervalSeconds ?? 60,
      componentIds: site.components
        .filter((component) => component.sourceId === source.sourceId)
        .map((component) => component.componentId),
    }));
}
