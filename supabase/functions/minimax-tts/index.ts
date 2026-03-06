import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { text, voice_id = "speech-01" } = await req.json()
    
    if (!text) throw new Error("Text is required")

    // Get API Key from Supabase Secrets
    const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY") || "fa21a0b596b41dc13210dbb1524acf8a901f5468";
    
    if (!MINIMAX_API_KEY) throw new Error("MINIMAX_API_KEY is not set in environment variables");

    // Call MiniMax T2A API (International Endpoint)
    const response = await fetch("https://api.minimaxi.chat/v1/t2a_v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MINIMAX_API_KEY}`
      },
      body: JSON.stringify({
        model: "speech-01-turbo",
        text: text,
        stream: false,
        voice_setting: {
          voice_id: voice_id,
          speed: 1.0,
          vol: 1.0,
          pitch: 0
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3"
        }
      })
    })

    const data = await response.json()

    // Handle Minimax specific errors
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax Hatası (${data.base_resp.status_code}): ${data.base_resp.status_msg}`);
    }
    
    return new Response(
      JSON.stringify(data),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    })
  }
})
