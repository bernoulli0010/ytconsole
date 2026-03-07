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

function parseCount(val: unknown): number {
  const raw = String(val ?? '').trim();
  if (!raw) return 0;
  const normalized = raw.replace(/,/g, '').replace(/\s+/g, '').toUpperCase();
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)([KMB])?/);
  if (!match) return toInt(raw);
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return toInt(raw);
  const suffix = match[2] || '';
  if (suffix === 'K') return Math.round(base * 1_000);
  if (suffix === 'M') return Math.round(base * 1_000_000);
  if (suffix === 'B') return Math.round(base * 1_000_000_000);
  return Math.round(base);
}

function extractVideoId(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const direct = text.match(/^[a-zA-Z0-9_-]{11}$/);
  if (direct) return direct[0];
  const urlMatch = text.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (urlMatch) return urlMatch[1];
  return '';
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function resolveChannelId(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (trimmed.startsWith('UC') && trimmed.length > 20) return trimmed;

  const url = getChannelUrl(trimmed);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return null;
    const html = await response.text();
    const m = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
    if (m) return m[1];
    const m2 = html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/);
    return m2 ? m2[1] : null;
  } catch {
    return null;
  }
}

async function fetchRssFallback(channelId: string) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const response = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) return null;
  const xml = await response.text();

  const titleMatch = xml.match(/<title>([^<]*)<\/title>/);
  const channelName = titleMatch ? decodeXml(titleMatch[1].replace(' - YouTube', '')) : 'Unknown Channel';

  const videos: any[] = [];
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null && videos.length < 5) {
    const entry = match[1];
    const videoId = (entry.match(/<yt:videoId>([^<]*)<\/yt:videoId>/) || [])[1] || '';
    const title = decodeXml(((entry.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim());
    const publishedAt = ((entry.match(/<published>([^<]*)<\/published>/) || [])[1] || '').trim() || null;
    const thumb = ((entry.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || '').trim();
    if (!videoId || !title) continue;
    videos.push({
      video_id: videoId,
      title,
      thumbnail_url: thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      views: 0,
      likes: 0,
      comments: 0,
      published_at: publishedAt
    });
  }

  return { channelName, videos };
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
    const candidateVideos = Array.isArray(channel.latestVideos)
      ? channel.latestVideos
      : Array.isArray(channel.videos)
        ? channel.videos
        : [];

    let videos = candidateVideos.slice(0, 8).map((video: any) => ({
      video_id: extractVideoId(video.id || video.videoId || video.url || video.videoUrl || ''),
      title: safeStr(video.title || video.name || ''),
      thumbnail_url: video.thumbnailUrl || video.thumbnail || '',
      views: parseCount(video.viewCount || video.views || 0),
      likes: parseCount(video.likeCount || video.likes || 0),
      comments: parseCount(video.commentCount || video.comments || 0),
      published_at: video.publishedAt || video.uploadDate || null
    })).filter((v) => v.video_id && v.title).slice(0, 5);

    const channelId = channel.channelId || channel.id || await resolveChannelId(channelUrl) || '';
    let fallbackChannelName = '';
    if (videos.length === 0 && channelId) {
      const rss = await fetchRssFallback(channelId);
      if (rss) {
        videos = rss.videos;
        fallbackChannelName = rss.channelName;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        channel: {
          channel_id: channelId,
          channel_name: channel.title || channel.channelTitle || fallbackChannelName || 'Unknown Channel',
          thumbnail_url: channel.avatarUrl || channel.thumbnailUrl || '',
          subscribers: parseCount(channel.subscriberCount || channel.subscribers || 0),
          total_views: parseCount(channel.totalViews || channel.views || 0),
          video_count: parseCount(channel.videoCount || channel.videos || 0),
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
