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
    
    if (!text) throw new Error("Text is required")

    const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") || "14da2a8493057a4bc9fe2ef8ee856d76031c8a2d";
    
    if (!DEEPGRAM_API_KEY) throw new Error("API Key is missing");

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
       throw new Error(`Deepgram API Error (${response.status}): ${errText}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = encode(audioBuffer);

    return new Response(
      JSON.stringify({ audio: base64Audio }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    })
  }
})
