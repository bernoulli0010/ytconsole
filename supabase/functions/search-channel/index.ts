import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function safeStr(val: unknown): string { return typeof val === 'string' ? val.trim() : ''; }

function decodeXml(t: string): string {
  return t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
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

function getChannelUrl(input: string): string {
  const t = input.trim();
  if (t.startsWith('http')) return t;
  if (t.startsWith('@')) return `https://www.youtube.com/${t}`;
  if (t.startsWith('UC') && t.length > 20) return `https://www.youtube.com/channel/${t}`;
  return `https://www.youtube.com/@${t}`;
}

async function resolveChannel(channelUrl: string) {
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

    let subscribers = 0;
    const subMatch = html.match(/"subscriberCountText":\s*\{[^}]*?"simpleText"\s*:\s*"([^"]+)"/);
    if (subMatch) subscribers = parseSubscribers(subMatch[1]);
    else {
      const subLabel = html.match(/"subscriberCountText"[\s\S]*?"label"\s*:\s*"([^"]+)"/);
      if (subLabel) subscribers = parseSubscribers(subLabel[1]);
    }

    return { channelId, channelName, thumbnailUrl, subscribers };
  } catch { return null; }
}

async function fetchRssVideos(channelId: string) {
  try {
    const resp = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    const xml = await resp.text();
    const titleMatch = xml.match(/<title>([^<]*)<\/title>/);
    const channelName = titleMatch ? decodeXml(titleMatch[1].replace(' - YouTube', '')) : 'Unknown Channel';
    const videos: { video_id: string; title: string; thumbnail_url: string; published_at: string | null }[] = [];
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(xml)) !== null && videos.length < 5) {
      const entry = match[1];
      const videoId = (entry.match(/<yt:videoId>([^<]*)<\/yt:videoId>/) || [])[1] || '';
      const title = decodeXml(((entry.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim());
      const publishedAt = ((entry.match(/<published>([^<]*)<\/published>/) || [])[1] || '').trim() || null;
      const thumb = ((entry.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || '').trim();
      if (!videoId || !title) continue;
      videos.push({ video_id: videoId, title, thumbnail_url: thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, published_at: publishedAt });
    }
    return { channelName, videos };
  } catch { return null; }
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

    const body = await req.json().catch(() => ({}));
    const query = safeStr(body.query);
    if (!query) return new Response(JSON.stringify({ error: 'Kanal arama sorgusu gerekli' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const channelUrl = getChannelUrl(query);
    const channelMeta = await resolveChannel(channelUrl);
    if (!channelMeta) {
      return new Response(JSON.stringify({ success: true, channel: null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const rss = await fetchRssVideos(channelMeta.channelId);
    const videos = rss?.videos || [];

    return new Response(JSON.stringify({
      success: true,
      channel: {
        channel_id: channelMeta.channelId,
        channel_name: channelMeta.channelName || rss?.channelName || 'Unknown Channel',
        thumbnail_url: channelMeta.thumbnailUrl,
        subscribers: channelMeta.subscribers,
        total_views: 0,
        video_count: videos.length,
        channel_url: channelUrl,
        videos
      }
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('search-channel error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Sunucu hatası' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
