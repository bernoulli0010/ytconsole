import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { encode } from "https://deno.land/std@0.168.0/encoding/base64.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { text, voice_id = "aura-asteria-en" } = await req.json()
    
    if (!text) {
      return new Response(JSON.stringify({ error: "Text is required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      })
    }

    const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") || "14da2a8493057a4bc9fe2ef8ee856d76031c8a2d";
    
    if (!DEEPGRAM_API_KEY) {
       return new Response(JSON.stringify({ error: "API Key is missing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      })
    }

    // Log for debugging
    console.log("Requesting deepgram for voice:", voice_id);
    console.log("Text length:", text.length);

    const response = await fetch(`https://api.deepgram.com/v1/speak?model=${voice_id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Token ${DEEPGRAM_API_KEY}`
      },
      body: JSON.stringify({ text: text })
    })

    if (!response.ok) {
       const errText = await response.text();
       console.error("Deepgram Error:", response.status, errText);
       return new Response(JSON.stringify({ error: `Deepgram API Error (${response.status}): ${errText}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: response.status
      })
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = encode(audioBuffer);

    return new Response(
      JSON.stringify({ audio: base64Audio }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    )
  } catch (error) {
    console.error("Edge Function Caught Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    })
  }
})
