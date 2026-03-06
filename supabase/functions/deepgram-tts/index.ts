import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { encodeBase64 } from "jsr:@std/encoding/base64"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    let reqBody;
    try {
      reqBody = await req.json();
    } catch (e) {
      console.error("Failed to parse JSON body", e);
      return new Response(JSON.stringify({ error: "Invalid JSON request body" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }
    
    const text = reqBody.text
    const voice_id = reqBody.voice_id || "aura-asteria-en"
    
    if (!text) {
      return new Response(JSON.stringify({ error: "Text is required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      })
    }

    const DEEPGRAM_API_KEY = "14da2a8493057a4bc9fe2ef8ee856d76031c8a2d";

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
       return new Response(JSON.stringify({ error: `Deepgram API Hatası: ${errText}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      })
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = encodeBase64(audioBuffer);

    return new Response(
      JSON.stringify({ audio: base64Audio }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    )
  } catch (error) {
    console.error("Edge Function Error:", error);
    return new Response(JSON.stringify({ error: error.message || "Bilinmeyen Sunucu Hatası" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    })
  }
})
