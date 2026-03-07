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

function safeDate(v: unknown): string | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function roundMetric(v: number): number {
  return Number(v.toFixed(4))
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
    description: item.snippet?.description || ''
  }
}

async function getLatestVideos(channelId: string) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=10&order=date&type=video&key=${YOUTUBE_API_KEY}`
  const res = await fetch(url)
  if (!res.ok) return []
  const json = await res.json()
  return (json?.items || []).map((item: any) => ({
    videoId: safeStr(item?.id?.videoId),
    title: safeStr(item?.snippet?.title),
    thumbnailUrl: safeStr(item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.medium?.url || item?.snippet?.thumbnails?.default?.url),
    publishedAt: safeDate(item?.snippet?.publishedAt)
  })).filter((v: any) => v.videoId && v.title)
}

async function getVideoStats(videoIds: string[]) {
  if (videoIds.length === 0) return new Map<string, { views: number; likes: number; comments: number }>()
  const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`
  const res = await fetch(url)
  const map = new Map<string, { views: number; likes: number; comments: number }>()
  if (!res.ok) return map
  const json = await res.json()
  for (const item of (json?.items || [])) {
    map.set(item.id, {
      views: toInt(item?.statistics?.viewCount),
      likes: toInt(item?.statistics?.likeCount),
      comments: toInt(item?.statistics?.commentCount),
    })
  }
  return map
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
  if (videos.length === 0) return []
  const avgViews = Math.max(videos.reduce((s, v) => s + (v.views || 0), 0) / videos.length, 1)
  return videos.map((video) => {
    const publishedAtIso = safeDate(video.publishedAt)
    let publishedHoursAgo: number | null = null
    if (publishedAtIso) {
      const hours = (Date.now() - new Date(publishedAtIso).getTime()) / 3600000
      if (Number.isFinite(hours) && hours > 0) publishedHoursAgo = roundMetric(Math.max(hours, 1))
    }
    const vph = publishedHoursAgo ? roundMetric(video.views / publishedHoursAgo) : 0
    const engagementRate = video.views > 0 ? roundMetric(((video.likes + video.comments) / video.views) * 100) : 0
    const outlierScore = roundMetric((video.views / avgViews) * 100)
    return { ...video, publishedAt: publishedAtIso, publishedHoursAgo, vph, engagementRate, outlierScore }
  })
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

    const { query } = await req.json()
    const channelQuery = safeStr(query)
    if (!channelQuery) {
      return new Response(JSON.stringify({ error: 'Kanal URL veya kullanıcı adı gerekli' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: profile } = await supabase.from('profiles').select('token_balance').eq('id', user.id).single()
    if (!profile) {
      return new Response(JSON.stringify({ error: 'Profil bulunamadı' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (profile.token_balance < 2) {
      return new Response(JSON.stringify({ error: 'Yetersiz token. Rakip eklemek için en az 2 token gerekli.', code: 'INSUFFICIENT_TOKENS' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { count } = await supabase.from('competitor_channels').select('*', { count: 'exact', head: true }).eq('user_id', user.id)
    if (count !== null && count >= 10) {
      return new Response(JSON.stringify({ error: 'Maksimum rakip sayısına ulaştınız (10).', code: 'LIMIT_REACHED' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const channelUrl = getChannelUrl(channelQuery)
    const channelId = await resolveChannelId(channelUrl)
    if (!channelId) {
      return new Response(JSON.stringify({ error: 'Kanal ID çözümlenemedi' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const channelInfo = await getChannelInfo(channelId)
    if (!channelInfo) {
      return new Response(JSON.stringify({ error: 'Kanal bilgisi alınamadı' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: existingChannel } = await supabase
      .from('competitor_channels')
      .select('id, channel_name')
      .eq('user_id', user.id)
      .eq('channel_id', channelInfo.channelId)
      .single()

    if (existingChannel) {
      return new Response(JSON.stringify({ error: `Bu kanal zaten takip ediliyor: ${existingChannel.channel_name}`, code: 'ALREADY_EXISTS' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const latest = await getLatestVideos(channelInfo.channelId)
    const statsMap = await getVideoStats(latest.map(v => v.videoId))
    const merged = latest.map(v => ({
      ...v,
      views: statsMap.get(v.videoId)?.views || 0,
      likes: statsMap.get(v.videoId)?.likes || 0,
      comments: statsMap.get(v.videoId)?.comments || 0,
    }))
    const videos = enrichVideoMetrics(merged)

    const { data: newChannel, error: insertChannelError } = await supabase
      .from('competitor_channels')
      .insert({
        user_id: user.id,
        channel_id: channelInfo.channelId,
        channel_name: channelInfo.channelName,
        channel_url: channelUrl,
        thumbnail_url: channelInfo.thumbnailUrl,
        subscribers: channelInfo.subscribers,
        total_views: channelInfo.totalViews,
        video_count: channelInfo.videoCount,
        description: channelInfo.description,
        last_fetched: new Date().toISOString(),
      })
      .select()
      .single()

    if (insertChannelError || !newChannel) {
      return new Response(JSON.stringify({ error: 'Kanal kaydedilirken hata oluştu' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (videos.length > 0) {
      const videoRecords = videos.map(v => ({
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
        engagement_rate: v.engagementRate,
      }))
      await supabase.from('competitor_videos').upsert(videoRecords, { onConflict: 'channel_id,video_id' })
    }

    const newTokenBalance = profile.token_balance - 2
    await supabase.from('profiles').update({ token_balance: newTokenBalance }).eq('id', user.id)

    return new Response(JSON.stringify({
      success: true,
      channel: { ...newChannel, videos },
      tokens_deducted: 2,
      new_token_balance: newTokenBalance,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('add-competitor error:', error)
    return new Response(JSON.stringify({ error: (error as Error).message || 'Sunucu hatası' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
