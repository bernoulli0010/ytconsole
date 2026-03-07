import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type CaptionSegment = {
  text: string;
  start: number;
  end: number;
  duration: number;
};

type Chunk = {
  index: number;
  text: string;
  start: number;
  end: number;
  duration: number;
};

function safeStr(val: unknown): string {
  return typeof val === "string" ? val.trim() : "";
}

function safeNum(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(raw: string): string {
  return raw
    .replace(/\[\s*music\s*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function fetchVideoTitle(videoId: string): Promise<string> {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!response.ok) return "";
    const data = await response.json();
    return safeStr(data?.title);
  } catch {
    return "";
  }
}

function parseTrackAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rawAttrs)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

async function fetchCaptionTracks(videoId: string): Promise<Record<string, string>[]> {
  const response = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${videoId}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!response.ok) {
    throw new Error(`Caption list alınamadı (${response.status}).`);
  }

  const xml = await response.text();
  const tracks: Record<string, string>[] = [];
  const selfClosingTrackRegex = /<track\s+([^>]+?)\/>/g;
  let match: RegExpExecArray | null;

  while ((match = selfClosingTrackRegex.exec(xml)) !== null) {
    tracks.push(parseTrackAttributes(match[1]));
  }

  if (!tracks.length) {
    const openTrackRegex = /<track\s+([^>]*?)>/g;
    while ((match = openTrackRegex.exec(xml)) !== null) {
      tracks.push(parseTrackAttributes(match[1]));
    }
  }

  if (!tracks.length) {
    throw new Error("Videoda transcript/caption bulunamadı.");
  }

  return tracks;
}

function parseXmlCaptionSegments(xml: string): CaptionSegment[] {
  const segments: CaptionSegment[] = [];
  const textRegex = /<text\s+([^>]*?)>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;

  while ((match = textRegex.exec(xml)) !== null) {
    const attrs = parseTrackAttributes(match[1]);
    const start = safeNum(attrs.start);
    const dur = Math.max(0.2, safeNum(attrs.dur, 1.2));
    const text = cleanText(decodeXmlEntities(match[2] || ""));
    if (!text) continue;

    segments.push({
      text,
      start,
      end: start + dur,
      duration: dur,
    });
  }

  return segments;
}

async function fetchCaptionSegmentsByLang(videoId: string, lang: string): Promise<CaptionSegment[]> {
  const jsonParams = new URLSearchParams({ v: videoId, lang, fmt: "json3" });
  const jsonResponse = await fetch(`https://www.youtube.com/api/timedtext?${jsonParams.toString()}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (jsonResponse.ok) {
    try {
      const data = await jsonResponse.json();
      const events = Array.isArray(data?.events) ? data.events : [];
      const segments: CaptionSegment[] = [];

      for (const ev of events) {
        if (!Array.isArray(ev?.segs)) continue;
        const rawText = ev.segs.map((s: { utf8?: string }) => safeStr(s?.utf8 || "")).join(" ");
        const text = cleanText(rawText);
        if (!text) continue;

        const start = safeNum(ev.tStartMs) / 1000;
        const dur = Math.max(0.2, safeNum(ev.dDurationMs, 1200) / 1000);
        segments.push({ text, start, end: start + dur, duration: dur });
      }

      if (segments.length) return segments;
    } catch {
      // Fallback to XML endpoint below.
    }
  }

  const xmlParams = new URLSearchParams({ v: videoId, lang });
  const xmlResponse = await fetch(`https://www.youtube.com/api/timedtext?${xmlParams.toString()}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!xmlResponse.ok) {
    throw new Error(`Caption dili alınamadı: ${lang}`);
  }

  const xml = await xmlResponse.text();
  const segments = parseXmlCaptionSegments(xml);
  if (!segments.length) {
    throw new Error(`Caption boş: ${lang}`);
  }

  return segments;
}

function chooseTrack(tracks: Record<string, string>[], preferredLang = "tr"): Record<string, string> {
  const pref = preferredLang.toLowerCase();
  const exact = tracks.find((t) => safeStr(t.lang_code).toLowerCase() === pref && safeStr(t.kind).toLowerCase() !== "asr");
  if (exact) return exact;

  const prefAuto = tracks.find((t) => safeStr(t.lang_code).toLowerCase() === pref);
  if (prefAuto) return prefAuto;

  const en = tracks.find((t) => safeStr(t.lang_code).toLowerCase().startsWith("en") && safeStr(t.kind).toLowerCase() !== "asr");
  if (en) return en;

  const anyHuman = tracks.find((t) => safeStr(t.kind).toLowerCase() !== "asr");
  return anyHuman || tracks[0];
}

async function fetchCaptionSegments(videoId: string, track: Record<string, string>): Promise<CaptionSegment[]> {
  const params = new URLSearchParams({
    v: videoId,
    lang: safeStr(track.lang_code),
    fmt: "json3",
  });

  if (safeStr(track.name)) params.set("name", safeStr(track.name));
  if (safeStr(track.kind)) params.set("kind", safeStr(track.kind));

  const response = await fetch(`https://www.youtube.com/api/timedtext?${params.toString()}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!response.ok) {
    throw new Error(`Caption içeriği alınamadı (${response.status}).`);
  }

  const data = await response.json();
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments: CaptionSegment[] = [];

  for (const ev of events) {
    if (!Array.isArray(ev?.segs)) continue;
    const rawText = ev.segs.map((s: { utf8?: string }) => safeStr(s?.utf8 || "")).join(" ");
    const text = cleanText(rawText);
    if (!text) continue;

    const start = safeNum(ev.tStartMs) / 1000;
    const dur = Math.max(0.2, safeNum(ev.dDurationMs, 1200) / 1000);
    const end = start + dur;

    segments.push({
      text,
      start,
      end,
      duration: dur,
    });
  }

  if (!segments.length) {
    throw new Error("Caption segmentleri boş döndü.");
  }

  return segments;
}

function transcriptFromSegments(segments: CaptionSegment[]): string {
  const joined = segments.map((s) => s.text).join(" ");
  return joined.replace(/\s+/g, " ").trim();
}

function normalizeLang(lang: string): string {
  return safeStr(lang).toLowerCase().split("-")[0] || "auto";
}

async function callOpenRouter(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY ayarlı değil.");

  const models = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "mistralai/mistral-small-3.1-24b-instruct:free",
    "qwen/qwen3-4b:free",
    "google/gemma-3-12b-it:free",
  ];

  let lastErr = "";

  for (const model of models) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ytconsole.com",
          "X-Title": "YTConsole Script Pipeline",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: "You are a translation assistant. Always return valid JSON only, no markdown.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });

      if (response.status === 429) {
        lastErr = `${model}: rate limited`;
        continue;
      }

      if (!response.ok) {
        lastErr = `${model}: HTTP ${response.status}`;
        continue;
      }

      const data = await response.json();
      const content = safeStr(data?.choices?.[0]?.message?.content);
      if (!content) {
        lastErr = `${model}: empty response`;
        continue;
      }

      return content;
    } catch (e) {
      lastErr = `${model}: ${e instanceof Error ? e.message : "unknown error"}`;
    }
  }

  throw new Error(`Çeviri modeli cevap veremedi: ${lastErr}`);
}

function parseJsonArray(content: string): unknown[] {
  const cleaned = content.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("Geçerli JSON dizi bulunamadı.");
  const jsonText = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) throw new Error("Model çıktısı dizi değil.");
  return parsed;
}

async function translateTexts(texts: string[], sourceLang: string, targetLang: string): Promise<string[]> {
  const src = normalizeLang(sourceLang);
  const tgt = normalizeLang(targetLang);

  if (!texts.length) return [];
  if (src === tgt && src !== "auto") return texts;

  const batchSize = 70;
  const out: string[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const prompt = `Translate each item in the JSON array from ${src} to ${tgt}. Keep meaning natural for spoken script. Return only JSON array of strings with same length and order.\n\nINPUT:\n${JSON.stringify(batch)}`;
    const content = await callOpenRouter(prompt);
    const parsed = parseJsonArray(content);
    const translated = parsed.map((item, idx) => {
      const candidate = typeof item === "string" ? item : "";
      return cleanText(candidate) || batch[idx];
    });

    if (translated.length !== batch.length) {
      throw new Error("Çeviri çıktısı satır sayısı beklenenle uyuşmuyor.");
    }

    out.push(...translated);
  }

  return out;
}

function segmentIntoEightSeconds(segments: CaptionSegment[]): Chunk[] {
  if (!segments.length) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const chunks: Chunk[] = [];
  let currentTexts: string[] = [];
  let chunkStart = sorted[0].start;
  let chunkEnd = sorted[0].end;

  const TARGET = 8;
  const MAX = 11.5;

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const next = sorted[i + 1];

    if (currentTexts.length === 0) {
      chunkStart = seg.start;
      chunkEnd = seg.end;
    }

    currentTexts.push(seg.text);
    chunkEnd = Math.max(chunkEnd, seg.end);
    const duration = chunkEnd - chunkStart;
    const endsSentence = /[.!?…]["')\]]*$/.test(seg.text.trim());
    const pauseAfter = next ? Math.max(0, next.start - seg.end) > 0.65 : false;

    const shouldSplit = duration >= TARGET && (endsSentence || pauseAfter || duration >= MAX);

    if (shouldSplit || !next) {
      const text = cleanText(currentTexts.join(" "));
      if (text) {
        chunks.push({
          index: chunks.length + 1,
          text,
          start: Number(chunkStart.toFixed(2)),
          end: Number(chunkEnd.toFixed(2)),
          duration: Number((chunkEnd - chunkStart).toFixed(2)),
        });
      }
      currentTexts = [];
    }
  }

  if (chunks.length > 1) {
    const merged: Chunk[] = [];
    for (const chunk of chunks) {
      const prev = merged[merged.length - 1];
      if (prev && chunk.duration < 3) {
        prev.text = cleanText(`${prev.text} ${chunk.text}`);
        prev.end = chunk.end;
        prev.duration = Number((prev.end - prev.start).toFixed(2));
      } else {
        merged.push({ ...chunk });
      }
    }
    return merged.map((chunk, idx) => ({ ...chunk, index: idx + 1 }));
  }

  return chunks;
}

function mapSegmentsWithTexts(base: CaptionSegment[], texts: string[]): CaptionSegment[] {
  return base.map((seg, idx) => ({
    ...seg,
    text: cleanText(texts[idx] || seg.text),
  }));
}

function mapChunksWithTexts(base: Chunk[], texts: string[]): Chunk[] {
  return base.map((chunk, idx) => ({
    ...chunk,
    text: cleanText(texts[idx] || chunk.text),
  }));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const action = safeStr(body?.action);

    if (!action) {
      throw new Error("action alanı zorunlu.");
    }

    if (action === "extractTranscript") {
      const url = safeStr(body?.url);
      if (!url) throw new Error("Video URL zorunlu.");

      const videoId = extractVideoId(url);
      if (!videoId) throw new Error("Geçerli bir YouTube video linki girilmedi.");

      let sourceLang = "auto";
      let segments: CaptionSegment[] = [];

      try {
        const tracks = await fetchCaptionTracks(videoId);
        const selected = chooseTrack(tracks, "tr");
        sourceLang = normalizeLang(safeStr(selected.lang_code) || "auto");
        segments = await fetchCaptionSegments(videoId, selected);
      } catch {
        const fallbackLangs = ["tr", "en"];
        let capturedError = "";
        for (const lang of fallbackLangs) {
          try {
            segments = await fetchCaptionSegmentsByLang(videoId, lang);
            sourceLang = lang;
            break;
          } catch (e) {
            capturedError = e instanceof Error ? e.message : "fallback failed";
          }
        }

        if (!segments.length) {
          throw new Error(`Videoda transcript/caption bulunamadı. ${capturedError ? `(${capturedError})` : ""}`.trim());
        }
      }

      const transcript = transcriptFromSegments(segments);
      const title = await fetchVideoTitle(videoId);

      return new Response(
        JSON.stringify({
          success: true,
          action,
          videoId,
          title,
          sourceLang,
          transcript,
          segments,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "translateSegments") {
      const sourceLang = safeStr(body?.sourceLang) || "auto";
      const targetLang = safeStr(body?.targetLang) || "tr";
      const rawSegments = Array.isArray(body?.segments) ? body.segments : [];

      const segments: CaptionSegment[] = rawSegments
        .map((x: Record<string, unknown>) => ({
          text: cleanText(safeStr(x.text)),
          start: safeNum(x.start),
          end: safeNum(x.end),
          duration: Math.max(0.2, safeNum(x.duration, safeNum(x.end) - safeNum(x.start))),
        }))
        .filter((x) => x.text.length > 0);

      if (!segments.length) throw new Error("Çevrilecek segment bulunamadı.");

      const translated = await translateTexts(
        segments.map((s) => s.text),
        sourceLang,
        targetLang,
      );

      return new Response(
        JSON.stringify({
          success: true,
          action,
          sourceLang: normalizeLang(sourceLang),
          targetLang: normalizeLang(targetLang),
          segments: mapSegmentsWithTexts(segments, translated),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "segmentEightSeconds") {
      const rawSegments = Array.isArray(body?.segments) ? body.segments : [];
      const segments: CaptionSegment[] = rawSegments
        .map((x: Record<string, unknown>) => ({
          text: cleanText(safeStr(x.text)),
          start: safeNum(x.start),
          end: safeNum(x.end),
          duration: Math.max(0.2, safeNum(x.duration, safeNum(x.end) - safeNum(x.start))),
        }))
        .filter((x) => x.text.length > 0)
        .map((x) => ({
          ...x,
          end: x.end > x.start ? x.end : x.start + x.duration,
        }));

      if (!segments.length) throw new Error("Bölümleme için segment bulunamadı.");

      const chunks = segmentIntoEightSeconds(segments);

      return new Response(
        JSON.stringify({
          success: true,
          action,
          chunks,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "translateChunks") {
      const sourceLang = safeStr(body?.sourceLang) || "tr";
      const targetLang = safeStr(body?.targetLang) || "en";
      const rawChunks = Array.isArray(body?.chunks) ? body.chunks : [];

      const chunks: Chunk[] = rawChunks
        .map((x: Record<string, unknown>, idx: number) => ({
          index: idx + 1,
          text: cleanText(safeStr(x.text)),
          start: safeNum(x.start),
          end: safeNum(x.end),
          duration: Math.max(0.5, safeNum(x.duration, safeNum(x.end) - safeNum(x.start) || 8)),
        }))
        .filter((x) => x.text.length > 0);

      if (!chunks.length) throw new Error("Çevrilecek bölüm bulunamadı.");

      const translated = await translateTexts(
        chunks.map((c) => c.text),
        sourceLang,
        targetLang,
      );

      return new Response(
        JSON.stringify({
          success: true,
          action,
          sourceLang: normalizeLang(sourceLang),
          targetLang: normalizeLang(targetLang),
          chunks: mapChunksWithTexts(chunks, translated),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Bilinmeyen action: ${action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen hata";
    return new Response(JSON.stringify({ error: message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
