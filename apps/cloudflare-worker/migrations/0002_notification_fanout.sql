CREATE TABLE notification_events (
  event_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'incident_published', 'incident_updated', 'incident_resolved',
    'maintenance_scheduled', 'maintenance_rescheduled', 'maintenance_started',
    'maintenance_cancelled', 'maintenance_completed'
  )),
  payload_json TEXT NOT NULL,
  audience_cutoff_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expansion_after_confirmed_at TEXT,
  expansion_after_email_key TEXT,
  expanded_at TEXT,
  CHECK (
    (expansion_after_confirmed_at IS NULL AND expansion_after_email_key IS NULL)
    OR (expansion_after_confirmed_at IS NOT NULL AND expansion_after_email_key IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX notification_events_expandable
  ON notification_events (site_id, created_at, event_id)
  WHERE expanded_at IS NULL;

CREATE TABLE notification_deliveries (
  event_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  email_key TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  subscriber_token_version INTEGER NOT NULL CHECK (subscriber_token_version >= 1),
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'enqueued', 'claimed', 'retry_wait', 'sent', 'failed', 'cancelled')),
  enqueued_at TEXT,
  claim_id TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  sent_at TEXT,
  provider_message_id TEXT,
  failed_at TEXT,
  failure_code TEXT,
  retry_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  PRIMARY KEY (event_id, email_key),
  FOREIGN KEY (event_id) REFERENCES notification_events(event_id),
  FOREIGN KEY (site_id, email_key) REFERENCES subscribers(site_id, email_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX notification_deliveries_pending
  ON notification_deliveries (site_id, created_at, event_id, email_key)
  WHERE state = 'pending';

CREATE INDEX notification_deliveries_recovery
  ON notification_deliveries (site_id, state, claim_expires_at, enqueued_at, retry_at);

CREATE UNIQUE INDEX notification_deliveries_provider_message
  ON notification_deliveries (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
