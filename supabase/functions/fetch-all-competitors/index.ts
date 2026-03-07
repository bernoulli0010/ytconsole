import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const YOUTUBE_API_KEY = Deno.env.get('YOUTUBE_API_KEY')!
const DEFAULT_REFRESH_WINDOW_HOURS = 12

function toInt(v: unknown): number {
  const n = Number.parseInt(String(v ?? '0').replace(/[^0-9-]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

function safeDate(v: unknown): string | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function roundMetric(v: number): number {
  return Number(v.toFixed(4))
}

function isStale(lastFetched: string | null, refreshWindowHours: number): boolean {
  if (!lastFetched) return true
  const last = new Date(lastFetched)
  if (Number.isNaN(last.getTime())) return true
  const diffHours = (Date.now() - last.getTime()) / 3600000
  return diffHours >= refreshWindowHours
}

async function getChannelInfo(channelId: string) {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${YOUTUBE_API_KEY}`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = await res.json()
  const item = json?.items?.[0]
  if (!item) return null
  return {
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
    videoId: item?.id?.videoId || '',
    title: item?.snippet?.title || '',
    thumbnailUrl: item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.medium?.url || item?.snippet?.thumbnails?.default?.url || '',
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

    let body: any = {}
    if (req.method === 'POST') {
      try { body = await req.json() } catch { body = {} }
    }

    const refreshRequested = body?.refresh === true
    const refreshWindowHours = Number.isFinite(Number(body?.refresh_window_hours)) ? Math.max(1, Number(body.refresh_window_hours)) : DEFAULT_REFRESH_WINDOW_HOURS
    const forceRefresh = body?.force === true

    const { data: channels, error: fetchError } = await supabase
      .from('competitor_channels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (fetchError) {
      return new Response(JSON.stringify({ error: 'Kanallar alınırken hata oluştu' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!channels || channels.length === 0) {
      return new Response(JSON.stringify({ success: true, competitors: [], message: 'Takip edilen rakip bulunmuyor' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    let refreshedCount = 0
    if (refreshRequested) {
      for (const channel of channels) {
        if (!forceRefresh && !isStale(channel.last_fetched, refreshWindowHours)) continue
        if (!channel.channel_id) continue

        const info = await getChannelInfo(channel.channel_id)
        const latest = await getLatestVideos(channel.channel_id)
        const statsMap = await getVideoStats(latest.map(v => v.videoId))
        const videos = enrichVideoMetrics(latest.map(v => ({
          ...v,
          views: statsMap.get(v.videoId)?.views || 0,
          likes: statsMap.get(v.videoId)?.likes || 0,
          comments: statsMap.get(v.videoId)?.comments || 0,
        })))

        await supabase
          .from('competitor_channels')
          .update({
            channel_name: info?.channelName || channel.channel_name,
            thumbnail_url: info?.thumbnailUrl || channel.thumbnail_url,
            subscribers: info?.subscribers ?? channel.subscribers,
            total_views: info?.totalViews ?? channel.total_views,
            video_count: info?.videoCount ?? latest.length,
            description: info?.description ?? channel.description,
            last_fetched: new Date().toISOString(),
          })
          .eq('id', channel.id)

        if (videos.length > 0) {
          const videoRecords = videos.map(v => ({
            channel_id: channel.id,
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
            last_fetched: new Date().toISOString(),
          }))
          await supabase.from('competitor_videos').upsert(videoRecords, { onConflict: 'channel_id,video_id' })
        }

        refreshedCount++
      }
    }

    const { data: finalChannels } = await supabase
      .from('competitor_channels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    const channelIds = (finalChannels || []).map(c => c.id)
    const { data: videos } = await supabase
      .from('competitor_videos')
      .select('*')
      .in('channel_id', channelIds)
      .order('published_at', { ascending: false })

    const videosByChannel = new Map<string, any[]>()
    for (const v of (videos || [])) {
      if (!videosByChannel.has(v.channel_id)) videosByChannel.set(v.channel_id, [])
      const list = videosByChannel.get(v.channel_id)!
      if (list.length < 10) list.push(v)
    }

    const competitors = (finalChannels || []).map(ch => ({ ...ch, videos: videosByChannel.get(ch.id) || [] }))

    return new Response(JSON.stringify({ success: true, competitors, refreshed_count: refreshedCount, refresh_requested: refreshRequested }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('fetch-all-competitors error:', error)
    return new Response(JSON.stringify({ error: (error as Error).message || 'Sunucu hatası' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
