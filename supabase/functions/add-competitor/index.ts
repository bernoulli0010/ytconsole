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
  if (typeof val === "string") return val.trim();
  return "";
}

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
    const videos = renderers.slice(0, 10).map((renderer: any) => {
      const videoId = String(renderer.videoId || '').trim();
      const title = textFromNode(renderer.title);
      const thumbnails = renderer.thumbnail?.thumbnails || [];
      const thumbnailUrl = thumbnails.length > 0 ? (thumbnails[thumbnails.length - 1].url || '') : '';
      const views = extractViewCountFromRenderer(renderer);
      const publishedAt = parseRelativeTimeToIso(textFromNode(renderer.publishedTimeText));
      return {
        videoId,
        title,
        thumbnailUrl,
        views,
        likes: 0,
        comments: 0,
        publishedAt
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
      String(videos.length)
    );

    return {
      channelId,
      channelName,
      thumbnailUrl,
      subscribers,
      videoCount,
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

  let target = trimmed;
  if (!target.startsWith('http')) {
    if (target.startsWith('@')) target = `https://www.youtube.com/${target}`;
    else target = `https://www.youtube.com/@${target}`;
  }

  try {
    const response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
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

async function fetchChannelPageMeta(channelUrl: string): Promise<{
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  description: string;
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
    const description = decodeXml(((html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1] || '').trim());
    return { channelId, channelName, thumbnailUrl, description };
  } catch {
    return null;
  }
}

async function buildFallbackChannelData(channelUrl: string) {
  const pageMeta = await fetchChannelPageMeta(channelUrl);
  const channelId = pageMeta?.channelId || await resolveChannelId(channelUrl) || '';
  if (!channelId) return null;

  const rss = await fetchRssFallback(channelId);
  if (!rss) return null;

  const thumbnailUrl = pageMeta?.thumbnailUrl || (rss.videos[0]?.thumbnailUrl || '');
  const channelName = pageMeta?.channelName || rss.channelName || 'Unknown Channel';

  return {
    channelId,
    channelName,
    thumbnailUrl,
    subscribers: 0,
    totalViews: 0,
    videoCount: rss.videos.length,
    description: pageMeta?.description || '',
    videos: rss.videos
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

// Get channel URL in correct format for Apify
function getChannelUrl(input: string): string {
  const trimmed = input.trim();
  
  if (trimmed.startsWith('http')) {
    return trimmed;
  }
  
  if (trimmed.startsWith('@')) {
    return `https://www.youtube.com/${trimmed}`;
  }
  
  if (trimmed.startsWith('UC') && trimmed.length > 20) {
    return `https://www.youtube.com/channel/${trimmed}`;
  }
  
  return `https://www.youtube.com/@${trimmed}`;
}

// Fetch channel data using Apify actor h7sDV53CddomktSi5
async function fetchChannelWithApify(channelUrl: string): Promise<{
  channelId: string;
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
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(getRunInput(query || channelUrl, channelUrl.startsWith('http') ? channelUrl : undefined))
  });

  if (!runResponse.ok) {
    console.error('Apify run error:', await runResponse.text());
    return buildFallbackChannelData(channelUrl);
  }

  const runData = await runResponse.json();
  const runId = runData.data.id;
  
  // Wait for completion (max 60 seconds)
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(r => setTimeout(r, 2000));
    
    const statusResponse = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_API_KEY}`);
    const statusData = await statusResponse.json();
    
    if (statusData.data.status === 'SUCCEEDED') {
      break;
    } else if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') {
      console.error('Apify run failed:', statusData.data.status);
      return buildFallbackChannelData(channelUrl);
    }
    
    attempts++;
  }

  // Get dataset items
  const datasetId = runData.data.defaultDatasetId;
  const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`);
  
  if (!itemsResponse.ok) {
    console.error('Apify dataset error:', await itemsResponse.text());
    return buildFallbackChannelData(channelUrl);
  }

  const items = await itemsResponse.json();
  
  if (!items || items.length === 0) {
    return buildFallbackChannelData(channelUrl);
  }

  const channel = items[0];
  const grouped = new Map<string, any[]>();
  for (const item of items) {
    const itemChannelId =
      safeStr(item.channelId) ||
      safeStr(item.authorChannelId) ||
      safeStr(item.ownerChannelId) ||
      safeStr(item.channel?.id) ||
      extractChannelIdFromUrl(safeStr(item.channelUrl || item.authorUrl || item.channel?.url));
    const key = itemChannelId || safeStr(item.channelName || item.channelTitle || item.author || item.ownerText || item.channel?.name) || 'unknown';
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
  const first = best[0] || channel;

  const rawVideos = best.map((v: any) => ({
    videoId: extractVideoId(v.videoId || v.id || v.url || v.videoUrl || v.webpageUrl || ''),
    title: safeStr(v.title || v.name || v.videoTitle || ''),
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

  const channelId =
    safeStr(first.channelId) ||
    safeStr(first.authorChannelId) ||
    safeStr(first.ownerChannelId) ||
    safeStr(first.channel?.id) ||
    extractChannelIdFromUrl(safeStr(first.channelUrl || first.authorUrl || first.channel?.url)) ||
    await resolveChannelId(channelUrl) ||
    '';

  if (!channelId) {
    return buildFallbackChannelData(channelUrl);
  }

  let videos = enrichVideoMetrics(Array.from(uniqueByVideo.values()).slice(0, 10));
  let fallbackChannelName = '';

  if (videos.length === 0 && channelId) {
    const rss = await fetchRssFallback(channelId);
    if (rss) {
      videos = rss.videos;
      fallbackChannelName = rss.channelName;
    }
  }

  const subscribers = parseCount(first.subscriberCount || first.subscribers || first.channelSubscriberCount || first.channel?.subscriberCount || '0');
  const totalViews = parseCount(first.totalViews || first.channelViews || first.channel?.totalViews || '0');
  const videoCount = parseCount(first.videoCount || first.channelVideoCount || first.channel?.videoCount || '0');

  const needsChannelEnhance = subscribers === 0 || videos.length === 0 || videos.every((v) => (v.views || 0) === 0);
  if (needsChannelEnhance) {
    const pageData = await fetchChannelVideosFromPage(channelUrl);
    if (pageData) {
      if (!channelId && pageData.channelId) {
        return {
          channelId: pageData.channelId,
          channelName: pageData.channelName || first.channelName || first.channelTitle || fallbackChannelName || 'Unknown Channel',
          thumbnailUrl: pageData.thumbnailUrl || first.channelAvatarUrl || first.avatarUrl || '',
          subscribers: pageData.subscribers || subscribers,
          totalViews,
          videoCount: pageData.videoCount || videoCount || pageData.videos.length,
          description: first.channelDescription || first.description || '',
          videos: enrichVideoMetrics(pageData.videos)
        };
      }

      if (pageData.videos.length > 0) {
        videos = enrichVideoMetrics(pageData.videos);
      }

      return {
        channelId,
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
    channelId,
    channelName: first.channelName || first.channelTitle || first.author || first.ownerText || first.channel?.name || fallbackChannelName || 'Unknown Channel',
    thumbnailUrl: first.channelAvatarUrl || first.avatarUrl || first.channelThumbnailUrl || first.thumbnailUrl || first.channel?.avatarUrl || '',
    subscribers,
    totalViews,
    videoCount: videoCount || videos.length,
    description: first.channelDescription || first.description || '',
    videos
  };
}

serve(async (req) => {
  // CORS preflight
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

    const { query } = await req.json();
    const channelQuery = safeStr(query);

    if (!channelQuery) {
      return new Response(
        JSON.stringify({ error: 'Kanal URL veya kullanıcı adı gerekli' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check user's token balance
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('token_balance')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return new Response(
        JSON.stringify({ error: 'Profil bulunamadı' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (profile.token_balance < 2) {
      return new Response(
        JSON.stringify({ error: 'Yetersiz token. Rakip eklemek için en az 2 token gerekli.', code: 'INSUFFICIENT_TOKENS' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check competitor limit
    const { count } = await supabase
      .from('competitor_channels')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    if (count !== null && count >= 10) {
      return new Response(
        JSON.stringify({ error: 'Maksimum rakip sayısına ulaştınız (10).', code: 'LIMIT_REACHED' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get channel URL
    const channelUrl = getChannelUrl(channelQuery);

    // Fetch channel data using Apify
    const channelData = await fetchChannelWithApify(channelUrl);
    
    if (!channelData) {
      return new Response(
        JSON.stringify({ error: 'Kanal bulunamadı veya veri alınamadı. Geçerli bir YouTube kanal URL\'si girin.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if channel already exists for this user
    const { data: existingChannel } = await supabase
      .from('competitor_channels')
      .select('id, channel_name')
      .eq('user_id', user.id)
      .eq('channel_id', channelData.channelId)
      .single();

    if (existingChannel) {
      return new Response(
        JSON.stringify({ error: `Bu kanal zaten takip ediliyor: ${existingChannel.channel_name}`, code: 'ALREADY_EXISTS' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Save channel to database
    const { data: newChannel, error: insertChannelError } = await supabase
      .from('competitor_channels')
      .insert({
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
      })
      .select()
      .single();

    if (insertChannelError) {
      console.error('Insert channel error:', insertChannelError);
      return new Response(
        JSON.stringify({ error: 'Kanal kaydedilirken hata oluştu' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Save videos to database
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

      await supabase
        .from('competitor_videos')
        .upsert(videoRecords, { onConflict: 'channel_id,video_id' });
    }

    // Deduct tokens
    const tokensDeducted = 2;
    const newTokenBalance = profile.token_balance - 2;
    await supabase
      .from('profiles')
      .update({ token_balance: newTokenBalance })
      .eq('id', user.id);

    return new Response(
      JSON.stringify({
        success: true,
        channel: {
          ...newChannel,
          videos: channelData.videos
        },
        tokens_deducted: tokensDeducted,
        new_token_balance: newTokenBalance
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error("add-competitor error:", error);
    return new Response(
      JSON.stringify({ error: error.message || 'Sunucu hatası' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
