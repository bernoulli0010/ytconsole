import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
}

function asText(input: unknown): string {
  return typeof input === "string" ? input.trim() : ""
}

function firstSentence(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim()
  if (!clean) return ""
  const idx = clean.search(/[.!?]/)
  return idx > 10 ? clean.slice(0, idx + 1) : clean
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
}

function buildPromptResult(body: Record<string, unknown>) {
  const prompt = asText(body.prompt)
  const optionsObj = (body.options && typeof body.options === "object")
    ? body.options as Record<string, unknown>
    : {}
  const chipsRaw = Array.isArray(optionsObj.chips) ? optionsObj.chips : []
  const chips = chipsRaw.map((item) => asText(item)).filter(Boolean)
  const style = chips.length ? chips.join(", ") : "Default"

  return {
    title: "Prompt Draft",
    summary: prompt
      ? `Prompt guclendirildi. Stil secimi: ${style}.`
      : "Prompt bos geldigi icin genel bir taslak hazirlandi.",
    suggestions: [
      `Ana kompozisyon: ${firstSentence(prompt) || "Merkezde bir ana karakter, solda metin alani."}`,
      "Kontrast: Arka plan koyu, odak objede parlak vurgu kullan.",
      "Metin alani: 2-4 kelimelik buyuk bir hook birak."
    ]
  }
}

function buildRecreateResult(body: Record<string, unknown>) {
  const edits = asText(body.edits)
  const link = asText(body.link)

  return {
    title: "Recreate Plan",
    summary: edits
      ? "Kaynak gorselden yeni bir varyasyon plani olusturuldu."
      : "Kaynak gorsel baz alinarak varsayilan recreate plani olusturuldu.",
    suggestions: [
      `Kaynak: ${link || "Yuklenen dosya"}`,
      `Degisiklik istegi: ${edits || "Arka plan derinligi artir, yuz kontrastini guclendir."}`,
      "Yeni varyasyon: Metin daha kisa, konu daha yakin kadraj."
    ],
    previewUrl: asText(body.previewUrl)
  }
}

function buildAnalyzeResult(body: Record<string, unknown>) {
  const videoTitle = asText(body.videoTitle)
  const keyTerms = words(videoTitle)

  return {
    title: "Thumbnail Analysis",
    summary: "Kompozisyon, okunabilirlik ve CTR odakli analiz tamamlandi.",
    suggestions: [
      `Baslik uyumu: ${videoTitle ? "Yuksek" : "Orta"}`,
      "Renk dengesi: Ana konu ile arka plan ayrimi guclendirilebilir.",
      "Yazi okunabilirligi: Stroke veya golge ile metni ayir.",
      keyTerms.length ? `Anahtar kelimeler: ${keyTerms.join(", ")}` : "Anahtar kelime bulunamadi."
    ],
    previewUrl: asText(body.previewUrl)
  }
}

function buildEditResult(body: Record<string, unknown>) {
  const edits = asText(body.edits)

  return {
    title: "Edit Instructions",
    summary: "Duzenleme adimlari sirali sekilde olusturuldu.",
    suggestions: [
      "Adim 1: Ana konu etrafinda maskeyi yumusat.",
      "Adim 2: Konu uzerine yerel parlaklik +10 uygula.",
      "Adim 3: Arka plani hafif blur ile ayir.",
      `Adim 4: Ozellestirme notu - ${edits || "Sol ust metni daha buyuk yap."}`
    ],
    previewUrl: asText(body.previewUrl)
  }
}

function buildTitleResult(body: Record<string, unknown>) {
  const context = asText(body.context)
  const tone = asText(body.tone) || "Merak"
  const lead = context ? context.slice(0, 42) : "Bu thumbnail"

  return {
    title: "Title Suggestions",
    summary: `${tone} tonunda 3 baslik onerisi olusturuldu.`,
    suggestions: [
      `${lead}: Kimsenin Gormedigi 3 Kritik Nokta`,
      `${lead} - 7 Dakikada Net Sonuc`,
      `${tone} Etkisiyle Tiklanma Artiran Thumbnail Stratejisi`
    ],
    previewUrl: asText(body.previewUrl)
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const mode = asText(body.mode).toLowerCase()

    const data = mode === "prompt"
      ? buildPromptResult(body)
      : mode === "recreate"
        ? buildRecreateResult(body)
        : mode === "analyze"
          ? buildAnalyzeResult(body)
          : mode === "edit"
            ? buildEditResult(body)
            : mode === "title"
              ? buildTitleResult(body)
              : null

    if (!data) {
      return new Response(JSON.stringify({ error: "Gecersiz mode degeri" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message || "Sunucu hatasi" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  }
})
