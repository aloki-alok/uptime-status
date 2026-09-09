export type { Incident, StatusSnapshot, StatusState } from "./schema";
export { StatusSnapshotSchema, validateStatusSnapshot } from "./schema";
export { deriveOverallStatus, isSnapshotFresh, STALE_AFTER_MS } from "./truth";
