import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCount(countStr: string): number {
  if (!countStr) return 0;
  
  const clean = countStr.replace(/[^0-9.,KMB]/g, '').trim();
  
  if (clean.includes('M') || clean.includes('m')) {
    const num = parseFloat(clean.replace(/[Mm]/g, ''));
    return Math.round(num * 1000000);
  }
  
  if (clean.includes('K') || clean.includes('k')) {
    const num = parseFloat(clean.replace(/[Kk]/g, ''));
    return Math.round(num * 1000);
  }
  
  if (clean.includes('B') || clean.includes('b')) {
    const num = parseFloat(clean.replace(/[Bb]/g, ''));
    return Math.round(num * 1000000000);
  }
  
  return parseInt(clean.replace(/,/g, ''), 10) || 0;
}

// Fetch channel statistics from YouTube channel page
async function fetchChannelStats(channelId: string): Promise<{
  channelName: string;
  thumbnailUrl: string;
  subscribers: number;
  totalViews: number;
  videoCount: number;
  country: string;
  description: string;
} | null> {
  const channelUrl = `https://www.youtube.com/channel/${channelId}`;
  
  const response = await fetch(channelUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  
  if (!response.ok) {
    console.error(`Channel fetch failed: ${response.status}`);
    return null;
  }
  
  const html = await response.text();
  
  // Extract channel name
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  let channelName = titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : 'Unknown Channel';
  
  // Extract subscriber count
  let subscribers = 0;
  const subMatch = html.match(/"subscriberCountText":\s*"([^"]+)"/) || 
                   html.match(/subscribers[^<]*<span[^>]*>([^<]+)<\/span>/i);
  if (subMatch) {
    subscribers = parseCount(subMatch[1]);
  }
  
  // Extract total views
  let totalViews = 0;
  const viewsMatch = html.match(/"viewCountText":\s*\{[^}]*"simpleText":"([^"]+)"/) ||
                     html.match(/view[s]?[^<]*<span[^>]*>([^<]+)<\/span>/i);
  if (viewsMatch) {
    totalViews = parseCount(viewsMatch[1]);
  }
  
  // Extract video count
  let videoCount = 0;
  const videoMatch = html.match(/"videoCountText":\s*\{[^}]*"simpleText":"([^"]+)"/) ||
                     html.match(/video[s]?[^<]*<span[^>]*>([^<]+)<\/span>/i);
  if (videoMatch) {
    videoCount = parseCount(videoMatch[1]);
  }
  
  // Extract thumbnail
  let thumbnailUrl = '';
  const thumbMatch = html.match(/"avatar":\s*\{[^}]*"thumbnails":\s*\[\{"url":"([^"]+)"/);
  if (thumbMatch) {
    thumbnailUrl = thumbMatch[1].replace(/\\u0026/g, '&');
  } else {
    thumbnailUrl = `https://yt3.ggpht.com/ytc/${channelId}`;
  }
  
  // Extract description
  let description = '';
  const descMatch = html.match(/"description":{"simpleText":"([^"]+)"/);
  if (descMatch) {
    description = descMatch[1].replace(/\\n/g, '\n').replace(/\\u0026/g, '&');
  }
  
  // Extract country
  let country = '';
  const countryMatch = html.match(/"country":"([^"]+)"/);
  if (countryMatch) {
    country = countryMatch[1];
  }
  
  return {
    channelName,
    thumbnailUrl,
    subscribers,
    totalViews,
    videoCount,
    country,
    description
  };
}

// Fetch recent videos from RSS feed
async function fetchChannelVideos(channelId: string): Promise<{
  videos: {
    videoId: string;
    title: string;
    thumbnailUrl: string;
    views: number;
    likes: number;
    comments: number;
    publishedAt: string;
    duration: string;
  }[]
}> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  
  const response = await fetch(rssUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  });
  
  if (!response.ok) {
    return { videos: [] };
  }
  
  const xml = await response.text();
  
  const videos: {
    videoId: string;
    title: string;
    thumbnailUrl: string;
    views: number;
    likes: number;
    comments: number;
    publishedAt: string;
    duration: string;
  }[] = [];
  
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let match;
  
  while ((match = entryRegex.exec(xml)) !== null && videos.length < 15) {
    const entry = match[1];
    
    const videoTitleMatch = entry.match(/<title>([^<]*)<\/title>/);
    const videoIdMatch = entry.match(/<yt:videoId>([^<]*)<\/yt:videoId>/);
    const publishedMatch = entry.match(/<published>([^<]*)<\/published>/);
    const mediaMatch = entry.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    
    if (videoTitleMatch && videoIdMatch) {
      const videoId = videoIdMatch[1];
      videos.push({
        videoId,
        title: videoTitleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        thumbnailUrl: mediaMatch ? mediaMatch[1] : `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        views: 0,
        likes: 0,
        comments: 0,
        publishedAt: publishedMatch ? publishedMatch[1] : '',
        duration: ''
      });
    }
  }
  
  return { videos };
}

// Fetch individual video stats
async function fetchVideoStats(videoId: string): Promise<{ views: number; likes: number; comments: number }> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    });
    
    if (!response.ok) {
      return { views: 0, likes: 0, comments: 0 };
    }
    
    const html = await response.text();
    
    let views = 0;
    const viewMatch = html.match(/"viewCount":\s*\{[^}]*"simpleText":"([^"]+)"/) ||
                      html.match(/view[s]?[^<]*<span[^>]*>([^<]+)<\/span>/i);
    if (viewMatch) {
      views = parseCount(viewMatch[1]);
    }
    
    let likes = 0;
    const likeMatch = html.match(/"likeButton":\s*\{[^}]*"simpleText":"([^"]+)"/);
    if (likeMatch) {
      likes = parseCount(likeMatch[1]);
    }
    
    return { views, likes, comments: 0 };
  } catch (e) {
    return { views: 0, likes: 0, comments: 0 };
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Yetkilendirme gerekli' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Geçersiz yetkilendirme' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get all competitor channels for user
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
        JSON.stringify({
          success: true,
          competitors: [],
          message: 'Takip edilen rakip bulunmuyor'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Refresh each channel's data
    const updatedCompetitors = [];
    
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      
      // Update channel stats
      const channelStats = await fetchChannelStats(channel.channel_id);
      
      if (channelStats) {
        await supabase
          .from('competitor_channels')
          .update({
            channel_name: channelStats.channelName,
            thumbnail_url: channelStats.thumbnailUrl,
            subscribers: channelStats.subscribers,
            total_views: channelStats.totalViews,
            video_count: channelStats.videoCount,
            country: channelStats.country,
            description: channelStats.description,
            last_fetched: new Date().toISOString()
          })
          .eq('id', channel.id);
      }
      
      // Update videos
      const { videos } = await fetchChannelVideos(channel.channel_id);
      
      // Fetch stats for first 3 videos only to save time
      const videosWithStats = [];
      for (let j = 0; j < Math.min(videos.length, 3); j++) {
        await delay(300);
        const stats = await fetchVideoStats(videos[j].videoId);
        videosWithStats.push({
          ...videos[j],
          views: stats.views,
          likes: stats.likes,
          comments: stats.comments
        });
      }
      
      // For remaining videos, use the ones from RSS without detailed stats
      for (let j = 3; j < videos.length; j++) {
        videosWithStats.push(videos[j]);
      }
      
      // Save videos to database
      if (videosWithStats.length > 0) {
        const videoRecords = videosWithStats.map(v => ({
          channel_id: channel.id,
          video_id: v.videoId,
          title: v.title,
          thumbnail_url: v.thumbnailUrl,
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          duration: v.duration,
          published_at: v.publishedAt || null
        }));

        await supabase
          .from('competitor_videos')
          .upsert(videoRecords, { onConflict: 'channel_id,video_id' });
      }
      
      // Get updated channel with videos
      const { data: updatedChannel } = await supabase
        .from('competitor_channels')
        .select('*')
        .eq('id', channel.id)
        .single();
      
      const { data: updatedVideos } = await supabase
        .from('competitor_videos')
        .select('*')
        .eq('channel_id', channel.id)
        .order('published_at', { ascending: false })
        .limit(10);
      
      updatedCompetitors.push({
        ...updatedChannel,
        videos: updatedVideos || []
      });
      
      // Delay between channels to avoid rate limiting
      if (i < channels.length - 1) {
        await delay(1000);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        competitors: updatedCompetitors,
        updated_count: updatedCompetitors.length
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
