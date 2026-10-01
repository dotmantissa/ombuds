-- Ombuds search index.
--
-- Read this before you trust anything in here.
--
-- This database is an index. It is not the record. Every verdict, every case status and
-- every figure that matters is held by the OmbudsCourt intelligent contract, and the
-- application re-reads it from chain before it shows it to anybody. What lives here is a
-- copy kept so that search, filtering and case history are fast, and so a member can find
-- their own docket without scanning a chain.
--
-- The index cannot invent or alter a verdict. If a row here disagreed with the chain, the
-- chain is right and the row is stale. Nothing in the product reads a verdict from this
-- table to decide anything, and no write path here can cause a payout.
--
-- On privacy: there is no patient data in this schema and there must never be. Emails are
-- stored as a SHA-256 hash, because the product needs to recognise a returning member
-- without holding their address. Case text has already been through the de-identification
-- layer in web/lib/deident.ts and the on-chain tripwire in OmbudsCourt.file_case before it
-- ever arrives here.

CREATE TABLE IF NOT EXISTS members (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_did   text        NOT NULL UNIQUE,
  -- SHA-256 of the lowercased email. Never the address itself, so a dump of this table
  -- cannot be turned into a mailing list.
  email_hash  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cases (
  docket              text        PRIMARY KEY,
  member_id           uuid        REFERENCES members(id) ON DELETE SET NULL,
  plan_id             text        NOT NULL,
  family_id           text        NOT NULL,
  state               char(2)     NOT NULL,
  cpt_codes           text[]      NOT NULL DEFAULT '{}',
  icd10_codes         text[]      NOT NULL DEFAULT '{}',
  denial_reason_code  text        NOT NULL DEFAULT '',
  denial_rationale    text        NOT NULL,
  -- Bucketed to YYYY-MM on purpose. A full date of service is an identifier.
  service_month       text        NOT NULL,
  disputed_amount_atto numeric(78,0) NOT NULL,
  evidence_sha256     char(64)    NOT NULL,
  chain_tx            text,
  chain_case_id       text,
  status              text        NOT NULL DEFAULT 'FILED',
  filed_at            timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verdicts (
  docket               text        PRIMARY KEY REFERENCES cases(docket) ON DELETE CASCADE,
  overturn_recommended boolean     NOT NULL,
  ground               text        NOT NULL,
  clause_id            text        NOT NULL,
  clause_section       text        NOT NULL DEFAULT '',
  clause_quote         text        NOT NULL DEFAULT '',
  recoverable_band     integer     NOT NULL,
  confidence           integer     NOT NULL,
  digest               char(64)    NOT NULL,
  citations            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  reasoning            text        NOT NULL DEFAULT '',
  tx_hash              text,
  panel_round          integer     NOT NULL DEFAULT 1,
  adjudicated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_events (
  id          bigserial   PRIMARY KEY,
  kind        text        NOT NULL,
  actor       text        NOT NULL DEFAULT '',
  amount_atto numeric(78,0) NOT NULL DEFAULT 0,
  docket      text,
  tx_hash     text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_snapshots (
  id             bigserial   PRIMARY KEY,
  docket         text,
  url            text        NOT NULL,
  kind           text        NOT NULL,
  content_sha256 char(64)    NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cases_member_idx    ON cases (member_id);
CREATE INDEX IF NOT EXISTS cases_status_idx    ON cases (status);
CREATE INDEX IF NOT EXISTS cases_filed_idx     ON cases (filed_at DESC);
CREATE INDEX IF NOT EXISTS cases_plan_idx      ON cases (plan_id);
CREATE INDEX IF NOT EXISTS cases_family_idx    ON cases (family_id);
CREATE INDEX IF NOT EXISTS verdicts_ground_idx ON verdicts (ground);
CREATE INDEX IF NOT EXISTS pool_events_docket_idx ON pool_events (docket);
CREATE INDEX IF NOT EXISTS pool_events_at_idx  ON pool_events (at DESC);
CREATE INDEX IF NOT EXISTS snapshots_docket_idx ON source_snapshots (docket);
