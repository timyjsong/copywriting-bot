/**
 * Hand-maintained type mirror of the SQL schema in migrations/0001_init.sql.
 *
 * When the schema changes:
 *   1. Add a new SQL migration.
 *   2. Mirror the change here.
 *   3. (Optional, Phase 2) regenerate with `supabase gen types typescript`.
 */

export type CustomerStatus = "onboarding" | "active" | "paused" | "churned";
export type CustomerTier = "roast_only" | "full_rewrite" | "subscription";

export interface Customer {
  id: string;
  email: string;
  company_domain: string | null;
  signup_source: string | null;
  tier: CustomerTier;
  status: CustomerStatus;
  operator_approval_gates_on: boolean;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

export type SequenceStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "active"
  | "replaced"
  | "rejected";

export interface Sequence {
  id: string;
  customer_id: string;
  version: number;
  status: SequenceStatus;
  original_text: string;
  rewritten_text: string | null;
  voice_profile_json: unknown | null;
  icp_json: unknown | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CampaignStatus = "warmup" | "sending" | "paused" | "ended" | "failed";

export interface Campaign {
  id: string;
  customer_id: string;
  sequence_id: string;
  smartlead_campaign_id: string | null;
  status: CampaignStatus;
  warmup_status: string | null;
  daily_cap: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SendBatchStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "sent"
  | "failed";

export interface SendBatch {
  id: string;
  campaign_id: string;
  batch_date: string;
  prospect_count: number;
  status: SendBatchStatus;
  approved_by: string | null;
  approved_at: string | null;
  payload_json: unknown | null;
  created_at: string;
}

export type ProspectStatus =
  | "queued"
  | "enriched"
  | "sent"
  | "replied"
  | "meeting"
  | "closed_won"
  | "closed_lost"
  | "dnc";

export interface Prospect {
  id: string;
  source: string;
  name: string | null;
  role: string | null;
  email: string | null;
  company: string | null;
  company_domain: string | null;
  signal_json: unknown | null;
  status: ProspectStatus;
  enriched_at: string | null;
  sent_at: string | null;
  replied_at: string | null;
  created_at: string;
}

export interface PerformanceSnapshot {
  id: string;
  customer_id: string;
  campaign_id: string;
  snapshot_date: string;
  opens: number;
  replies: number;
  meetings_booked: number;
  baseline_reply_rate: number | null;
  current_reply_rate: number | null;
  uplift_pct: number | null;
  created_at: string;
}

export type ApprovalType =
  | "rewrite"
  | "send_batch"
  | "refund"
  | "outbound_email"
  | "support_reply";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "edited_and_approved";

export interface ApprovalQueueItem {
  id: string;
  type: ApprovalType;
  entity_id: string;
  customer_id: string | null;
  status: ApprovalStatus;
  operator_action: string | null;
  operator_notes: string | null;
  payload_json: unknown;
  sla_due_at: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface EventLog {
  id: string;
  customer_id: string | null;
  agent: string | null;
  event_type: string;
  payload_json: unknown | null;
  ts: string;
}

export interface Roast {
  id: string;
  email: string;
  source: string | null;
  input_text: string;
  result_json: unknown;
  overall_score: number | null;
  is_real_cold_email: boolean;
  clicked_upsell: boolean;
  converted_customer_id: string | null;
  created_at: string;
}

export interface Lead {
  id: string;
  email: string;
  source: string | null;
  utm_json: unknown | null;
  first_roast_id: string | null;
  converted_customer_id: string | null;
  created_at: string;
}

type TableDef<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      customers: TableDef<Customer, Partial<Customer> & { email: string }>;
      sequences: TableDef<Sequence, Partial<Sequence> & { customer_id: string; original_text: string }>;
      campaigns: TableDef<Campaign, Partial<Campaign> & { customer_id: string; sequence_id: string }>;
      send_batches: TableDef<
        SendBatch,
        Partial<SendBatch> & { campaign_id: string; batch_date: string; prospect_count: number }
      >;
      prospects: TableDef<Prospect, Partial<Prospect> & { source: string }>;
      performance_snapshots: TableDef<
        PerformanceSnapshot,
        Partial<PerformanceSnapshot> & { customer_id: string; campaign_id: string; snapshot_date: string }
      >;
      approvals_queue: TableDef<
        ApprovalQueueItem,
        Partial<ApprovalQueueItem> & { type: ApprovalType; entity_id: string; payload_json: unknown }
      >;
      events: TableDef<EventLog, Partial<EventLog> & { event_type: string }>;
      roasts: TableDef<Roast, Partial<Roast> & { email: string; input_text: string; result_json: unknown }>;
      leads: TableDef<Lead, Partial<Lead> & { email: string }>;
    };
    Views: { [key: string]: never };
    Functions: { [key: string]: never };
    Enums: {
      customer_status: CustomerStatus;
      customer_tier: CustomerTier;
      sequence_status: SequenceStatus;
      campaign_status: CampaignStatus;
      send_batch_status: SendBatchStatus;
      prospect_status: ProspectStatus;
      approval_type: ApprovalType;
      approval_status: ApprovalStatus;
    };
    CompositeTypes: { [key: string]: never };
  };
}
