import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!
const APIFY_ACTOR_ID = 'h7sDV53CddomktSi5'
const DEFAULT_REFRESH_WINDOW_HOURS = 12

function toInt(val: unknown): number {
  const cleaned = String(val ?? "0").replace(/[^0-9-]/g, "");
  const parsed = Number.parseInt(cleaned || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCount(val: unknown): number {
  const raw = String(val ?? '').trim();
  if (!raw) return 0;

  const lower = raw.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  const isThousand = /\b(k|bin|b)\b/.test(lower) || compact.endsWith('k') || compact.endsWith('b');
  const isMillion = /\b(m|mn|milyon)\b/.test(lower) || compact.endsWith('m') || compact.includes('mn');
  const isBillion = /\b(bn|billion|milyar)\b/.test(lower) || compact.includes('bn');

  const numberPart = (lower.match(/[0-9][0-9.,]*/) || [])[0] || '';
  if (!numberPart) return toInt(raw);

  let base = 0;
  if (isThousand || isMillion || isBillion) {
    const normalized = numberPart.replace(/\./g, '').replace(',', '.');
    base = Number.parseFloat(normalized);
  } else {
    const normalized = numberPart.replace(/[^0-9]/g, '');
    base = Number.parseInt(normalized || '0', 10);
  }

  if (!Number.isFinite(base)) return toInt(raw);
  if (isBillion) return Math.round(base * 1_000_000_000);
  if (isMillion) return Math.round(base * 1_000_000);
  if (isThousand) return Math.round(base * 1_000);
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

function textFromNode(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => String(r?.text || '')).join('');
  return '';
}

function extractViewCountFromRenderer(renderer: any): number {
  const candidates = [
    textFromNode(renderer?.viewCountText),
    textFromNode(renderer?.shortViewCountText),
    String(renderer?.viewCountText?.accessibility?.accessibilityData?.label || ''),
    String(renderer?.shortViewCountText?.accessibility?.accessibilityData?.label || ''),
  ];

  for (const candidate of candidates) {
    const count = parseCount(candidate);
    if (count > 0) return count;
  }
  return 0;
}

function extractYtInitialData(html: string): any | null {
  const match = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function collectVideoRenderers(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (node.videoRenderer && typeof node.videoRenderer === 'object') {
    out.push(node.videoRenderer);
  }
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out);
    return out;
  }
  for (const key of Object.keys(node)) {
    collectVideoRenderers((node as any)[key], out);
  }
  return out;
}

function extractVideoRenderersFromHtml(html: string): any[] {
  const marker = '"videoRenderer":';
  const renderers: any[] = [];
  let idx = 0;

  while (idx < html.length) {
    const markerIdx = html.indexOf(marker, idx);
    if (markerIdx === -1) break;

    let start = markerIdx + marker.length;
    while (start < html.length && html[start] !== '{') start++;
    if (start >= html.length) break;

    let i = start;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else {
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const objStr = html.slice(start, i + 1);
            try {
              renderers.push(JSON.parse(objStr));
            } catch {
              // ignore broken snippets
            }
            break;
          }
        }
      }
    }

    idx = i + 1;
  }

  return renderers;
}

function parseRelativeTimeToIso(relativeText: string): string | null {
  const text = relativeText.toLowerCase().trim();
  const m = text.match(/(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years|minute|dakika|saat|gun|gün|hafta|ay|yıl|yil)\s*(ago|önce)?/);
  if (!m) return null;
  const value = Number.parseInt(m[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const d = new Date();
  const unit = m[2];
  if (unit.startsWith('minute') || unit.includes('dakika')) d.setMinutes(d.getMinutes() - value);
  else if (unit.startsWith('hour') || unit.includes('saat')) d.setHours(d.getHours() - value);
  else if (unit.startsWith('day') || unit.includes('gün') || unit.includes('gun')) d.setDate(d.getDate() - value);
  else if (unit.startsWith('week') || unit.includes('hafta')) d.setDate(d.getDate() - (value * 7));
  else if (unit.startsWith('month') || unit === 'ay') d.setMonth(d.getMonth() - value);
  else if (unit.startsWith('year') || unit.includes('yıl') || unit.includes('yil')) d.setFullYear(d.getFullYear() - value);
  return d.toISOString();
}

async function fetchChannelVideosFromPage(channelUrl: string): Promise<{
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  subscribers: number;
  videoCount: number;
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
  try {
    const base = channelUrl.replace(/\/$/, '');
    const videosUrl = base.includes('/videos')
      ? `${base}${base.includes('?') ? '&' : '?'}hl=en`
      : `${base}/videos?view=0&sort=dd&flow=grid&hl=en`;
    const response = await fetch(videosUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return null;
    const html = await response.text();
    const initialData = extractYtInitialData(html);
    let renderers = initialData ? collectVideoRenderers(initialData) : [];
    if (renderers.length === 0) {
      renderers = extractVideoRenderersFromHtml(html);
    }
    const rawVideos = renderers.slice(0, 10).map((renderer: any) => {
      const videoId = String(renderer.videoId || '').trim();
      const title = textFromNode(renderer.title);
      const thumbnails = renderer.thumbnail?.thumbnails || [];
      const thumbnailUrl = thumbnails.length > 0 ? (thumbnails[thumbnails.length - 1].url || '') : '';
      return {
        videoId,
        title,
        thumbnailUrl,
        views: extractViewCountFromRenderer(renderer),
        likes: 0,
        comments: 0,
        publishedAt: parseRelativeTimeToIso(textFromNode(renderer.publishedTimeText))
      };
    }).filter((v: any) => v.videoId && v.title);

    const channelId =
      (html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/) || [])[1] ||
      (html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/) || [])[1] ||
      '';
    const channelName = decodeXml(((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '').trim());
    const thumbnailUrl = ((html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '').trim();
    const subscribers = parseCount(
      ((html.match(/"subscriberCountText":\{"simpleText":"([^"]+)"\}/) || [])[1]) ||
      ((html.match(/"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"\}\}/) || [])[1]) ||
      '0'
    );
    const videoCount = parseCount(
      ((html.match(/"videosCountText":\{"runs":\[\{"text":"([^"]+)"/) || [])[1]) ||
      String(rawVideos.length)
    );

    return {
      channelId,
      channelName,
      thumbnailUrl,
      subscribers,
      videoCount,
      videos: enrichVideoMetrics(rawVideos)
    };
  } catch {
    return null;
  }
}

function normalizeText(text: unknown): string {
  return String(text ?? '').trim().toLowerCase();
}

function extractChannelIdFromUrl(url: string): string {
  const m = String(url || '').match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
  return m ? m[1] : '';
}

function getRunInput(query: string, startUrl?: string) {
  return {
    searchQueries: [query],
    maxResults: 20,
    maxResultsShorts: 0,
    maxResultStreams: 0,
    startUrls: startUrl ? [{ url: startUrl }] : [],
    downloadSubtitles: null,
    saveSubsToKVS: null,
    subtitlesLanguage: 'en',
    preferAutoGeneratedSubtitles: null,
    subtitlesFormat: 'srt',
    sortingOrder: null,
    dateFilter: null,
    videoType: null,
    lengthFilter: null,
    isHD: null,
    hasSubtitles: null,
    hasCC: null,
    is3D: null,
    isLive: null,
    isBought: null,
    is4K: null,
    is360: null,
    hasLocation: null,
    isHDR: null,
    isVR180: null,
    oldestPostDate: null,
    sortVideosBy: null,
  };
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
  const query = channelUrl
    .replace('https://www.youtube.com/', '')
    .replace('https://youtube.com/', '')
    .replace(/^@/, '')
    .trim();

  const runResponse = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(getRunInput(query || channelUrl, channelUrl.startsWith('http') ? channelUrl : undefined))
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

    const statusResponse = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_API_KEY}`);
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

  const grouped = new Map<string, any[]>();
  for (const item of items) {
    const itemChannelId =
      String(item.channelId || item.authorChannelId || item.ownerChannelId || item.channel?.id || '').trim() ||
      extractChannelIdFromUrl(String(item.channelUrl || item.authorUrl || item.channel?.url || ''));
    const key = itemChannelId || String(item.channelName || item.channelTitle || item.author || item.ownerText || item.channel?.name || '').trim() || 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  const desired = normalizeText(channelUrl);
  let bestGroup: any[] = [];
  for (const [, list] of grouped.entries()) {
    if (list.length > bestGroup.length) bestGroup = list;
    const first = list[0] || {};
    const channelName = normalizeText(first.channelName || first.channelTitle || first.author || first.ownerText || first.channel?.name);
    const channelUrlCandidate = normalizeText(first.channelUrl || first.authorUrl || first.channel?.url);
    if (desired && (channelName.includes(desired.replace('@', '')) || channelUrlCandidate.includes(desired.replace('https://', '').replace('http://', '')))) {
      bestGroup = list;
      break;
    }
  }

  const best = bestGroup.length ? bestGroup : items;
  const first = best[0] || {};

  const rawVideos = best.map((v: any) => ({
    videoId: extractVideoId(v.videoId || v.id || v.url || v.videoUrl || v.webpageUrl || ''),
    title: String(v.title || v.name || v.videoTitle || '').trim(),
    thumbnailUrl: v.thumbnailUrl || v.thumbnail || v.thumbnail_url || v.thumbnail?.url || '',
    views: parseCount(v.viewCount || v.views || v.view_count || '0'),
    likes: parseCount(v.likeCount || v.likes || v.like_count || '0'),
    comments: parseCount(v.commentCount || v.comments || v.comment_count || '0'),
    publishedAt: v.publishedAt || v.uploadDate || v.publishedTimeText || ''
  })).filter((v: { videoId: string; title: string }) => Boolean(v.videoId) && Boolean(v.title));

  const uniqueByVideo = new Map<string, any>();
  for (const video of rawVideos) {
    if (!uniqueByVideo.has(video.videoId)) uniqueByVideo.set(video.videoId, video);
  }

  let videos = enrichVideoMetrics(Array.from(uniqueByVideo.values()).slice(0, 10));
  let fallbackChannelName = '';
  const channelId =
    String(first.channelId || first.authorChannelId || first.ownerChannelId || first.channel?.id || '').trim() ||
    extractChannelIdFromUrl(String(first.channelUrl || first.authorUrl || first.channel?.url || '')) ||
    '';
  if (videos.length === 0 && channelId) {
    const rss = await fetchRssFallback(channelId);
    if (rss) {
      videos = rss.videos;
      fallbackChannelName = rss.channelName;
    }
  }

  const subscribers = parseCount(first.subscriberCount || first.subscribers || first.channelSubscriberCount || first.channel?.subscriberCount || '0');
  const totalViews = parseCount(first.totalViews || first.channelViews || first.channel?.totalViews || '0');
  const videoCount = parseCount(first.videoCount || first.channelVideoCount || first.channel?.videoCount || '0') || videos.length;

  const needsChannelEnhance = subscribers === 0 || videos.length === 0 || videos.every((v) => (v.views || 0) === 0);
  if (needsChannelEnhance) {
    const pageData = await fetchChannelVideosFromPage(channelUrl);
    if (pageData) {
      if (pageData.videos.length > 0) {
        videos = pageData.videos;
      }
      return {
        channelName: pageData.channelName || first.channelName || first.channelTitle || first.author || first.ownerText || first.channel?.name || fallbackChannelName || 'Unknown Channel',
        thumbnailUrl: pageData.thumbnailUrl || first.channelAvatarUrl || first.avatarUrl || first.channelThumbnailUrl || first.thumbnailUrl || first.channel?.avatarUrl || '',
        subscribers: pageData.subscribers || subscribers,
        totalViews,
        videoCount: pageData.videoCount || videoCount || videos.length,
        description: first.channelDescription || first.description || '',
        videos
      };
    }
  }

  return {
    channelName: first.channelName || first.channelTitle || first.author || first.ownerText || first.channel?.name || fallbackChannelName || 'Unknown Channel',
    thumbnailUrl: first.channelAvatarUrl || first.avatarUrl || first.channelThumbnailUrl || first.thumbnailUrl || first.channel?.avatarUrl || '',
    subscribers,
    totalViews,
    videoCount,
    description: first.channelDescription || first.description || '',
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
        const forceRefresh = body?.force === true;
        if (!forceRefresh && !isStale(channel.last_fetched, refreshWindowHours)) {
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
