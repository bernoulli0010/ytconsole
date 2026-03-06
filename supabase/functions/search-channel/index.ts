import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!

function safeStr(val: unknown): string {
  if (typeof val === 'string') return val.trim();
  return '';
}

function toInt(val: unknown): number {
  const cleaned = String(val ?? '0').replace(/[^0-9-]/g, '');
  const parsed = Number.parseInt(cleaned || '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getChannelUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('http')) return trimmed;
  if (trimmed.startsWith('@')) return `https://www.youtube.com/${trimmed}`;
  if (trimmed.startsWith('UC') && trimmed.length > 20) return `https://www.youtube.com/channel/${trimmed}`;
  return `https://www.youtube.com/@${trimmed}`;
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

    const body = await req.json().catch(() => ({}));
    const query = safeStr(body.query);
    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Kanal arama sorgusu gerekli' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const actorId = 'streamers~youtube-channel-scraper';
    const channelUrl = getChannelUrl(query);

    const runResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url: channelUrl }],
        maxResults: 5,
        sortVideosBy: 'NEWEST'
      })
    });

    if (!runResponse.ok) {
      return new Response(
        JSON.stringify({ error: 'Kanal araması başarısız oldu' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const runData = await runResponse.json();
    const runId = runData.data.id;

    let attempts = 0;
    while (attempts < 20) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const statusResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/${runId}?token=${APIFY_API_KEY}`);
      const statusData = await statusResponse.json();

      if (statusData.data.status === 'SUCCEEDED') break;
      if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') {
        return new Response(
          JSON.stringify({ error: 'Kanal verisi alınamadı' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      attempts++;
    }

    const datasetId = runData.data.defaultDatasetId;
    const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`);
    const items = await itemsResponse.json();

    if (!items || items.length === 0) {
      return new Response(
        JSON.stringify({ success: true, channel: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const channel = items[0];
    const videos = (channel.latestVideos || []).slice(0, 5).map((video: any) => ({
      video_id: video.id || video.videoId || '',
      title: video.title || '',
      thumbnail_url: video.thumbnailUrl || video.thumbnail || '',
      views: toInt(video.viewCount || video.views || 0),
      likes: toInt(video.likeCount || video.likes || 0),
      comments: toInt(video.commentCount || video.comments || 0),
      published_at: video.publishedAt || video.uploadDate || null
    }));

    return new Response(
      JSON.stringify({
        success: true,
        channel: {
          channel_id: channel.channelId || channel.id || '',
          channel_name: channel.title || channel.channelTitle || 'Unknown Channel',
          thumbnail_url: channel.avatarUrl || channel.thumbnailUrl || '',
          subscribers: toInt(channel.subscriberCount || channel.subscribers || 0),
          total_views: toInt(channel.totalViews || channel.views || 0),
          video_count: toInt(channel.videoCount || channel.videos || 0),
          channel_url: channelUrl,
          videos
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('search-channel error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Sunucu hatası' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
