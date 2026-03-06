-- Competitor Channels System for YTConsole
-- Created: 2026-03-07

-- Competitor channels table (user's tracked competitor channels)
create table public.competitor_channels (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) not null,
  channel_id text not null,
  channel_name text not null,
  channel_url text,
  thumbnail_url text,
  subscribers integer default 0,
  total_views bigint default 0,
  video_count integer default 0,
  country text,
  channel_created_at date,
  description text,
  last_fetched timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(user_id, channel_id)
);

-- Enable RLS
alter table public.competitor_channels enable row level security;

-- Policies for competitor_channels
create policy "Users can view own competitor channels" 
on public.competitor_channels for select 
using ( auth.uid() = user_id );

create policy "Users can insert own competitor channels" 
on public.competitor_channels for insert 
with check ( auth.uid() = user_id );

create policy "Users can update own competitor channels" 
on public.competitor_channels for update 
using ( auth.uid() = user_id );

create policy "Users can delete own competitor channels" 
on public.competitor_channels for delete 
using ( auth.uid() = user_id );


-- Competitor videos table (videos from competitor channels)
create table public.competitor_videos (
  id uuid default gen_random_uuid() primary key,
  channel_id uuid references public.competitor_channels(id) on delete cascade not null,
  video_id text not null,
  title text not null,
  thumbnail_url text,
  views bigint default 0,
  likes integer default 0,
  comments integer default 0,
  duration text,
  published_at timestamp with time zone,
  last_fetched timestamp with time zone default timezone('utc'::text, now()) not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(channel_id, video_id)
);

-- Enable RLS
alter table public.competitor_videos enable row level security;

-- Policies for competitor_videos
create policy "Users can view own competitor videos" 
on public.competitor_videos for select 
using ( 
  exists (
    select 1 from public.competitor_channels 
    where id = competitor_videos.channel_id 
    and user_id = auth.uid()
  )
);

create policy "Users can insert own competitor videos" 
on public.competitor_videos for insert 
with check ( 
  exists (
    select 1 from public.competitor_channels 
    where id = competitor_videos.channel_id 
    and user_id = auth.uid()
  )
);

create policy "Users can update own competitor videos" 
on public.competitor_videos for update 
using ( 
  exists (
    select 1 from public.competitor_channels 
    where id = competitor_videos.channel_id 
    and user_id = auth.uid()
  )
);

create policy "Users can delete own competitor videos" 
on public.competitor_videos for delete 
using ( 
  exists (
    select 1 from public.competitor_channels 
    where id = competitor_videos.channel_id 
    and user_id = auth.uid()
  )
);

-- Helper function to get user competitor count
create or replace function public.get_competitor_count(user_uuid uuid)
returns integer as $$
  select count(*)::integer from public.competitor_channels where user_id = user_uuid;
$$ language sql security definer;

-- Helper function to check if user can add competitor (has tokens and hasn't reached limit)
create or replace function public.can_add_competitor(user_uuid uuid)
returns jsonb as $$
declare
  competitor_count integer;
  user_tokens integer;
  can_add boolean;
begin
  competitor_count := (select count(*) from public.competitor_channels where user_id = user_uuid);
  select token_balance into user_tokens from public.profiles where id = user_uuid;
  
  can_add := (competitor_count < 10) AND (user_tokens >= 2);
  
  return jsonb_build_object(
    'can_add', can_add,
    'competitor_count', competitor_count,
    'max_competitors', 10,
    'user_tokens', COALESCE(user_tokens, 0),
    'tokens_required', 2
  );
end;
$$ language plpgsql security definer;
