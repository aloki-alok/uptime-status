CREATE TABLE subscribers (
  site_id TEXT NOT NULL,
  email_key TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unsubscribed', 'suppressed')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  token_version INTEGER NOT NULL CHECK (token_version >= 1),
  confirmation_token_hash TEXT,
  confirmation_expires_at TEXT,
  confirmation_sent_at TEXT,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  suppressed_at TEXT,
  suppression_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  PRIMARY KEY (site_id, email_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE confirmation_outbox (
  outbox_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  email_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'subscription-confirmation'),
  token_version INTEGER NOT NULL CHECK (token_version >= 1),
  created_at TEXT NOT NULL,
  payload_key_version INTEGER NOT NULL CHECK (payload_key_version >= 1),
  payload_nonce TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'enqueued', 'claimed', 'sent', 'cancelled', 'failed')),
  enqueued_at TEXT,
  claim_id TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  sent_at TEXT,
  provider_message_id TEXT,
  failed_at TEXT,
  failure_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  FOREIGN KEY (site_id, email_key) REFERENCES subscribers(site_id, email_key)
) STRICT;

CREATE INDEX confirmation_outbox_pending
  ON confirmation_outbox (site_id, created_at, outbox_id)
  WHERE state = 'pending';

CREATE INDEX confirmation_outbox_claim
  ON confirmation_outbox (outbox_id, site_id, state, claim_expires_at);

CREATE UNIQUE INDEX confirmation_outbox_provider_message
  ON confirmation_outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE subscription_rate_limits (
  site_id TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  PRIMARY KEY (site_id, bucket_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE delivery_webhook_events (
  provider TEXT NOT NULL CHECK (provider = 'resend'),
  event_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('bounce', 'complaint')),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
) STRICT, WITHOUT ROWID;
