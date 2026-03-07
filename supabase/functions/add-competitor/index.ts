import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!
const APIFY_VIDEO_ACTOR = 'mnpodfgT78RRnnnAT'

// ── Helpers ──

function safeStr(val: unknown): string {
  if (typeof val === "string") return val.trim();
  return "";
}

function toInt(val: unknown): number {
  const cleaned = String(val ?? "0").replace(/[^0-9-]/g, "");
  return Number.parseInt(cleaned || "0", 10) || 0;
}

function decodeXml(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function safeDate(val: unknown): string | null {
  if (!val) return null;
  const d = new Date(String(val));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function roundMetric(v: number): number { return Number(v.toFixed(4)); }

function getChannelUrl(input: string): string {
  const t = input.trim();
  if (t.startsWith('http')) return t;
  if (t.startsWith('@')) return `https://www.youtube.com/${t}`;
  if (t.startsWith('UC') && t.length > 20) return `https://www.youtube.com/channel/${t}`;
  return `https://www.youtube.com/@${t}`;
}

// ── Step 1: Resolve channel ID + meta from YouTube page ──

async function resolveChannel(channelUrl: string): Promise<{
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  subscribers: number;
  description: string;
} | null> {
  try {
    const resp = await fetch(channelUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow'
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    const channelId =
      (html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/) || [])[1] ||
      (html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/) || [])[1] || '';
    if (!channelId) return null;

    const channelName = decodeXml(((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '').trim()) || 'Unknown Channel';
    const thumbnailUrl = ((html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '').trim();
    const description = decodeXml(((html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1] || '').trim());

    let subscribers = 0;
    const subMatch = html.match(/"subscriberCountText":\s*\{[^}]*?"simpleText"\s*:\s*"([^"]+)"/);
    if (subMatch) {
      subscribers = parseSubscribers(subMatch[1]);
    } else {
      const subLabel = html.match(/"subscriberCountText"[\s\S]*?"label"\s*:\s*"([^"]+)"/);
      if (subLabel) subscribers = parseSubscribers(subLabel[1]);
    }

    return { channelId, channelName, thumbnailUrl, subscribers, description };
  } catch (e) {
    console.error('resolveChannel error:', e);
    return null;
  }
}

function parseSubscribers(text: string): number {
  const lower = text.toLowerCase().replace(/subscribers?/gi, '').replace(/abone/gi, '').trim();
  const m = lower.match(/([0-9][0-9.,]*)\s*([kmb])?/i);
  if (!m) return 0;
  const num = Number.parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(num)) return 0;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') return Math.round(num * 1000);
  if (suffix === 'M') return Math.round(num * 1000000);
  if (suffix === 'B') return Math.round(num * 1000000000);
  return Math.round(num);
}

// ── Step 2: Get video list from RSS ──

async function fetchRssVideos(channelId: string): Promise<{
  channelName: string;
  videos: { videoId: string; title: string; thumbnailUrl: string; publishedAt: string | null }[];
} | null> {
  try {
    const resp = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!resp.ok) return null;
    const xml = await resp.text();

    const titleMatch = xml.match(/<title>([^<]*)<\/title>/);
    const channelName = titleMatch ? decodeXml(titleMatch[1].replace(' - YouTube', '')) : 'Unknown Channel';

    const videos: { videoId: string; title: string; thumbnailUrl: string; publishedAt: string | null }[] = [];
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(xml)) !== null && videos.length < 10) {
      const entry = match[1];
      const videoId = (entry.match(/<yt:videoId>([^<]*)<\/yt:videoId>/) || [])[1] || '';
      const title = decodeXml(((entry.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim());
      const publishedAt = ((entry.match(/<published>([^<]*)<\/published>/) || [])[1] || '').trim() || null;
      const thumb = ((entry.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || '').trim();
      if (!videoId || !title) continue;
      videos.push({
        videoId,
        title,
        thumbnailUrl: thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        publishedAt
      });
    }
    return { channelName, videos };
  } catch (e) {
    console.error('fetchRssVideos error:', e);
    return null;
  }
}

// ── Step 3: Enrich videos with Apify mnpodfgT78RRnnnAT actor ──

async function enrichVideosWithApify(videoIds: string[]): Promise<Map<string, { views: number; likes: number; comments: number }>> {
  const result = new Map<string, { views: number; likes: number; comments: number }>();
  if (videoIds.length === 0) return result;

  const urls = videoIds.map(id => `https://www.youtube.com/watch?v=${id}`);

  try {
    const runResp = await fetch(`https://api.apify.com/v2/acts/${APIFY_VIDEO_ACTOR}/runs?token=${APIFY_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls })
    });
    if (!runResp.ok) {
      console.error('Apify video actor run error:', await runResp.text());
      return result;
    }

    const runData = await runResp.json();
    const runId = runData.data.id;

    // Wait for completion (max 90 seconds)
    let attempts = 0;
    while (attempts < 45) {
      await new Promise(r => setTimeout(r, 2000));
      const statusResp = await fetch(`https://api.apify.com/v2/acts/${APIFY_VIDEO_ACTOR}/runs/${runId}?token=${APIFY_API_KEY}`);
      const statusData = await statusResp.json();
      if (statusData.data.status === 'SUCCEEDED') break;
      if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') {
        console.error('Apify video actor failed:', statusData.data.status);
        return result;
      }
      attempts++;
    }

    const datasetId = runData.data.defaultDatasetId;
    const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`);
    if (!itemsResp.ok) return result;
    const items = await itemsResp.json();

    for (const item of (items || [])) {
      const videoId =
        safeStr(item.id) ||
        safeStr(item.videoId) ||
        ((safeStr(item.url) || safeStr(item.videoUrl)).match(/v=([a-zA-Z0-9_-]{11})/) || [])[1] || '';
      if (!videoId) continue;

      const views = toInt(item.viewCount ?? item.views ?? item.view_count ?? 0);
      const likes = toInt(item.likeCount ?? item.likes ?? item.like_count ?? 0);
      const comments = toInt(item.commentCount ?? item.comments ?? item.comment_count ?? 0);

      result.set(videoId, { views, likes, comments });
    }
  } catch (e) {
    console.error('enrichVideosWithApify error:', e);
  }

  return result;
}

// ── Metrics ──

function enrichVideoMetrics(videos: Array<{
  videoId: string; title: string; thumbnailUrl: string;
  views: number; likes: number; comments: number; publishedAt: string | null;
}>) {
  if (videos.length === 0) return [];
  const avgViews = Math.max(videos.reduce((s, v) => s + (v.views || 0), 0) / videos.length, 1);

  return videos.map(video => {
    const publishedAtIso = safeDate(video.publishedAt);
    let publishedHoursAgo: number | null = null;
    if (publishedAtIso) {
      const hours = (Date.now() - new Date(publishedAtIso).getTime()) / 3600000;
      if (Number.isFinite(hours) && hours > 0) publishedHoursAgo = roundMetric(Math.max(hours, 1));
    }
    const vph = publishedHoursAgo ? roundMetric(video.views / publishedHoursAgo) : 0;
    const engagementRate = video.views > 0 ? roundMetric(((video.likes + video.comments) / video.views) * 100) : 0;
    const outlierScore = roundMetric((video.views / avgViews) * 100);

    return { ...video, publishedAt: publishedAtIso, publishedHoursAgo, vph, engagementRate, outlierScore };
  });
}

// ── Main: Combine RSS + Apify ──

async function fetchChannelData(channelUrl: string) {
  // Step 1: Resolve channel
  const channelMeta = await resolveChannel(channelUrl);
  if (!channelMeta || !channelMeta.channelId) {
    console.error('Could not resolve channel:', channelUrl);
    return null;
  }

  // Step 2: Get video list from RSS
  const rss = await fetchRssVideos(channelMeta.channelId);
  if (!rss || rss.videos.length === 0) {
    console.error('No RSS videos for channel:', channelMeta.channelId);
    return {
      channelId: channelMeta.channelId,
      channelName: channelMeta.channelName,
      thumbnailUrl: channelMeta.thumbnailUrl,
      subscribers: channelMeta.subscribers,
      totalViews: 0,
      videoCount: 0,
      description: channelMeta.description,
      videos: []
    };
  }

  // Step 3: Enrich with Apify (views, likes, comments)
  const videoIds = rss.videos.map(v => v.videoId);
  const apifyData = await enrichVideosWithApify(videoIds);

  // Merge
  const mergedVideos = rss.videos.map(v => {
    const apify = apifyData.get(v.videoId);
    return {
      videoId: v.videoId,
      title: v.title,
      thumbnailUrl: v.thumbnailUrl,
      views: apify?.views || 0,
      likes: apify?.likes || 0,
      comments: apify?.comments || 0,
      publishedAt: v.publishedAt
    };
  });

  const enriched = enrichVideoMetrics(mergedVideos);

  return {
    channelId: channelMeta.channelId,
    channelName: channelMeta.channelName || rss.channelName,
    thumbnailUrl: channelMeta.thumbnailUrl,
    subscribers: channelMeta.subscribers,
    totalViews: 0,
    videoCount: rss.videos.length,
    description: channelMeta.description,
    videos: enriched
  };
}

// ── Serve ──

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Yetkilendirme gerekli' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const accessToken = authHeader.replace('Bearer ', '').trim();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Geçersiz yetkilendirme' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { query } = await req.json();
    const channelQuery = safeStr(query);
    if (!channelQuery) {
      return new Response(JSON.stringify({ error: 'Kanal URL veya kullanıcı adı gerekli' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Token check
    const { data: profile } = await supabase.from('profiles').select('token_balance').eq('id', user.id).single();
    if (!profile) {
      return new Response(JSON.stringify({ error: 'Profil bulunamadı' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (profile.token_balance < 2) {
      return new Response(JSON.stringify({ error: 'Yetersiz token. Rakip eklemek için en az 2 token gerekli.', code: 'INSUFFICIENT_TOKENS' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Limit check
    const { count } = await supabase.from('competitor_channels').select('*', { count: 'exact', head: true }).eq('user_id', user.id);
    if (count !== null && count >= 10) {
      return new Response(JSON.stringify({ error: 'Maksimum rakip sayısına ulaştınız (10).', code: 'LIMIT_REACHED' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const channelUrl = getChannelUrl(channelQuery);
    const channelData = await fetchChannelData(channelUrl);

    if (!channelData || !channelData.channelId) {
      return new Response(JSON.stringify({ error: 'Kanal bulunamadı. Geçerli bir YouTube kanal URL girin.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Duplicate check
    const { data: existing } = await supabase.from('competitor_channels')
      .select('id, channel_name').eq('user_id', user.id).eq('channel_id', channelData.channelId).single();
    if (existing) {
      return new Response(JSON.stringify({ error: `Bu kanal zaten takip ediliyor: ${existing.channel_name}`, code: 'ALREADY_EXISTS' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Save channel
    const { data: newChannel, error: insertErr } = await supabase.from('competitor_channels').insert({
      user_id: user.id,
      channel_id: channelData.channelId,
      channel_name: channelData.channelName,
      channel_url: channelUrl,
      thumbnail_url: channelData.thumbnailUrl,
      subscribers: channelData.subscribers,
      total_views: channelData.totalViews,
      video_count: channelData.videoCount,
      description: channelData.description,
      last_fetched: new Date().toISOString()
    }).select().single();

    if (insertErr || !newChannel) {
      console.error('Insert channel error:', insertErr);
      return new Response(JSON.stringify({ error: 'Kanal kaydedilirken hata oluştu' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Save videos
    if (channelData.videos.length > 0) {
      const videoRecords = channelData.videos.map(v => ({
        channel_id: newChannel.id,
        video_id: v.videoId,
        title: v.title,
        thumbnail_url: v.thumbnailUrl,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        published_at: v.publishedAt,
        published_hours_ago: v.publishedHoursAgo,
        vph: v.vph,
        outlier_score: v.outlierScore,
        engagement_rate: v.engagementRate
      }));
      await supabase.from('competitor_videos').upsert(videoRecords, { onConflict: 'channel_id,video_id' });
    }

    // Deduct tokens
    const newTokenBalance = profile.token_balance - 2;
    await supabase.from('profiles').update({ token_balance: newTokenBalance }).eq('id', user.id);

    return new Response(JSON.stringify({
      success: true,
      channel: { ...newChannel, videos: channelData.videos },
      tokens_deducted: 2,
      new_token_balance: newTokenBalance
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error("add-competitor error:", error);
    return new Response(JSON.stringify({ error: error.message || 'Sunucu hatası' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
