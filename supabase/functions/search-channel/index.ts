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

function textFromNode(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => String(r?.text || '')).join('');
  return '';
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

async function fetchChannelPreviewFromPage(channelUrl: string) {
  try {
    const base = channelUrl.replace(/\/$/, '');
    const videosUrl = base.includes('/videos')
      ? `${base}${base.includes('?') ? '&' : '?'}hl=en`
      : `${base}/videos?view=0&sort=dd&flow=grid&hl=en`;
    const response = await fetch(videosUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return null;
    const html = await response.text();
    const initialData = extractYtInitialData(html);
    const renderers = initialData ? collectVideoRenderers(initialData) : [];
    const videos = renderers.slice(0, 5).map((renderer: any) => {
      const videoId = String(renderer.videoId || '').trim();
      const title = textFromNode(renderer.title);
      const thumbnails = renderer.thumbnail?.thumbnails || [];
      const thumbnailUrl = thumbnails.length > 0 ? (thumbnails[thumbnails.length - 1].url || '') : '';
      return {
        video_id: videoId,
        title,
        thumbnail_url: thumbnailUrl,
        views: parseCount(textFromNode(renderer.viewCountText)),
        likes: 0,
        comments: 0,
        published_at: parseRelativeTimeToIso(textFromNode(renderer.publishedTimeText))
      };
    }).filter((v: any) => v.video_id && v.title);

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
      String(videos.length)
    );

    return {
      channel_id: channelId,
      channel_name: channelName || 'Unknown Channel',
      thumbnail_url: thumbnailUrl,
      subscribers,
      total_views: 0,
      video_count: videoCount || videos.length,
      channel_url: channelUrl,
      videos
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

async function fetchChannelPageMeta(channelUrl: string): Promise<{
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
} | null> {
  try {
    const response = await fetch(channelUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return null;
    const html = await response.text();
    const channelId =
      (html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/) || [])[1] ||
      (html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/) || [])[1] ||
      '';
    const channelName = decodeXml(((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '').trim());
    const thumbnailUrl = ((html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '').trim();
    return { channelId, channelName, thumbnailUrl };
  } catch {
    return null;
  }
}

async function buildFallbackChannelPreview(channelUrl: string) {
  const pageMeta = await fetchChannelPageMeta(channelUrl);
  const channelId = pageMeta?.channelId || await resolveChannelId(channelUrl) || '';
  if (!channelId) return null;
  const rss = await fetchRssFallback(channelId);
  if (!rss) return null;

  return {
    channel_id: channelId,
    channel_name: pageMeta?.channelName || rss.channelName || 'Unknown Channel',
    thumbnail_url: pageMeta?.thumbnailUrl || (rss.videos[0]?.thumbnail_url || ''),
    subscribers: 0,
    total_views: 0,
    video_count: rss.videos.length,
    channel_url: channelUrl,
    videos: rss.videos
  };
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

    const channelUrl = getChannelUrl(query);
    const searchQuery = query.replace(/^@/, '');

    const runResponse = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getRunInput(searchQuery || channelUrl, channelUrl.startsWith('http') ? channelUrl : undefined))
    });

    if (!runResponse.ok) {
      const fallback = await buildFallbackChannelPreview(channelUrl);
      if (fallback) {
        return new Response(
          JSON.stringify({ success: true, channel: fallback }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
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
      const statusResponse = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_API_KEY}`);
      const statusData = await statusResponse.json();

      if (statusData.data.status === 'SUCCEEDED') break;
      if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') {
        const fallback = await buildFallbackChannelPreview(channelUrl);
        if (fallback) {
          return new Response(
            JSON.stringify({ success: true, channel: fallback }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
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
      const fallback = await buildFallbackChannelPreview(channelUrl);
      if (fallback) {
        return new Response(
          JSON.stringify({ success: true, channel: fallback }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ success: true, channel: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const grouped = new Map<string, any[]>();
    for (const item of items) {
      const itemChannelId =
        safeStr(item.channelId || item.authorChannelId || item.ownerChannelId || item.channel?.id) ||
        extractChannelIdFromUrl(safeStr(item.channelUrl || item.authorUrl || item.channel?.url));
      const key = itemChannelId || safeStr(item.channelName || item.channelTitle || item.author || item.ownerText || item.channel?.name) || 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }

    const desired = normalizeText(query);
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

    let videos = best.slice(0, 20).map((video: any) => ({
      video_id: extractVideoId(video.videoId || video.id || video.url || video.videoUrl || video.webpageUrl || ''),
      title: safeStr(video.title || video.name || video.videoTitle || ''),
      thumbnail_url: video.thumbnailUrl || video.thumbnail || video.thumbnail_url || video.thumbnail?.url || '',
      views: parseCount(video.viewCount || video.views || video.view_count || 0),
      likes: parseCount(video.likeCount || video.likes || video.like_count || 0),
      comments: parseCount(video.commentCount || video.comments || video.comment_count || 0),
      published_at: video.publishedAt || video.uploadDate || video.publishedTimeText || null
    })).filter((v) => v.video_id && v.title);

    const uniqueVideos = new Map<string, any>();
    for (const video of videos) {
      if (!uniqueVideos.has(video.video_id)) uniqueVideos.set(video.video_id, video);
    }
    videos = Array.from(uniqueVideos.values()).slice(0, 5);

    const channelId =
      safeStr(first.channelId || first.authorChannelId || first.ownerChannelId || first.channel?.id) ||
      extractChannelIdFromUrl(safeStr(first.channelUrl || first.authorUrl || first.channel?.url)) ||
      await resolveChannelId(channelUrl) || '';

    if (!channelId) {
      const fallback = await buildFallbackChannelPreview(channelUrl);
      return new Response(
        JSON.stringify({ success: true, channel: fallback }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    let fallbackChannelName = '';
    if (videos.length === 0 && channelId) {
      const rss = await fetchRssFallback(channelId);
      if (rss) {
        videos = rss.videos;
        fallbackChannelName = rss.channelName;
      }
    }

    const needsEnhance = videos.length === 0 || videos.every((v) => (v.views || 0) === 0);
    if (needsEnhance) {
      const pagePreview = await fetchChannelPreviewFromPage(channelUrl);
      if (pagePreview) {
        return new Response(
          JSON.stringify({ success: true, channel: pagePreview }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        channel: {
          channel_id: channelId,
          channel_name: first.channelName || first.channelTitle || first.author || first.ownerText || first.channel?.name || fallbackChannelName || 'Unknown Channel',
          thumbnail_url: first.channelAvatarUrl || first.avatarUrl || first.channelThumbnailUrl || first.thumbnailUrl || first.channel?.avatarUrl || '',
          subscribers: parseCount(first.subscriberCount || first.subscribers || first.channelSubscriberCount || first.channel?.subscriberCount || 0),
          total_views: parseCount(first.totalViews || first.channelViews || first.channel?.totalViews || 0),
          video_count: parseCount(first.videoCount || first.channelVideoCount || first.channel?.videoCount || 0) || videos.length,
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
