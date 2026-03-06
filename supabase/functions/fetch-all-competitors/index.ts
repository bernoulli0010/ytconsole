import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!

// Fetch channel data using Apify
async function fetchChannelWithApify(channelUrl: string, channelId: string): Promise<{
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
    publishedAt: string;
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
  
  const videos = (channel.latestVideos || []).map((v: any) => ({
    videoId: v.id || v.videoId || '',
    title: v.title || '',
    thumbnailUrl: v.thumbnailUrl || v.thumbnail || '',
    views: parseInt(v.viewCount || v.views || '0', 10),
    likes: parseInt(v.likeCount || v.likes || '0', 10),
    comments: parseInt(v.commentCount || v.comments || '0', 10),
    publishedAt: v.publishedAt || v.uploadDate || ''
  }));

  return {
    channelId: channel.channelId || channel.id || '',
    channelName: channel.title || channel.channelTitle || 'Unknown Channel',
    thumbnailUrl: channel.avatarUrl || channel.thumbnailUrl || '',
    subscribers: parseInt(channel.subscriberCount || channel.subscribers || '0', 10),
    totalViews: parseInt(channel.totalViews || channel.views || '0', 10),
    videoCount: parseInt(channel.videoCount || channel.videos || '0', 10),
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
      const channelUrl = channel.channel_url || `https://www.youtube.com/channel/${channel.channel_id}`;
      
      // Update channel stats
      const channelData = await fetchChannelWithApify(channelUrl, channel.channel_id);
      
      if (channelData) {
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

        // Save videos to database
        if (channelData.videos.length > 0) {
          const videoRecords = channelData.videos.map(v => ({
            channel_id: channel.id,
            video_id: v.videoId,
            title: v.title,
            thumbnail_url: v.thumbnailUrl,
            views: v.views,
            likes: v.likes,
            comments: v.comments,
            published_at: v.publishedAt || null
          }));

          await supabase
            .from('competitor_videos')
            .upsert(videoRecords, { onConflict: 'channel_id,video_id' });
        }
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
