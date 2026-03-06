-- Competitor video analytics metrics
-- Created: 2026-03-07

alter table public.competitor_videos
  add column if not exists published_hours_ago numeric,
  add column if not exists vph numeric,
  add column if not exists outlier_score numeric,
  add column if not exists engagement_rate numeric;

create index if not exists idx_competitor_videos_channel_published
  on public.competitor_videos(channel_id, published_at desc);

create index if not exists idx_competitor_videos_vph
  on public.competitor_videos(vph desc);

create index if not exists idx_competitor_videos_outlier
  on public.competitor_videos(outlier_score desc);
