create table if not exists public.pipeline_tasks (
  id uuid primary key,
  user_id uuid not null,
  title text not null default 'Untitled task',
  stage text not null default 'title',
  is_archived boolean not null default false,
  scheduled_date date,
  sort_order integer not null default 9999,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pipeline_tasks enable row level security;

drop policy if exists pipeline_select_own on public.pipeline_tasks;
drop policy if exists pipeline_insert_own on public.pipeline_tasks;
drop policy if exists pipeline_update_own on public.pipeline_tasks;
drop policy if exists pipeline_delete_own on public.pipeline_tasks;

create policy pipeline_select_own
on public.pipeline_tasks
for select
to authenticated
using (auth.uid() = user_id);

create policy pipeline_insert_own
on public.pipeline_tasks
for insert
to authenticated
with check (auth.uid() = user_id);

create policy pipeline_update_own
on public.pipeline_tasks
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy pipeline_delete_own
on public.pipeline_tasks
for delete
to authenticated
using (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.pipeline_tasks to authenticated;
