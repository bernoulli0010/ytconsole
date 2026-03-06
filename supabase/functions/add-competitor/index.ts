import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function safeStr(val: unknown): string {
  if (typeof val === "string") return val.trim();
  return "";
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse channel ID from various YouTube channel URL formats
async function extractChannelId(query: string): Promise<{ channelId: string; handle: string } | null> {
  const trimmedQuery = query.trim();
  
  // Direct channel ID
  if (trimmedQuery.startsWith('UC') && trimmedQuery.length > 20) {
    return { channelId: trimmedQuery, handle: trimmedQuery };
  }
  
  // Handle URL formats
  let url = trimmedQuery;
  if (!url.startsWith('http')) {
    if (trimmedQuery.startsWith('@')) {
      url = `https://youtube.com/${trimmedQuery}`;
    } else if (!trimmedQuery.includes('.')) {
      url = `https://youtube.com/@${trimmedQuery}`;
    } else {
      url = `https://youtube.com/${trimmedQuery}`;
    }
  }
  
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Handle /channel/UC... format
    if (pathname.includes('/channel/')) {
      const match = pathname.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
      if (match) {
        return { channelId: match[1], handle: match[1] };
      }
    }
    
    // Handle /@handle format
    if (pathname.includes('/@') || pathname.startsWith('@')) {
      const handle = pathname.replace('/@', '').replace('@', '').split('/')[0];
      const channelPageUrl = `https://www.youtube.com/@${handle}`;
      const response = await fetch(channelPageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
      });
      
      if (!response.ok) return null;
      
      const html = await response.text();
      
      // Look for channel ID in the page
      const channelIdMatch = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
      if (channelIdMatch) {
        return { channelId: channelIdMatch[1], handle: `@${handle}` };
      }
      
      // Alternative pattern
      const altMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})"/);
      if (altMatch) {
        return { channelId: altMatch[1], handle: `@${handle}` };
      }
    }
    
    // Handle /c/ or /user/ format
    if (pathname.includes('/c/') || pathname.includes('/user/')) {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
      });
      
      if (!response.ok) return null;
      
      const html = await response.text();
      const channelIdMatch = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
      if (channelIdMatch) {
        const nameMatch = pathname.match(/\/(c|user)\/([^/]+)/);
        return { channelId: channelIdMatch[1], handle: nameMatch ? nameMatch[2] : channelIdMatch[1] };
      }
    }
  } catch (e) {
    console.error("URL parse error:", e);
  }
  
  return null;
}

// Parse subscriber count from various formats (1.2M, 1,200,000, 1.2K, etc.)
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
  channelCreatedAt: string;
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
  
  // Alternative: parse from JSON embedded data
  const jsonMatch = html.match(/"channelMetadataRenderer":\s*\{([^}]+)\}/);
  if (jsonMatch && subscribers === 0) {
    const subtitleMatch = jsonMatch[0].match(/"subtitle":"([^"]+)"/);
    if (subtitleMatch) {
      const subCountMatch = subtitleMatch[1].match(/([0-9.,]+)\s*(?: subscribers| abone)/i);
      if (subCountMatch) {
        subscribers = parseCount(subCountMatch[1]);
      }
    }
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
    channelCreatedAt: '',
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
  
  // Extract video entries
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

// Fetch individual video stats (simplified - YouTube oEmbed doesn't provide stats)
async function fetchVideoStats(videoId: string): Promise<{ views: number; likes: number; comments: number }> {
  // Try to get stats from YouTube video page
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
    
    // Extract view count
    let views = 0;
    const viewMatch = html.match(/"viewCount":\s*\{[^}]*"simpleText":"([^"]+)"/) ||
                      html.match(/view[s]?[^<]*<span[^>]*>([^<]+)<\/span>/i);
    if (viewMatch) {
      views = parseCount(viewMatch[1]);
    }
    
    // Extract like count (not always available)
    let likes = 0;
    const likeMatch = html.match(/"likeButton":\s*\{[^}]*"simpleText":"([^"]+)"/);
    if (likeMatch) {
      likes = parseCount(likeMatch[1]);
    }
    
    // Comments are harder to get without API
    const comments = 0;
    
    return { views, likes, comments };
  } catch (e) {
    console.error(`Video stats fetch error for ${videoId}:`, e);
    return { views: 0, likes: 0, comments: 0 };
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Yetkilendirme gerekli' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Supabase client with user context
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } }
    });

    // Get user from token
    const { data: { user }, error: authError } = await supabase.auth.getUser();
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
    const { count, error: countError } = await supabase
      .from('competitor_channels')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    if (countError) {
      console.error('Count error:', countError);
    }

    if (count !== null && count >= 10) {
      return new Response(
        JSON.stringify({ error: 'Maksimum rakip sayısına ulaştınız (10). Yeni rakip eklemek için mevcut bir rakibi silmelisiniz.', code: 'LIMIT_REACHED' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract channel ID
    const channelInfo = await extractChannelId(channelQuery);
    if (!channelInfo) {
      return new Response(
        JSON.stringify({ error: 'Kanal bulunamadı. Geçerli bir YouTube kanal URL\'si veya kullanıcı adı girin.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if channel already exists for this user
    const { data: existingChannel } = await supabase
      .from('competitor_channels')
      .select('id, channel_name')
      .eq('user_id', user.id)
      .eq('channel_id', channelInfo.channelId)
      .single();

    if (existingChannel) {
      return new Response(
        JSON.stringify({ error: `Bu kanal zaten takip ediliyor: ${existingChannel.channel_name}`, code: 'ALREADY_EXISTS' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch channel statistics
    const channelStats = await fetchChannelStats(channelInfo.channelId);
    if (!channelStats) {
      return new Response(
        JSON.stringify({ error: 'Kanal istatistikleri alınamadı. YouTube erişiminde sorun olabilir.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch recent videos
    const { videos } = await fetchChannelVideos(channelInfo.channelId);
    
    // Fetch video stats with delay to avoid rate limiting
    const videosWithStats = [];
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      // Only fetch stats for first 5 videos to avoid long delays
      if (i < 5) {
        await delay(500); // 500ms delay between requests
        const stats = await fetchVideoStats(video.videoId);
        videosWithStats.push({
          ...video,
          views: stats.views,
          likes: stats.likes,
          comments: stats.comments
        });
      } else {
        videosWithStats.push(video);
      }
    }

    // Save channel to database
    const { data: newChannel, error: insertChannelError } = await supabase
      .from('competitor_channels')
      .insert({
        user_id: user.id,
        channel_id: channelInfo.channelId,
        channel_name: channelStats.channelName,
        channel_url: `https://youtube.com/channel/${channelInfo.channelId}`,
        thumbnail_url: channelStats.thumbnailUrl,
        subscribers: channelStats.subscribers,
        total_views: channelStats.totalViews,
        video_count: channelStats.videoCount,
        country: channelStats.country,
        description: channelStats.description,
        last_fetched: new Date().toISOString()
      })
      .select()
      .single();

    if (insertChannelError) {
      console.error('Insert channel error:', insertChannelError);
      return new Response(
        JSON.stringify({ error: 'Kanal kaydedilirken hata oluştu: ' + insertChannelError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Save videos to database
    if (videosWithStats.length > 0) {
      const videoRecords = videosWithStats.map(v => ({
        channel_id: newChannel.id,
        video_id: v.videoId,
        title: v.title,
        thumbnail_url: v.thumbnailUrl,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        duration: v.duration,
        published_at: v.publishedAt || null
      }));

      const { error: insertVideosError } = await supabase
        .from('competitor_videos')
        .upsert(videoRecords, { onConflict: 'channel_id,video_id' });

      if (insertVideosError) {
        console.error('Insert videos error:', insertVideosError);
      }
    }

    // Deduct tokens
    const newTokenBalance = profile.token_balance - 2;
    const { error: updateTokenError } = await supabase
      .from('profiles')
      .update({ token_balance: newTokenBalance })
      .eq('id', user.id);

    if (updateTokenError) {
      console.error('Token update error:', updateTokenError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        channel: {
          ...newChannel,
          videos: videosWithStats
        },
        tokens_deducted: 2,
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
