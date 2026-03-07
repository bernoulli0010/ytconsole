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
const DEFAULT_REFRESH_WINDOW_HOURS = 12

function safeStr(val: unknown): string { return typeof val === "string" ? val.trim() : ""; }
function toInt(val: unknown): number { return Number.parseInt(String(val ?? "0").replace(/[^0-9-]/g, "") || "0", 10) || 0; }
function decodeXml(t: string): string { return t.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
function safeDate(val: unknown): string | null { if (!val) return null; const d = new Date(String(val)); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function roundMetric(v: number): number { return Number(v.toFixed(4)); }

async function fetchRssVideos(channelId: string) {
  try {
    const resp = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
      videos.push({ videoId, title, thumbnailUrl: thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, publishedAt });
    }
    return { channelName, videos };
  } catch { return null; }
}

async function enrichVideosWithApify(videoIds: string[]): Promise<Map<string, { views: number; likes: number; comments: number }>> {
  const result = new Map<string, { views: number; likes: number; comments: number }>();
  if (videoIds.length === 0) return result;
  const urls = videoIds.map(id => `https://www.youtube.com/watch?v=${id}`);
  try {
    const runResp = await fetch(`https://api.apify.com/v2/acts/${APIFY_VIDEO_ACTOR}/runs?token=${APIFY_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls })
    });
    if (!runResp.ok) return result;
    const runData = await runResp.json();
    const runId = runData.data.id;
    let attempts = 0;
    while (attempts < 45) {
      await new Promise(r => setTimeout(r, 2000));
      const statusResp = await fetch(`https://api.apify.com/v2/acts/${APIFY_VIDEO_ACTOR}/runs/${runId}?token=${APIFY_API_KEY}`);
      const statusData = await statusResp.json();
      if (statusData.data.status === 'SUCCEEDED') break;
      if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') return result;
      attempts++;
    }
    const datasetId = runData.data.defaultDatasetId;
    const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`);
    if (!itemsResp.ok) return result;
    const items = await itemsResp.json();
    for (const item of (items || [])) {
      const videoId = safeStr(item.id) || safeStr(item.videoId) || ((safeStr(item.url)||safeStr(item.videoUrl)).match(/v=([a-zA-Z0-9_-]{11})/)||[])[1] || '';
      if (!videoId) continue;
      result.set(videoId, { views: toInt(item.viewCount??item.views??0), likes: toInt(item.likeCount??item.likes??0), comments: toInt(item.commentCount??item.comments??0) });
    }
  } catch (e) { console.error('enrichVideosWithApify error:', e); }
  return result;
}

function enrichVideoMetrics(videos: Array<{ videoId: string; title: string; thumbnailUrl: string; views: number; likes: number; comments: number; publishedAt: string | null; }>) {
  if (videos.length === 0) return [];
  const avgViews = Math.max(videos.reduce((s, v) => s + (v.views || 0), 0) / videos.length, 1);
  return videos.map(video => {
    const publishedAtIso = safeDate(video.publishedAt);
    let publishedHoursAgo: number | null = null;
    if (publishedAtIso) { const hours = (Date.now() - new Date(publishedAtIso).getTime()) / 3600000; if (Number.isFinite(hours) && hours > 0) publishedHoursAgo = roundMetric(Math.max(hours, 1)); }
    const vph = publishedHoursAgo ? roundMetric(video.views / publishedHoursAgo) : 0;
    const engagementRate = video.views > 0 ? roundMetric(((video.likes + video.comments) / video.views) * 100) : 0;
    const outlierScore = roundMetric((video.views / avgViews) * 100);
    return { ...video, publishedAt: publishedAtIso, publishedHoursAgo, vph, engagementRate, outlierScore };
  });
}

function isStale(lastFetched: string | null, windowHours: number): boolean {
  if (!lastFetched) return true;
  const last = new Date(lastFetched);
  if (Number.isNaN(last.getTime())) return true;
  return (Date.now() - last.getTime()) / 3600000 >= windowHours;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return new Response(JSON.stringify({ error: 'Yetkilendirme gerekli' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const accessToken = authHeader.replace('Bearer ', '').trim();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) return new Response(JSON.stringify({ error: 'Geçersiz yetkilendirme' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    let body: any = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
    const refreshRequested = body?.refresh === true;
    const forceRefresh = body?.force === true;
    const refreshWindowHours = Number(body?.refresh_window_hours) || DEFAULT_REFRESH_WINDOW_HOURS;

    const { data: channels, error: fetchError } = await supabase.from('competitor_channels').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    if (fetchError) return new Response(JSON.stringify({ error: 'Kanallar alınırken hata oluştu' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!channels || channels.length === 0) return new Response(JSON.stringify({ success: true, competitors: [], message: 'Takip edilen rakip bulunmuyor' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    let refreshedCount = 0;
    if (refreshRequested) {
      for (const channel of channels) {
        if (!forceRefresh && !isStale(channel.last_fetched, refreshWindowHours)) continue;
        const channelId = channel.channel_id;
        if (!channelId) continue;
        const rss = await fetchRssVideos(channelId);
        if (!rss || rss.videos.length === 0) continue;
        const videoIds = rss.videos.map(v => v.videoId);
        const apifyData = await enrichVideosWithApify(videoIds);
        const mergedVideos = rss.videos.map(v => ({ videoId: v.videoId, title: v.title, thumbnailUrl: v.thumbnailUrl, views: apifyData.get(v.videoId)?.views || 0, likes: apifyData.get(v.videoId)?.likes || 0, comments: apifyData.get(v.videoId)?.comments || 0, publishedAt: v.publishedAt }));
        const enriched = enrichVideoMetrics(mergedVideos);
        await supabase.from('competitor_channels').update({ channel_name: rss.channelName || channel.channel_name, video_count: rss.videos.length, last_fetched: new Date().toISOString() }).eq('id', channel.id);
        if (enriched.length > 0) {
          const videoRecords = enriched.map(v => ({ channel_id: channel.id, video_id: v.videoId, title: v.title, thumbnail_url: v.thumbnailUrl, views: v.views, likes: v.likes, comments: v.comments, published_at: v.publishedAt, published_hours_ago: v.publishedHoursAgo, vph: v.vph, outlier_score: v.outlierScore, engagement_rate: v.engagementRate, last_fetched: new Date().toISOString() }));
          await supabase.from('competitor_videos').upsert(videoRecords, { onConflict: 'channel_id,video_id' });
        }
        refreshedCount++;
      }
    }

    const { data: finalChannels } = await supabase.from('competitor_channels').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    const channelIds = (finalChannels || []).map(c => c.id);
    const { data: videos } = await supabase.from('competitor_videos').select('*').in('channel_id', channelIds).order('published_at', { ascending: false });
    const videosByChannel = new Map<string, any[]>();
    for (const video of (videos || [])) { if (!videosByChannel.has(video.channel_id)) videosByChannel.set(video.channel_id, []); const list = videosByChannel.get(video.channel_id)!; if (list.length < 10) list.push(video); }
    const competitors = (finalChannels || []).map(channel => ({ ...channel, videos: videosByChannel.get(channel.id) || [] }));

    return new Response(JSON.stringify({ success: true, competitors, refreshed_count: refreshedCount, refresh_requested: refreshRequested }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error("fetch-all-competitors error:", error);
    return new Response(JSON.stringify({ error: error.message || 'Sunucu hatası' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
