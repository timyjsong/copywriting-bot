-- =============================================================================
-- 0001_init.sql — schema for Copywriting Bot MVP
-- Mirrors PRD §5.3 data model.
--
-- Run with: supabase db push  (or psql against SUPABASE_DB_URL).
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists vector;

-- -----------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------
create type customer_status as enum ('onboarding', 'active', 'paused', 'churned');
create type customer_tier as enum ('roast_only', 'full_rewrite', 'subscription');

create table customers (
    id uuid primary key default gen_random_uuid(),
    email text not null unique,
    company_domain text,
    signup_source text,
    tier customer_tier not null default 'roast_only',
    status customer_status not null default 'onboarding',
    operator_approval_gates_on boolean not null default true,
    stripe_customer_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index customers_status_idx on customers (status);

-- -----------------------------------------------------------------------------
-- sequences (customer's cold-email sequences, original + rewritten)
-- -----------------------------------------------------------------------------
create type sequence_status as enum (
    'draft',
    'pending_approval',
    'approved',
    'active',
    'replaced',
    'rejected'
);

create table sequences (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references customers (id) on delete cascade,
    version integer not null default 1,
    status sequence_status not null default 'draft',
    original_text text not null,
    rewritten_text text,
    voice_profile_json jsonb,
    icp_json jsonb,
    approved_by text,
    approved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (customer_id, version)
);
create index sequences_customer_id_idx on sequences (customer_id);
create index sequences_status_idx on sequences (status);

-- -----------------------------------------------------------------------------
-- campaigns (Smartlead-linked send campaigns)
-- -----------------------------------------------------------------------------
create type campaign_status as enum ('warmup', 'sending', 'paused', 'ended', 'failed');

create table campaigns (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references customers (id) on delete cascade,
    sequence_id uuid not null references sequences (id) on delete cascade,
    smartlead_campaign_id text,
    status campaign_status not null default 'warmup',
    warmup_status text,
    daily_cap integer not null default 30,
    started_at timestamptz,
    ended_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index campaigns_customer_id_idx on campaigns (customer_id);

-- -----------------------------------------------------------------------------
-- send_batches (daily batches awaiting / past operator approval)
-- -----------------------------------------------------------------------------
create type send_batch_status as enum (
    'pending_approval',
    'approved',
    'rejected',
    'sent',
    'failed'
);

create table send_batches (
    id uuid primary key default gen_random_uuid(),
    campaign_id uuid not null references campaigns (id) on delete cascade,
    batch_date date not null,
    prospect_count integer not null,
    status send_batch_status not null default 'pending_approval',
    approved_by text,
    approved_at timestamptz,
    payload_json jsonb,
    created_at timestamptz not null default now(),
    unique (campaign_id, batch_date)
);
create index send_batches_status_idx on send_batches (status);

-- -----------------------------------------------------------------------------
-- prospects (bot's own outbound, sourced via Apollo/Clay)
-- -----------------------------------------------------------------------------
create type prospect_status as enum (
    'queued',
    'enriched',
    'sent',
    'replied',
    'meeting',
    'closed_won',
    'closed_lost',
    'dnc'
);

create table prospects (
    id uuid primary key default gen_random_uuid(),
    source text not null,
    name text,
    role text,
    email text,
    company text,
    company_domain text,
    signal_json jsonb,
    status prospect_status not null default 'queued',
    enriched_at timestamptz,
    sent_at timestamptz,
    replied_at timestamptz,
    created_at timestamptz not null default now()
);
create index prospects_status_idx on prospects (status);
create index prospects_email_idx on prospects (email);

-- -----------------------------------------------------------------------------
-- performance_snapshots (daily metrics rollup per customer campaign)
-- -----------------------------------------------------------------------------
create table performance_snapshots (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references customers (id) on delete cascade,
    campaign_id uuid not null references campaigns (id) on delete cascade,
    snapshot_date date not null,
    opens integer not null default 0,
    replies integer not null default 0,
    meetings_booked integer not null default 0,
    baseline_reply_rate numeric(5, 4),
    current_reply_rate numeric(5, 4),
    uplift_pct numeric(6, 2),
    created_at timestamptz not null default now(),
    unique (campaign_id, snapshot_date)
);
create index performance_snapshots_customer_id_idx on performance_snapshots (customer_id);

-- -----------------------------------------------------------------------------
-- approvals_queue (operator approval gates)
-- -----------------------------------------------------------------------------
create type approval_type as enum (
    'rewrite',
    'send_batch',
    'refund',
    'outbound_email',
    'support_reply'
);
create type approval_status as enum ('pending', 'approved', 'rejected', 'edited_and_approved');

create table approvals_queue (
    id uuid primary key default gen_random_uuid(),
    type approval_type not null,
    entity_id uuid not null,
    customer_id uuid references customers (id) on delete cascade,
    status approval_status not null default 'pending',
    operator_action text,
    operator_notes text,
    payload_json jsonb not null,
    sla_due_at timestamptz,
    decided_at timestamptz,
    created_at timestamptz not null default now()
);
create index approvals_queue_status_idx on approvals_queue (status, sla_due_at);
create index approvals_queue_type_idx on approvals_queue (type, status);

-- -----------------------------------------------------------------------------
-- events (audit log — append-only)
-- -----------------------------------------------------------------------------
create table events (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid references customers (id) on delete set null,
    agent text,
    event_type text not null,
    payload_json jsonb,
    ts timestamptz not null default now()
);
create index events_customer_id_idx on events (customer_id, ts desc);
create index events_event_type_idx on events (event_type, ts desc);

-- -----------------------------------------------------------------------------
-- roasts (free tool — pre-customer)
-- -----------------------------------------------------------------------------
create table roasts (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    source text,
    input_text text not null,
    result_json jsonb not null,
    overall_score integer,
    is_real_cold_email boolean not null default true,
    clicked_upsell boolean not null default false,
    converted_customer_id uuid references customers (id) on delete set null,
    created_at timestamptz not null default now()
);
create index roasts_email_idx on roasts (email);
create index roasts_created_idx on roasts (created_at desc);

-- -----------------------------------------------------------------------------
-- leads (email-captured visitors — funnel attribution)
-- -----------------------------------------------------------------------------
create table leads (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    source text,
    utm_json jsonb,
    first_roast_id uuid references roasts (id) on delete set null,
    converted_customer_id uuid references customers (id) on delete set null,
    created_at timestamptz not null default now(),
    unique (email)
);

-- -----------------------------------------------------------------------------
-- updated_at maintenance trigger
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger customers_set_updated_at
before update on customers
for each row execute function set_updated_at();

create trigger sequences_set_updated_at
before update on sequences
for each row execute function set_updated_at();

create trigger campaigns_set_updated_at
before update on campaigns
for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security baselines (service role bypasses RLS)
-- -----------------------------------------------------------------------------
alter table customers enable row level security;
alter table sequences enable row level security;
alter table campaigns enable row level security;
alter table send_batches enable row level security;
alter table prospects enable row level security;
alter table performance_snapshots enable row level security;
alter table approvals_queue enable row level security;
alter table events enable row level security;
alter table roasts enable row level security;
alter table leads enable row level security;

-- Customers can only read their own row + related sequences/campaigns/perf.
create policy customer_self_select on customers
    for select using (auth.jwt() ->> 'email' = email);

create policy sequences_owner_select on sequences
    for select using (
        customer_id in (
            select id from customers where auth.jwt() ->> 'email' = email
        )
    );

create policy campaigns_owner_select on campaigns
    for select using (
        customer_id in (
            select id from customers where auth.jwt() ->> 'email' = email
        )
    );

create policy performance_owner_select on performance_snapshots
    for select using (
        customer_id in (
            select id from customers where auth.jwt() ->> 'email' = email
        )
    );

-- Roasts/leads are written by service role only; no end-user select policy.
