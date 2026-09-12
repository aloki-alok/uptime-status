import type { Database } from "bun:sqlite";
import {
  type Incident,
  type Maintenance,
  type SiteConfig,
  validateIncident,
  validateMaintenance,
} from "@uptime-status/domain";

export type CuratedKind = "incident" | "maintenance";
export type CuratedEvent = Incident | Maintenance;

type StoredRow = { kind: CuratedKind; body: string; revision: number };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS curated_events(
    kind TEXT NOT NULL CHECK(kind IN ('incident', 'maintenance')),
    slug TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(kind, slug)
  );
  CREATE TABLE IF NOT EXISTS curated_audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    before_revision INTEGER,
    after_revision INTEGER NOT NULL,
    published_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
`;

function parseEvent(row: StoredRow, site: SiteConfig): CuratedEvent {
  const event: unknown = JSON.parse(row.body);
  const slugs = new Set(site.components.map((component) => component.componentId));
  const valid =
    row.kind === "incident"
      ? validateIncident(event, slugs, (event as Incident).state !== "resolved")
      : validateMaintenance(event, slugs);
  if (!valid || (event as CuratedEvent).revision !== row.revision) {
    throw new Error(`Stored ${row.kind} ${String((event as CuratedEvent)?.slug)} is invalid`);
  }
  return event as CuratedEvent;
}

export class CuratedStore {
  constructor(
    private readonly db: Database,
    private readonly site: SiteConfig,
  ) {
    db.exec(SCHEMA);
    db.exec("PRAGMA busy_timeout = 5000;");
  }

  get(kind: CuratedKind, slug: string): CuratedEvent | null {
    const row = this.db
      .query("SELECT kind, body, revision FROM curated_events WHERE kind = ? AND slug = ?")
      .get(kind, slug) as StoredRow | null;
    return row ? parseEvent(row, this.site) : null;
  }

  all(): { incidents: Incident[]; maintenances: Maintenance[] } {
    const rows = this.db
      .query("SELECT kind, body, revision FROM curated_events ORDER BY updated_at DESC")
      .all() as StoredRow[];
    const events = rows.map((row) => ({ kind: row.kind, event: parseEvent(row, this.site) }));
    return {
      incidents: events
        .filter((item) => item.kind === "incident")
        .map((item) => item.event as Incident),
      maintenances: events
        .filter((item) => item.kind === "maintenance")
        .map((item) => item.event as Maintenance),
    };
  }

  save(
    kind: CuratedKind,
    next: CuratedEvent,
    expectedRevision: number | null,
    actor: string,
    action: string,
  ) {
    const slugs = new Set(this.site.components.map((component) => component.componentId));
    const valid =
      kind === "incident"
        ? validateIncident(next, slugs, (next as Incident).state !== "resolved")
        : validateMaintenance(next, slugs);
    if (!valid) throw new Error("The public notice is invalid; nothing was published");
    if (next.revision !== (expectedRevision ?? 0) + 1) {
      throw new Error("Revision mismatch; nothing was published");
    }
    const body = JSON.stringify(next);
    const publishedAt = new Date().toISOString();
    this.db.transaction(() => {
      if (expectedRevision === null) {
        this.db.run(
          "INSERT INTO curated_events(kind, slug, revision, body, updated_at) VALUES (?, ?, ?, ?, ?)",
          [kind, next.slug, next.revision, body, publishedAt],
        );
      } else {
        const changed = this.db.run(
          "UPDATE curated_events SET revision = ?, body = ?, updated_at = ? WHERE kind = ? AND slug = ? AND revision = ?",
          [next.revision, body, publishedAt, kind, next.slug, expectedRevision],
        );
        if (changed.changes !== 1)
          throw new Error("Notice changed since preview; run the command again");
      }
      this.db.run(
        "INSERT INTO curated_audit(kind, slug, action, actor, before_revision, after_revision, published_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [kind, next.slug, action, actor, expectedRevision, next.revision, publishedAt, body],
      );
    })();
  }
}
