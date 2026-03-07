const SUPABASE_URL = "https://bjcsbuvjumaigvsjphor.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ws-ubr-U3Uryo-oJxE0rvg_QTlz2Kqa";
const SCRIPT_TRANSFER_KEY = "ytconsole_script_transfer_v1";

const supabaseClient = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const pipelineState = {
  videoId: "",
  title: "",
  sourceLang: "",
  extractedSegments: [],
  trSegments: [],
  chunkedSegments: [],
  finalSegments: [],
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(message, tone = "neutral") {
  const el = $("statusBox");
  if (!el) return;
  el.textContent = message || "";
  el.classList.remove("is-error", "is-success");
  if (tone === "error") el.classList.add("is-error");
  if (tone === "success") el.classList.add("is-success");
}

function setButtonLoading(btn, loading, loadingText) {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = loadingText;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText || btn.textContent;
  }
}

function collapseText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function toParagraphText(items) {
  return (items || []).map((x) => collapseText(x.text)).filter(Boolean).join("\n\n");
}

function clearDownstream(step) {
  if (step <= 2) {
    pipelineState.trSegments = [];
    $("turkishOutput").value = "";
  }
  if (step <= 3) {
    pipelineState.chunkedSegments = [];
    $("segmentedOutput").value = "";
  }
  if (step <= 4) {
    pipelineState.finalSegments = [];
    $("finalOutput").value = "";
  }
}

async function invokePipeline(action, payload) {
  if (!supabaseClient) {
    throw new Error("Supabase bağlantısı bulunamadı.");
  }

  const { data, error } = await supabaseClient.functions.invoke("script-pipeline", {
    body: { action, ...payload },
  });

  if (error) throw new Error(error.message || "Fonksiyon çağrısı başarısız.");
  if (!data) throw new Error("Boş API cevabı alındı.");
  if (data.error) throw new Error(data.error);
  if (!data.success) throw new Error("İşlem başarısız.");
  return data;
}

async function handleExtract() {
  const btn = $("extractTranscriptBtn");
  const url = ($("videoUrlInput").value || "").trim();

  if (!url) {
    setStatus("Lütfen geçerli bir YouTube linki girin.", "error");
    return;
  }

  try {
    setButtonLoading(btn, true, "Çıkarılıyor...");
    setStatus("Transcript alınıyor...");
    const res = await invokePipeline("extractTranscript", { url });

    pipelineState.videoId = res.videoId || "";
    pipelineState.title = res.title || "";
    pipelineState.sourceLang = (res.sourceLang || "").toLowerCase();
    pipelineState.extractedSegments = Array.isArray(res.segments) ? res.segments : [];

    $("transcriptOutput").value = res.transcript || "";
    const modeNote = res.transcriptMode === "description_fallback" ? " | Mod: Açıklamadan üretildi" : " | Mod: Caption";
    $("extractMeta").textContent = `Video: ${pipelineState.title || "Bilinmiyor"} | Kaynak dil: ${pipelineState.sourceLang || "Bilinmiyor"} | Satır: ${pipelineState.extractedSegments.length}${modeNote}`;

    clearDownstream(2);
    setStatus("1. adım tamamlandı. Şimdi Türkçe çeviriye geçebilirsin.", "success");
  } catch (err) {
    setStatus(`Transcript çıkarılamadı: ${err.message}`, "error");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function handleTranslateTr() {
  const btn = $("translateTrBtn");
  if (!pipelineState.extractedSegments.length) {
    setStatus("Önce 1. adımda transcript çıkarılmalı.", "error");
    return;
  }

  try {
    setButtonLoading(btn, true, "Çevriliyor...");
    setStatus("Türkçe çeviri hazırlanıyor...");

    const res = await invokePipeline("translateSegments", {
      sourceLang: pipelineState.sourceLang || "auto",
      targetLang: "tr",
      segments: pipelineState.extractedSegments,
    });

    pipelineState.trSegments = Array.isArray(res.segments) ? res.segments : [];
    $("turkishOutput").value = toParagraphText(pipelineState.trSegments);

    clearDownstream(3);
    setStatus("2. adım tamamlandı. Şimdi 8 saniyelik bölümlere ayır.", "success");
  } catch (err) {
    setStatus(`Türkçe çeviri başarısız: ${err.message}`, "error");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function handleSegment() {
  const btn = $("segmentBtn");
  if (!pipelineState.trSegments.length) {
    setStatus("Önce 2. adımda Türkçe çeviri oluşturulmalı.", "error");
    return;
  }

  try {
    setButtonLoading(btn, true, "Bölünüyor...");
    setStatus("Anlamlı 8 saniyelik bölümler oluşturuluyor...");

    const res = await invokePipeline("segmentEightSeconds", {
      segments: pipelineState.trSegments,
    });

    pipelineState.chunkedSegments = Array.isArray(res.chunks) ? res.chunks : [];
    $("segmentedOutput").value = toParagraphText(pipelineState.chunkedSegments);

    clearDownstream(4);
    setStatus(`3. adım tamamlandı. ${pipelineState.chunkedSegments.length} bölüm üretildi.`, "success");
  } catch (err) {
    setStatus(`Bölümleme başarısız: ${err.message}`, "error");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function handleTranslateFinal() {
  const btn = $("translateFinalBtn");
  if (!pipelineState.chunkedSegments.length) {
    setStatus("Önce 3. adımda bölümleme yapılmalı.", "error");
    return;
  }

  const targetLang = ($("targetLanguageSelect").value || "tr").toLowerCase();

  try {
    setButtonLoading(btn, true, "Çevriliyor...");
    setStatus(`${targetLang.toUpperCase()} diline çeviri yapılıyor...`);

    const res = await invokePipeline("translateChunks", {
      sourceLang: "tr",
      targetLang,
      chunks: pipelineState.chunkedSegments,
    });

    pipelineState.finalSegments = Array.isArray(res.chunks) ? res.chunks : [];
    $("finalOutput").value = toParagraphText(pipelineState.finalSegments);
    setStatus("4. adım tamamlandı. Artık aktarım yapabilirsin.", "success");
  } catch (err) {
    setStatus(`Final çeviri başarısız: ${err.message}`, "error");
  } finally {
    setButtonLoading(btn, false);
  }
}

function handleTransfer() {
  if (!pipelineState.finalSegments.length) {
    setStatus("Önce 4. adım çıktısı oluşturulmalı.", "error");
    return;
  }

  const scenes = pipelineState.finalSegments
    .map((item) => ({
      text: collapseText(item.text),
      duration: Number(item.duration) > 0 ? Number(item.duration) : 8,
    }))
    .filter((item) => item.text.length > 0);

  if (!scenes.length) {
    setStatus("Aktarılacak geçerli bölüm bulunamadı.", "error");
    return;
  }

  const payload = {
    version: 1,
    source: "script-yazimi",
    createdAt: new Date().toISOString(),
    title: pipelineState.title || "Script Aktarımı",
    scenes,
  };

  localStorage.setItem(SCRIPT_TRANSFER_KEY, JSON.stringify(payload));
  setStatus("Aktarım verisi hazırlandı. Video Üretim Hattı açılıyor...", "success");
  window.location.href = "video-uretim-hatti.html";
}

document.addEventListener("DOMContentLoaded", () => {
  $("extractTranscriptBtn").addEventListener("click", handleExtract);
  $("translateTrBtn").addEventListener("click", handleTranslateTr);
  $("segmentBtn").addEventListener("click", handleSegment);
  $("translateFinalBtn").addEventListener("click", handleTranslateFinal);
  $("transferBtn").addEventListener("click", handleTransfer);

  setStatus("Hazır. 1. adımdan başlayabilirsin.");
});
