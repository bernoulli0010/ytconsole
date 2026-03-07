import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const YOUTUBE_API_KEY = Deno.env.get('YOUTUBE_API_KEY')!

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function toInt(v: unknown): number {
  const n = Number.parseInt(String(v ?? '0').replace(/[^0-9-]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

function getChannelUrl(input: string): string {
  const t = input.trim()
  if (t.startsWith('http')) return t
  if (t.startsWith('@')) return `https://www.youtube.com/${t}`
  if (t.startsWith('UC') && t.length > 20) return `https://www.youtube.com/channel/${t}`
  return `https://www.youtube.com/@${t}`
}

async function resolveChannelId(channelUrl: string): Promise<string | null> {
  if (channelUrl.includes('/channel/')) {
    const m = channelUrl.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/)
    if (m) return m[1]
  }
  try {
    const res = await fetch(channelUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' })
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/)
    if (m) return m[1]
    const m2 = html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/)
    return m2 ? m2[1] : null
  } catch {
    return null
  }
}

async function getChannelInfo(channelId: string) {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${YOUTUBE_API_KEY}`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = await res.json()
  const item = json?.items?.[0]
  if (!item) return null
  return {
    channelId: item.id,
    channelName: item.snippet?.title || 'Unknown Channel',
    thumbnailUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
    subscribers: toInt(item.statistics?.subscriberCount),
    totalViews: toInt(item.statistics?.viewCount),
    videoCount: toInt(item.statistics?.videoCount),
  }
}

async function getLatestVideos(channelId: string) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=5&order=date&type=video&key=${YOUTUBE_API_KEY}`
  const res = await fetch(url)
  if (!res.ok) return []
  const json = await res.json()
  return (json?.items || []).map((item: any) => ({
    video_id: item?.id?.videoId || '',
    title: item?.snippet?.title || '',
    thumbnail_url: item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.medium?.url || item?.snippet?.thumbnails?.default?.url || '',
    views: 0,
    likes: 0,
    comments: 0,
    published_at: item?.snippet?.publishedAt || null,
  })).filter((v: any) => v.video_id && v.title)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Yetkilendirme gerekli' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!YOUTUBE_API_KEY) {
      return new Response(JSON.stringify({ error: 'YOUTUBE_API_KEY tanımlı değil' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const accessToken = authHeader.replace('Bearer ', '').trim()
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken)
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Geçersiz yetkilendirme' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const body = await req.json().catch(() => ({}))
    const query = safeStr(body.query)
    if (!query) {
      return new Response(JSON.stringify({ error: 'Kanal arama sorgusu gerekli' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const channelUrl = getChannelUrl(query)
    const channelId = await resolveChannelId(channelUrl)
    if (!channelId) {
      return new Response(JSON.stringify({ success: true, channel: null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const channelInfo = await getChannelInfo(channelId)
    if (!channelInfo) {
      return new Response(JSON.stringify({ success: true, channel: null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const videos = await getLatestVideos(channelId)

    return new Response(JSON.stringify({
      success: true,
      channel: {
        channel_id: channelInfo.channelId,
        channel_name: channelInfo.channelName,
        thumbnail_url: channelInfo.thumbnailUrl,
        subscribers: channelInfo.subscribers,
        total_views: channelInfo.totalViews,
        video_count: channelInfo.videoCount,
        channel_url: channelUrl,
        videos,
      }
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('search-channel error:', error)
    return new Response(JSON.stringify({ error: (error as Error).message || 'Sunucu hatası' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
