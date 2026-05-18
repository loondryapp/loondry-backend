-- Laundry connection request flow and laundry-initiated host invitations.

create table if not exists laundry_connection_requests (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null,
  assigned_laundry_id uuid null,
  status text not null default 'pending_assignment',
  requested_services jsonb not null default '[]'::jsonb,
  apartment_ids jsonb not null default '[]'::jsonb,
  city text null,
  zones jsonb not null default '[]'::jsonb,
  notes text null,
  rejection_reason text null,
  changes_requested_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz null,
  rejected_at timestamptz null,
  constraint laundry_connection_requests_status_check check (
    status in (
      'pending_assignment',
      'sent_to_laundry',
      'under_review',
      'accepted_waiting_contract',
      'contract_uploaded',
      'contract_sent',
      'contract_signed',
      'active',
      'rejected',
      'changes_requested'
    )
  )
);

create table if not exists laundry_connection_request_apartments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references laundry_connection_requests(id) on delete cascade,
  property_id uuid null,
  property_name text not null,
  address text null,
  city text null,
  zone text null,
  square_meters numeric null,
  bedrooms_count integer null,
  beds_count integer null,
  checkin_time text null,
  checkout_time text null,
  requested_service_ids jsonb not null default '[]'::jsonb,
  notes text null,
  created_at timestamptz not null default now()
);

create table if not exists laundry_host_invitations (
  id uuid primary key default gen_random_uuid(),
  laundry_id uuid not null,
  host_id uuid null,
  invited_email text not null,
  invited_first_name text not null,
  invited_last_name text not null,
  invited_phone text null,
  company_name text null,
  status text not null default 'draft',
  notes_internal text null,
  notes_for_host text null,
  invitation_token text not null unique,
  expires_at timestamptz null,
  sent_at timestamptz null,
  viewed_at timestamptz null,
  accepted_at timestamptz null,
  rejected_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint laundry_host_invitations_status_check check (
    status in ('draft', 'sent', 'viewed', 'accepted', 'active', 'rejected', 'expired')
  )
);

create table if not exists laundry_host_invitation_apartments (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references laundry_host_invitations(id) on delete cascade,
  property_id uuid null,
  property_name text not null,
  address text null,
  city text null,
  zone text null,
  square_meters numeric null,
  bedrooms_count integer null,
  beds_count integer null,
  checkin_time text null,
  checkout_time text null,
  selected_service_ids jsonb not null default '[]'::jsonb,
  requested_service_ids jsonb not null default '[]'::jsonb,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists laundry_connection_contracts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid null references laundry_connection_requests(id) on delete cascade,
  invitation_id uuid null references laundry_host_invitations(id) on delete cascade,
  source_type text not null default 'request',
  host_id uuid null,
  laundry_id uuid not null,
  file_url text null,
  file_name text null,
  contract_name text not null,
  notes_for_host text null,
  status text not null default 'draft',
  requires_signature boolean not null default true,
  is_downloadable boolean not null default true,
  signature_due_date timestamptz null,
  sent_at timestamptz null,
  signed_at timestamptz null,
  signed_by_user_id uuid null,
  signature_name text null,
  is_already_signed boolean not null default false,
  signed_offline_at timestamptz null,
  offline_signature_name text null,
  uploaded_by_laundry_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint laundry_connection_contracts_source_type_check check (source_type in ('request', 'invitation')),
  constraint laundry_connection_contracts_status_check check (
    status in ('draft', 'sent', 'viewed', 'signed', 'already_signed', 'expired', 'cancelled')
  )
);

create table if not exists host_laundry_connections (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null,
  laundry_id uuid not null,
  request_id uuid null references laundry_connection_requests(id) on delete set null,
  contract_id uuid null references laundry_connection_contracts(id) on delete set null,
  status text not null default 'active',
  activated_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint host_laundry_connections_status_check check (status in ('active', 'suspended', 'disconnected')),
  constraint host_laundry_connections_unique unique (host_id, laundry_id)
);

create index if not exists idx_laundry_connection_requests_host on laundry_connection_requests(host_id);
create index if not exists idx_laundry_connection_requests_laundry on laundry_connection_requests(assigned_laundry_id);
create index if not exists idx_laundry_connection_contracts_request on laundry_connection_contracts(request_id);
create index if not exists idx_laundry_connection_contracts_invitation on laundry_connection_contracts(invitation_id);
create index if not exists idx_laundry_host_invitations_laundry on laundry_host_invitations(laundry_id);
create index if not exists idx_laundry_host_invitations_email on laundry_host_invitations(invited_email);
