import type { Incident, StatusState } from "./schema";

const stateRank: Record<StatusState, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
  unknown: 5,
};

export const STALE_AFTER_MS = 120_000;

export function isSnapshotFresh(
  snapshot: { generatedAt: string; latestCheckAt: string },
  responseDate: string,
) {
  const generatedAt = Date.parse(snapshot.generatedAt);
  const latestCheckAt = Date.parse(snapshot.latestCheckAt);
  const observedAt = Date.parse(responseDate);

  return (
    Number.isFinite(generatedAt) &&
    Number.isFinite(latestCheckAt) &&
    Number.isFinite(observedAt) &&
    latestCheckAt <= generatedAt &&
    generatedAt <= observedAt + 5_000 &&
    observedAt - latestCheckAt <= STALE_AFTER_MS
  );
}

export function deriveOverallStatus(input: {
  isFresh: boolean;
  componentStates: StatusState[];
  activeIncidents: Incident[];
}): StatusState {
  if (!input.isFresh || input.componentStates.length === 0) {
    return "unknown";
  }

  const activeIncidents = input.activeIncidents.filter((incident) => incident.state !== "resolved");

  if (activeIncidents.some((incident) => incident.impact === "major_outage")) {
    return "major_outage";
  }

  if (activeIncidents.some((incident) => incident.impact === "partial_outage")) {
    return "partial_outage";
  }

  if (activeIncidents.some((incident) => incident.impact === "degraded")) {
    return "degraded";
  }

  return input.componentStates.reduce<StatusState>(
    (worst, current) => (stateRank[current] > stateRank[worst] ? current : worst),
    "operational",
  );
}
