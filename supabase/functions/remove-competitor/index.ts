import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://bjcsbuvjumaigvsjphor.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Yetkilendirme gerekli' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const accessToken = authHeader.replace('Bearer ', '').trim();

    // Create Supabase client and validate token explicitly
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Get user from token
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Geçersiz yetkilendirme' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { channel_id } = await req.json();

    if (!channel_id) {
      return new Response(
        JSON.stringify({ error: 'Kanal ID gerekli' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify channel belongs to user and delete
    const { data: deletedChannel, error: deleteError } = await supabase
      .from('competitor_channels')
      .delete()
      .eq('id', channel_id)
      .eq('user_id', user.id)
      .select('channel_name')
      .single();

    if (deleteError) {
      console.error('Delete error:', deleteError);
      return new Response(
        JSON.stringify({ error: 'Kanal silinirken hata oluştu' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!deletedChannel) {
      return new Response(
        JSON.stringify({ error: 'Kanal bulunamadı veya silme yetkiniz yok' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Videos are automatically deleted via CASCADE

    return new Response(
      JSON.stringify({
        success: true,
        message: `${deletedChannel.channel_name} başarıyla silindi`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error("remove-competitor error:", error);
    return new Response(
      JSON.stringify({ error: error.message || 'Sunucu hatası' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
