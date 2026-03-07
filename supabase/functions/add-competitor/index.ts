import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!

function safeStr(val: unknown): string {
  if (typeof val === "string") return val.trim();
  return "";
}

function toInt(val: unknown): number {
  const cleaned = String(val ?? "0").replace(/[^0-9-]/g, "");
  const parsed = Number.parseInt(cleaned || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
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

// Fetch channel data using Apify
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
  const actorId = "streamers~youtube-channel-scraper";
  
  const runResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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
  
  // Wait for completion (max 60 seconds)
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(r => setTimeout(r, 2000));
    
    const statusResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/${runId}?token=${APIFY_API_KEY}`);
    const statusData = await statusResponse.json();
    
    if (statusData.data.status === 'SUCCEEDED') {
      break;
    } else if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') {
      console.error('Apify run failed:', statusData.data.status);
      return null;
    }
    
    attempts++;
  }

  // Get dataset items
  const datasetId = runData.data.defaultDatasetId;
  const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`);
  
  if (!itemsResponse.ok) {
    console.error('Apify dataset error:', await itemsResponse.text());
    return null;
  }

  const items = await itemsResponse.json();
  
  if (!items || items.length === 0) {
    return null;
  }

  const channel = items[0];
  
  const rawVideos = (channel.latestVideos || []).map((v: any) => ({
    videoId: v.id || v.videoId || '',
    title: v.title || '',
    thumbnailUrl: v.thumbnailUrl || v.thumbnail || '',
    views: toInt(v.viewCount || v.views || '0'),
    likes: toInt(v.likeCount || v.likes || '0'),
    comments: toInt(v.commentCount || v.comments || '0'),
    publishedAt: v.publishedAt || v.uploadDate || ''
  })).filter((v: { videoId: string }) => Boolean(v.videoId));

  const videos = enrichVideoMetrics(rawVideos);

  return {
    channelId: channel.channelId || channel.id || '',
    channelName: channel.title || channel.channelTitle || 'Unknown Channel',
    thumbnailUrl: channel.avatarUrl || channel.thumbnailUrl || '',
    subscribers: toInt(channel.subscriberCount || channel.subscribers || '0'),
    totalViews: toInt(channel.totalViews || channel.views || '0'),
    videoCount: toInt(channel.videoCount || channel.videos || '0'),
    description: channel.description || '',
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
