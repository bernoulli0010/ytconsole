// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { encodeBase64 } from "jsr:@std/encoding/base64"

console.log("Deepgram Edge Function is loaded and ready");

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
}

Deno.serve(async (req) => {
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
       return new Response(JSON.stringify({ error: `Deepgram API Error (${response.status}): ${errText}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      })
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = encodeBase64(audioBuffer);

    return new Response(
      JSON.stringify({ audio: base64Audio }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    })
  }
})
