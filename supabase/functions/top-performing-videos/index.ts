import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

type RangeType = 'today' | 'month' | '6months' | 'lifetime'
type SortType = 'views' | 'outlier' | 'vph'

function getCutoff(range: RangeType): string | null {
  const now = new Date();
  if (range === 'today') {
    now.setDate(now.getDate() - 1);
    return now.toISOString();
  }
  if (range === 'month') {
    now.setMonth(now.getMonth() - 1);
    return now.toISOString();
  }
  if (range === '6months') {
    now.setMonth(now.getMonth() - 6);
    return now.toISOString();
  }
  return null;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Yetkilendirme gerekli' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const accessToken = authHeader.replace('Bearer ', '').trim();

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Geçersiz yetkilendirme' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const range: RangeType = ['today', 'month', '6months', 'lifetime'].includes(body?.range)
      ? body.range
      : 'month';
    const sortBy: SortType = ['views', 'outlier', 'vph'].includes(body?.sort_by)
      ? body.sort_by
      : 'views';
    const limit = Number.isFinite(Number(body?.limit))
      ? Math.min(Math.max(Number(body.limit), 1), 100)
      : 25;

    const includeChannelIds: string[] = Array.isArray(body?.include_channel_ids)
      ? body.include_channel_ids.filter((id: unknown) => typeof id === 'string')
      : [];

    const { data: channels, error: channelsError } = await supabase
      .from('competitor_channels')
      .select('id, channel_name, channel_id')
      .eq('user_id', user.id);

    if (channelsError || !channels) {
      return new Response(
        JSON.stringify({ error: 'Rakip kanalları alınamadı' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const selectedChannels = includeChannelIds.length > 0
      ? channels.filter((c) => includeChannelIds.includes(c.id))
      : channels;

    if (selectedChannels.length === 0) {
      return new Response(
        JSON.stringify({ success: true, videos: [], total: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const channelMap = new Map(selectedChannels.map((c) => [c.id, c]));
    const channelIds = selectedChannels.map((c) => c.id);

    let videoQuery = supabase
      .from('competitor_videos')
      .select('*')
      .in('channel_id', channelIds);

    const cutoff = getCutoff(range);
    if (cutoff) {
      videoQuery = videoQuery.gte('published_at', cutoff);
    }

    const { data: videos, error: videosError } = await videoQuery;

    if (videosError || !videos) {
      return new Response(
        JSON.stringify({ error: 'Videolar alınamadı' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const avgViewsByChannel = new Map<string, number>();
    for (const channelId of channelIds) {
      const channelVideos = videos.filter((v) => v.channel_id === channelId);
      const avg = channelVideos.length > 0
        ? channelVideos.reduce((sum, v) => sum + (v.views || 0), 0) / channelVideos.length
        : 1;
      avgViewsByChannel.set(channelId, Math.max(avg, 1));
    }

    const nowMs = Date.now();
    const normalizedVideos = videos.map((video) => {
      const channel = channelMap.get(video.channel_id);
      const publishedAt = video.published_at ? new Date(video.published_at) : null;
      const hours = publishedAt && !Number.isNaN(publishedAt.getTime())
        ? Math.max((nowMs - publishedAt.getTime()) / 3600000, 1)
        : null;

      const vph = video.vph ?? (hours ? roundMetric((video.views || 0) / hours) : 0);
      const outlier = video.outlier_score ?? roundMetric(((video.views || 0) / (avgViewsByChannel.get(video.channel_id) || 1)) * 100);

      return {
        id: video.id,
        channel_id: video.channel_id,
        channel_name: channel?.channel_name || 'Bilinmeyen Kanal',
        youtube_channel_id: channel?.channel_id || null,
        video_id: video.video_id,
        title: video.title,
        thumbnail_url: video.thumbnail_url,
        views: video.views || 0,
        likes: video.likes || 0,
        comments: video.comments || 0,
        published_at: video.published_at,
        vph,
        outlier_score: outlier,
        engagement_rate: video.engagement_rate || 0
      };
    });

    const sorted = normalizedVideos.sort((a, b) => {
      if (sortBy === 'vph') return (b.vph || 0) - (a.vph || 0);
      if (sortBy === 'outlier') return (b.outlier_score || 0) - (a.outlier_score || 0);
      return (b.views || 0) - (a.views || 0);
    });

    return new Response(
      JSON.stringify({
        success: true,
        videos: sorted.slice(0, limit),
        total: sorted.length,
        range,
        sort_by: sortBy
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('top-performing-videos error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Sunucu hatası' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
