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

type ApifyOutput = {
  sourceLang: string;
  segments: CaptionSegment[];
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

type WatchCaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind: string;
};

function parseJsonArrayAfterKey(raw: string, key: string): unknown[] {
  const keyIndex = raw.indexOf(key);
  if (keyIndex === -1) return [];

  const arrayStart = raw.indexOf("[", keyIndex);
  if (arrayStart === -1) return [];

  let i = arrayStart;
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (i < raw.length) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          const jsonArray = raw.slice(arrayStart, i + 1);
          try {
            const parsed = JSON.parse(jsonArray);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
      }
    }
    i += 1;
  }

  return [];
}

async function fetchWatchPageCaptionTracks(videoId: string): Promise<WatchCaptionTrack[]> {
  const html = await fetchWatchPageHtml(videoId);
  const rawTracks = parseJsonArrayAfterKey(html, '"captionTracks":');
  const tracks: WatchCaptionTrack[] = rawTracks
    .map((item) => {
      const rec = (item || {}) as Record<string, unknown>;
      return {
        baseUrl: safeStr(rec.baseUrl),
        languageCode: safeStr(rec.languageCode),
        kind: safeStr(rec.kind),
      };
    })
    .filter((t) => t.baseUrl.length > 0);

  if (!tracks.length) {
    throw new Error("Watch page caption track bulunamadı.");
  }

  return tracks;
}

function segmentsFromJson3Data(data: Record<string, unknown>): CaptionSegment[] {
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments: CaptionSegment[] = [];

  for (const ev of events) {
    const eventObj = (ev || {}) as Record<string, unknown>;
    const segs = Array.isArray(eventObj.segs) ? eventObj.segs : [];
    if (!segs.length) continue;

    const rawText = segs
      .map((s) => safeStr(((s || {}) as Record<string, unknown>).utf8 || ""))
      .join(" ");
    const text = cleanText(rawText);
    if (!text) continue;

    const start = safeNum(eventObj.tStartMs) / 1000;
    const dur = Math.max(0.2, safeNum(eventObj.dDurationMs, 1200) / 1000);
    segments.push({ text, start, end: start + dur, duration: dur });
  }

  return segments;
}

async function fetchCaptionSegmentsFromBaseUrl(baseUrl: string, tlang = ""): Promise<CaptionSegment[]> {
  if (!baseUrl) throw new Error("Base URL boş.");

  const url = new URL(baseUrl);
  url.searchParams.set("fmt", "json3");
  if (tlang) {
    url.searchParams.set("tlang", tlang);
  }

  const jsonResp = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (jsonResp.ok) {
    try {
      const data = (await jsonResp.json()) as Record<string, unknown>;
      const segments = segmentsFromJson3Data(data);
      if (segments.length) return segments;
    } catch {
      // fallback to xml
    }
  }

  const xmlUrl = new URL(baseUrl);
  xmlUrl.searchParams.delete("fmt");
  if (tlang) {
    xmlUrl.searchParams.set("tlang", tlang);
  }

  const xmlResp = await fetch(xmlUrl.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!xmlResp.ok) {
    throw new Error(`Caption baseUrl alınamadı (${xmlResp.status}).`);
  }

  const xml = await xmlResp.text();
  const segments = parseXmlCaptionSegments(xml);
  if (!segments.length) {
    throw new Error("Caption baseUrl boş döndü.");
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

function splitTextForFallback(text: string): string[] {
  const normalized = (text || "").replace(/\r/g, "").trim();
  if (!normalized) return [];

  const lineParts = normalized
    .split("\n")
    .map((line) => cleanText(line))
    .filter((line) => line.length > 0);

  if (lineParts.length >= 2) return lineParts;

  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanText(s))
    .filter((s) => s.length > 0);
}

function buildSegmentsFromPlainText(text: string): CaptionSegment[] {
  const parts = splitTextForFallback(text);
  const segments: CaptionSegment[] = [];
  let start = 0;

  for (const part of parts) {
    const words = part.split(/\s+/).filter(Boolean).length;
    const duration = Math.min(12, Math.max(2.5, words / 2.4));
    segments.push({
      text: part,
      start: Number(start.toFixed(2)),
      end: Number((start + duration).toFixed(2)),
      duration: Number(duration.toFixed(2)),
    });
    start += duration;
  }

  return segments;
}

function normalizeApifyTranscript(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object") {
          const rec = x as Record<string, unknown>;
          return safeStr(rec.text || rec.transcript || rec.value || "");
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function parseApifyTranscriptSegments(raw: unknown): CaptionSegment[] {
  if (!Array.isArray(raw)) return [];

  const segments: CaptionSegment[] = [];
  let cursor = 0;

  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const text = cleanText(safeStr(rec.text || rec.transcript || rec.value || ""));
    if (!text) continue;

    const startVal = safeNum(rec.start, Number.NaN);
    const endVal = safeNum(rec.end, Number.NaN);
    const durationVal = safeNum(rec.duration, Number.NaN);

    const words = text.split(/\s+/).filter(Boolean).length;
    const defaultDuration = Math.min(12, Math.max(1.6, words / 2.8));

    const start = Number.isFinite(startVal) ? startVal : cursor;
    const duration = Number.isFinite(durationVal)
      ? Math.max(0.2, durationVal)
      : Number.isFinite(endVal)
        ? Math.max(0.2, endVal - start)
        : defaultDuration;
    const end = Number.isFinite(endVal) ? Math.max(start + 0.2, endVal) : start + duration;

    segments.push({
      text,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number((end - start).toFixed(3)),
    });

    cursor = end;
  }

  return segments;
}

async function fetchApifyTranscript(videoUrl: string): Promise<ApifyOutput | null> {
  const token = Deno.env.get("APIFY_API_TOKEN");
  if (!token) return null;

  const actorId = Deno.env.get("APIFY_YT_ACTOR_ID") || "Uwpce1RSXlrzF6WBA";
  const runInput = {
    youtube_url: videoUrl,
    language: "en",
    max_videos: 1,
    include_transcript_text: true,
  };

  const runResp = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${token}&waitForFinish=120`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(runInput),
  });

  if (!runResp.ok) {
    const errText = await runResp.text();
    throw new Error(`Apify run hatası (${runResp.status}): ${errText.slice(0, 220)}`);
  }

  const runData = await runResp.json();
  const datasetId = safeStr(runData?.data?.defaultDatasetId || "");
  if (!datasetId) {
    throw new Error("Apify dataset bulunamadı.");
  }

  const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`);
  if (!itemsResp.ok) {
    throw new Error(`Apify dataset okunamadı (${itemsResp.status}).`);
  }

  const items = await itemsResp.json();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Apify transcript verisi boş.");
  }

  const item = items[0] as Record<string, unknown>;
  const timedRaw = item.transcript || item.captions || item.subtitles;
  const timedSegments = parseApifyTranscriptSegments(timedRaw);

  const transcriptRaw = item.transcript_text || timedRaw || item.description || "";
  const transcriptText = normalizeApifyTranscript(transcriptRaw).trim();

  if (!timedSegments.length && !transcriptText) {
    throw new Error("Apify transcript metni boş döndü.");
  }

  const sourceLang = normalizeLang(
    safeStr(item.language || item.transcript_language || item.lang || "auto")
  );

  return {
    sourceLang,
    segments: timedSegments.length ? timedSegments : buildSegmentsFromPlainText(transcriptText),
  };
}

async function fetchWatchPageHtml(videoId: string): Promise<string> {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) {
    throw new Error(`Watch page alınamadı (${response.status}).`);
  }
  return response.text();
}

function extractShortDescriptionFromWatchHtml(html: string): string {
  const match = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
  if (!match) return "";

  try {
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    return decoded.replace(/\r/g, "").trim();
  } catch {
    return cleanText(match[1].replace(/\\n/g, "\n"));
  }
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

async function translateWithGoogle(text: string, sourceLang: string, targetLang: string): Promise<string> {
  const src = normalizeLang(sourceLang);
  const sl = src === "auto" ? "auto" : src;
  const tl = normalizeLang(targetLang) || "en";

  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sl);
  url.searchParams.set("tl", tl);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Google Translate HTTP ${response.status}`);
  }

  const data = await response.json();
  const parts = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = parts
    .map((p: unknown) => {
      if (Array.isArray(p) && typeof p[0] === "string") return p[0];
      return "";
    })
    .join("")
    .trim();

  if (!translated) {
    throw new Error("Google Translate boş yanıt döndü");
  }

  return translated;
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

  const results: string[] = new Array(texts.length).fill("");
  const concurrency = Math.min(12, texts.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= texts.length) break;

      const original = texts[idx];
      try {
        const translated = await translateWithGoogle(original, src, tgt);
        results[idx] = cleanText(translated) || original;
      } catch {
        results[idx] = original;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
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

      const apifyResult = await fetchApifyTranscript(url);
      if (!apifyResult || !apifyResult.segments.length) {
        throw new Error("Apify transcript bulunamadı.");
      }

      const sourceLang = apifyResult.sourceLang || "auto";
      const segments = apifyResult.segments;
      const transcriptMode = "apify_only";

      const transcript = transcriptFromSegments(segments);
      const title = await fetchVideoTitle(videoId);

      return new Response(
        JSON.stringify({
          success: true,
          action,
          videoId,
          title,
          sourceLang,
          transcriptMode,
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
