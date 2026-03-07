import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!
const DEFAULT_REFRESH_WINDOW_HOURS = 12

function toInt(val: unknown): number {
  const cleaned = String(val ?? "0").replace(/[^0-9-]/g, "");
  const parsed = Number.parseInt(cleaned || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCount(val: unknown): number {
  const raw = String(val ?? "").trim();
  if (!raw) return 0;
  const normalized = raw.replace(/,/g, "").replace(/\s+/g, "").toUpperCase();
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)([KMB])?/);
  if (!match) return toInt(raw);
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return toInt(raw);
  const suffix = match[2] || "";
  if (suffix === "K") return Math.round(base * 1_000);
  if (suffix === "M") return Math.round(base * 1_000_000);
  if (suffix === "B") return Math.round(base * 1_000_000_000);
  return Math.round(base);
}

function extractVideoId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const direct = text.match(/^[a-zA-Z0-9_-]{11}$/);
  if (direct) return direct[0];
  const urlMatch = text.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (urlMatch) return urlMatch[1];
  return "";
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchRssFallback(channelId: string): Promise<{
  channelName: string;
  videos: {
    videoId: string;
    title: string;
    thumbnailUrl: string;
    views: number;
    likes: number;
    comments: number;
    publishedAt: string | null;
    publishedHoursAgo: number | null;
    vph: number;
    engagementRate: number;
    outlierScore: number;
  }[];
} | null> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const response = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) return null;
  const xml = await response.text();

  const titleMatch = xml.match(/<title>([^<]*)<\/title>/);
  const channelName = titleMatch ? decodeXml(titleMatch[1].replace(' - YouTube', '')) : 'Unknown Channel';

  const entries: Array<{
    videoId: string;
    title: string;
    thumbnailUrl: string;
    views: number;
    likes: number;
    comments: number;
    publishedAt: string | null;
  }> = [];

  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null && entries.length < 10) {
    const entry = match[1];
    const videoId = (entry.match(/<yt:videoId>([^<]*)<\/yt:videoId>/) || [])[1] || '';
    const title = decodeXml(((entry.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim());
    const publishedAt = ((entry.match(/<published>([^<]*)<\/published>/) || [])[1] || '').trim() || null;
    const thumb = ((entry.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || '').trim();
    if (!videoId || !title) continue;
    entries.push({
      videoId,
      title,
      thumbnailUrl: thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      views: 0,
      likes: 0,
      comments: 0,
      publishedAt
    });
  }

  return {
    channelName,
    videos: enrichVideoMetrics(entries)
  };
}

function safeDate(val: unknown): string | null {
  if (!val) return null;
  const d = new Date(String(val));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function enrichVideoMetrics(videos: Array<{
  videoId: string;
  title: string;
  thumbnailUrl: string;
  views: number;
  likes: number;
  comments: number;
  publishedAt: string | null;
}>) {
  if (videos.length === 0) return [];

  const averageViews = videos.reduce((sum, video) => sum + (video.views || 0), 0) / videos.length;
  const safeAverageViews = Math.max(averageViews, 1);

  return videos.map((video) => {
    const publishedAtIso = safeDate(video.publishedAt);
    let publishedHoursAgo: number | null = null;

    if (publishedAtIso) {
      const hours = (Date.now() - new Date(publishedAtIso).getTime()) / 3600000;
      if (Number.isFinite(hours) && hours > 0) {
        publishedHoursAgo = roundMetric(Math.max(hours, 1));
      }
    }

    const vph = publishedHoursAgo ? roundMetric(video.views / publishedHoursAgo) : 0;
    const engagementRate = video.views > 0
      ? roundMetric(((video.likes + video.comments) / video.views) * 100)
      : 0;
    const outlierScore = roundMetric((video.views / safeAverageViews) * 100);

    return {
      ...video,
      publishedAt: publishedAtIso,
      publishedHoursAgo,
      vph,
      engagementRate,
      outlierScore
    };
  });
}

async function fetchChannelWithApify(channelUrl: string): Promise<{
  channelName: string;
  thumbnailUrl: string;
  subscribers: number;
  totalViews: number;
  videoCount: number;
  description: string;
  videos: {
    videoId: string;
    title: string;
    thumbnailUrl: string;
    views: number;
    likes: number;
    comments: number;
    publishedAt: string | null;
    publishedHoursAgo: number | null;
    vph: number;
    engagementRate: number;
    outlierScore: number;
  }[];
} | null> {
  const actorId = "streamers~youtube-channel-scraper";

  const runResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls: [{ url: channelUrl }],
      maxResults: 10,
      sortVideosBy: "NEWEST"
    })
  });

  if (!runResponse.ok) {
    console.error('Apify run error:', await runResponse.text());
    return null;
  }

  const runData = await runResponse.json();
  const runId = runData.data.id;

  let attempts = 0;
  while (attempts < 30) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/${runId}?token=${APIFY_API_KEY}`);
    const statusData = await statusResponse.json();

    if (statusData.data.status === 'SUCCEEDED') break;
    if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') {
      console.error('Apify run failed:', statusData.data.status);
      return null;
    }

    attempts++;
  }

  const datasetId = runData.data.defaultDatasetId;
  const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`);
  if (!itemsResponse.ok) {
    console.error('Apify dataset error:', await itemsResponse.text());
    return null;
  }

  const items = await itemsResponse.json();
  if (!items || items.length === 0) return null;

  const channel = items[0];
  const candidateVideos = Array.isArray(channel.latestVideos)
    ? channel.latestVideos
    : Array.isArray(channel.videos)
      ? channel.videos
      : [];

  const rawVideos = candidateVideos.map((v: any) => ({
    videoId: extractVideoId(v.id || v.videoId || v.url || v.videoUrl || ''),
    title: String(v.title || v.name || '').trim(),
    thumbnailUrl: v.thumbnailUrl || v.thumbnail || '',
    views: parseCount(v.viewCount || v.views || '0'),
    likes: parseCount(v.likeCount || v.likes || '0'),
    comments: parseCount(v.commentCount || v.comments || '0'),
    publishedAt: v.publishedAt || v.uploadDate || ''
  })).filter((v: { videoId: string; title: string }) => Boolean(v.videoId) && Boolean(v.title));

  let videos = enrichVideoMetrics(rawVideos);
  let fallbackChannelName = '';
  const channelId = channel.channelId || channel.id || '';
  if (videos.length === 0 && channelId) {
    const rss = await fetchRssFallback(channelId);
    if (rss) {
      videos = rss.videos;
      fallbackChannelName = rss.channelName;
    }
  }

  return {
    channelName: channel.title || channel.channelTitle || fallbackChannelName || 'Unknown Channel',
    thumbnailUrl: channel.avatarUrl || channel.thumbnailUrl || '',
    subscribers: parseCount(channel.subscriberCount || channel.subscribers || '0'),
    totalViews: parseCount(channel.totalViews || channel.views || '0'),
    videoCount: parseCount(channel.videoCount || channel.videos || '0'),
    description: channel.description || '',
    videos
  };
}

function isStale(lastFetched: string | null, refreshWindowHours: number): boolean {
  if (!lastFetched) return true;
  const last = new Date(lastFetched);
  if (Number.isNaN(last.getTime())) return true;
  const diffHours = (Date.now() - last.getTime()) / 3600000;
  return diffHours >= refreshWindowHours;
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
    if (req.method === 'POST') {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const refreshRequested = body?.refresh === true;
    const refreshWindowHours = Number.isFinite(Number(body?.refresh_window_hours))
      ? Math.max(1, Number(body.refresh_window_hours))
      : DEFAULT_REFRESH_WINDOW_HOURS;
    const requestedChannelIds: string[] = Array.isArray(body?.channel_ids)
      ? body.channel_ids.filter((id: unknown) => typeof id === 'string')
      : [];

    const { data: channels, error: fetchError } = await supabase
      .from('competitor_channels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (fetchError) {
      console.error('Fetch channels error:', fetchError);
      return new Response(
        JSON.stringify({ error: 'Kanallar alınırken hata oluştu' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!channels || channels.length === 0) {
      return new Response(
        JSON.stringify({ success: true, competitors: [], message: 'Takip edilen rakip bulunmuyor' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const refreshCandidates = requestedChannelIds.length > 0
      ? channels.filter((channel) => requestedChannelIds.includes(channel.id))
      : channels;

    let refreshedCount = 0;
    if (refreshRequested) {
      for (const channel of refreshCandidates) {
        if (!isStale(channel.last_fetched, refreshWindowHours)) {
          continue;
        }

        const channelUrl = channel.channel_url || `https://www.youtube.com/channel/${channel.channel_id}`;
        const channelData = await fetchChannelWithApify(channelUrl);

        if (!channelData) continue;

        await supabase
          .from('competitor_channels')
          .update({
            channel_name: channelData.channelName,
            thumbnail_url: channelData.thumbnailUrl,
            subscribers: channelData.subscribers,
            total_views: channelData.totalViews,
            video_count: channelData.videoCount,
            description: channelData.description,
            last_fetched: new Date().toISOString()
          })
          .eq('id', channel.id);

        if (channelData.videos.length > 0) {
          const videoRecords = channelData.videos.map((video) => ({
            channel_id: channel.id,
            video_id: video.videoId,
            title: video.title,
            thumbnail_url: video.thumbnailUrl,
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            published_at: video.publishedAt,
            published_hours_ago: video.publishedHoursAgo,
            vph: video.vph,
            outlier_score: video.outlierScore,
            engagement_rate: video.engagementRate,
            last_fetched: new Date().toISOString()
          }));

          await supabase
            .from('competitor_videos')
            .upsert(videoRecords, { onConflict: 'channel_id,video_id' });
        }

        refreshedCount++;
      }
    }

    const { data: finalChannels, error: finalChannelsError } = await supabase
      .from('competitor_channels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (finalChannelsError || !finalChannels) {
      return new Response(
        JSON.stringify({ error: 'Kanallar güncel alınamadı' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const channelIds = finalChannels.map((channel) => channel.id);
    const { data: videos } = await supabase
      .from('competitor_videos')
      .select('*')
      .in('channel_id', channelIds)
      .order('published_at', { ascending: false });

    const videosByChannel = new Map<string, any[]>();
    for (const video of (videos || [])) {
      if (!videosByChannel.has(video.channel_id)) {
        videosByChannel.set(video.channel_id, []);
      }
      const channelVideos = videosByChannel.get(video.channel_id)!;
      if (channelVideos.length < 10) {
        channelVideos.push(video);
      }
    }

    const competitors = finalChannels.map((channel) => ({
      ...channel,
      videos: videosByChannel.get(channel.id) || []
    }));

    return new Response(
      JSON.stringify({
        success: true,
        competitors,
        refreshed_count: refreshedCount,
        refresh_requested: refreshRequested
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error("fetch-all-competitors error:", error);
    return new Response(
      JSON.stringify({ error: error.message || 'Sunucu hatası' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
