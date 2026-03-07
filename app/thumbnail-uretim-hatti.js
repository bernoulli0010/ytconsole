const state = {
  mode: "prompt",
  source: "upload",
  results: []
};

const actionLabels = {
  prompt: "Generate",
  recreate: "Generate",
  analyze: "Analyze",
  edit: "Edit",
  title: "Generate Titles"
};

const inputByMode = {
  recreate: { linkId: "recreateLinkInput", fileId: "recreateFileInput" },
  analyze: { linkId: "analyzeLinkInput", fileId: "analyzeFileInput" },
  edit: { linkId: "editLinkInput", fileId: "editFileInput" },
  title: { linkId: "titleLinkInput", fileId: "titleFileInput" }
};

const modeButtons = [...document.querySelectorAll(".tm-mode-btn")];
const views = [...document.querySelectorAll(".tm-view")];
const sourceButtons = [...document.querySelectorAll("[data-source]")];
const panel = document.getElementById("tmPanel");
const actionButton = document.getElementById("mainActionBtn");
const actionStatus = document.getElementById("actionStatus");
const titleResults = document.getElementById("titleResults");
const resultsList = document.getElementById("resultsList");
const copyAllResultsBtn = document.getElementById("copyAllResultsBtn");
const clearResultsBtn = document.getElementById("clearResultsBtn");

const SUPABASE_URL = window.CONFIG?.SUPABASE_URL || "";
const SUPABASE_KEY = window.CONFIG?.SUPABASE_KEY || "";
const THUMBNAIL_FUNCTION = "thumbnail-pipeline";

const supabaseClient = window.supabase && SUPABASE_URL && SUPABASE_KEY
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setMode(nextMode) {
  state.mode = nextMode;
  panel.dataset.mode = nextMode;

  modeButtons.forEach((btn) => {
    const isActive = btn.dataset.mode === nextMode;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });

  views.forEach((view) => {
    const isActive = view.dataset.view === nextMode;
    view.classList.toggle("is-active", isActive);
    view.hidden = !isActive;
  });

  actionButton.textContent = actionLabels[nextMode] || "Generate";
  actionStatus.textContent = "Hazir";
}

function setSource(nextSource) {
  state.source = nextSource;
  panel.dataset.activeSource = nextSource;

  sourceButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.source === nextSource);
  });
}

function bindModes() {
  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
}

function bindSource() {
  sourceButtons.forEach((btn) => {
    btn.addEventListener("click", () => setSource(btn.dataset.source));
  });
}

function bindToggleChips() {
  document.querySelectorAll("[data-toggle-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const toneGroup = chip.closest("[data-tone-group]");
      if (toneGroup) {
        toneGroup.querySelectorAll("[data-toggle-chip]").forEach((item) => item.classList.remove("is-active"));
        chip.classList.add("is-active");
        return;
      }
      chip.classList.toggle("is-active");
    });
  });
}

function bindDropzones() {
  document.querySelectorAll(".tm-drop").forEach((dropzone) => {
    const fileInput = dropzone.querySelector(".tm-file-input");
    const title = dropzone.querySelector(".tm-drop-title");
    const originalLabel = title ? title.textContent : "Dosya sec";

    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-dragover");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      dropzone.addEventListener(eventName, () => {
        dropzone.classList.remove("is-dragover");
      });
    });

    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files || !files.length || !title) return;
      title.textContent = `Secilen dosya: ${files[0].name}`;
    });

    if (!fileInput || !title) return;

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      title.textContent = file ? `Secilen dosya: ${file.name}` : originalLabel;
    });
  });
}

function getYouTubeId(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value);
    if (url.hostname.includes("youtu.be")) {
      const shortId = url.pathname.replace(/^\//, "");
      if (/^[a-zA-Z0-9_-]{11}$/.test(shortId)) return shortId;
    }
    const queryId = url.searchParams.get("v") || "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(queryId)) return queryId;
  } catch {
    return "";
  }

  return "";
}

function pickPreviewFromLink(link) {
  const videoId = getYouTubeId(link);
  if (videoId) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  if (/^https?:\/\/.+\.(png|jpe?g|webp)$/i.test(link)) return link;
  return "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Dosya okunamadi"));
    reader.readAsDataURL(file);
  });
}

function collectPayload() {
  const payload = {
    mode: state.mode,
    source: state.source,
    options: {
      chips: [...document.querySelectorAll(".tm-view.is-active .tm-chip.is-active[data-toggle-chip]")].map((node) => node.textContent?.trim() || "")
    }
  };

  if (state.mode === "prompt") {
    payload.prompt = document.getElementById("promptInput")?.value.trim() || "";
    return payload;
  }

  const inputs = inputByMode[state.mode];
  const link = document.getElementById(inputs.linkId)?.value.trim() || "";
  const fileInput = document.getElementById(inputs.fileId);
  const file = fileInput?.files?.[0] || null;

  payload.link = link;
  payload.previewUrl = pickPreviewFromLink(link);
  payload.file = file;

  if (state.mode === "recreate") {
    payload.edits = document.getElementById("recreateEditInput")?.value.trim() || "";
  } else if (state.mode === "analyze") {
    payload.videoTitle = document.getElementById("analyzeTitleInput")?.value.trim() || "";
  } else if (state.mode === "edit") {
    payload.edits = document.getElementById("editInstructionInput")?.value.trim() || "";
  } else if (state.mode === "title") {
    payload.context = document.getElementById("titleContextInput")?.value.trim() || "";
    payload.tone = document.querySelector("[data-tone-group] .tm-chip.is-active")?.textContent?.trim() || "Merak";
  }

  return payload;
}

async function callThumbnailFunction(payload) {
  const body = { ...payload };
  delete body.file;

  if (payload.file) {
    body.fileName = payload.file.name;
    body.fileType = payload.file.type;
    body.imageDataUrl = await readFileAsDataUrl(payload.file);
    if (!body.previewUrl) body.previewUrl = body.imageDataUrl;
  }

  if (supabaseClient) {
    const { data, error } = await supabaseClient.functions.invoke(THUMBNAIL_FUNCTION, { body });
    if (error) throw new Error(error.message || "Fonksiyon cagrisi basarisiz");
    return data;
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase ayarlari bulunamadi");
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/${THUMBNAIL_FUNCTION}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.error) {
    throw new Error(json?.error || `API hatasi (${response.status})`);
  }
  return json;
}

function normalizeApiResult(payload, apiData) {
  const result = apiData?.data || apiData?.result || apiData || {};
  const suggestions = Array.isArray(result.suggestions)
    ? result.suggestions
    : Array.isArray(result.titles)
      ? result.titles
      : [];

  const summary = result.summary
    || result.message
    || (suggestions.length ? suggestions.join("\n") : "Sonuc alindi");

  return {
    id: crypto.randomUUID(),
    mode: payload.mode,
    createdAt: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
    title: result.title || `${payload.mode.toUpperCase()} Sonucu`,
    summary,
    suggestions,
    previewUrl: result.previewUrl || payload.previewUrl || "",
    requestPayload: payload,
    raw: result
  };
}

function resultToText(result) {
  const lines = [
    `[${result.mode}] ${result.title}`,
    result.summary
  ];
  if (result.suggestions?.length) {
    lines.push("- " + result.suggestions.join("\n- "));
  }
  return lines.join("\n");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function renderTitleHelper(result) {
  if (result.mode !== "title") {
    titleResults.hidden = true;
    return;
  }
  const list = result.suggestions?.length ? result.suggestions : [result.summary];
  titleResults.innerHTML = list.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  titleResults.hidden = false;
}

function renderResults() {
  if (!state.results.length) {
    resultsList.innerHTML = '<div class="tm-empty-result">Henuz sonuc yok. Bir islem baslat.</div>';
    copyAllResultsBtn.disabled = true;
    clearResultsBtn.disabled = true;
    return;
  }

  copyAllResultsBtn.disabled = false;
  clearResultsBtn.disabled = false;

  resultsList.innerHTML = state.results.map((result) => {
    const suggestionHtml = result.suggestions?.length
      ? `<ul class="tm-result-list">${result.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "";

    const previewHtml = result.previewUrl
      ? `<img class="tm-result-preview" src="${escapeHtml(result.previewUrl)}" alt="Result preview" />`
      : "";

    return `
      <article class="tm-result-card" data-result-id="${result.id}">
        <div class="tm-result-top">
          <h3 class="tm-result-title">${escapeHtml(result.title)}</h3>
          <span class="tm-result-meta">${escapeHtml(result.mode)} - ${escapeHtml(result.createdAt)}</span>
        </div>
        ${previewHtml}
        <p class="tm-result-content">${escapeHtml(result.summary)}</p>
        ${suggestionHtml}
        <div class="tm-result-buttons">
          <button type="button" class="tm-chip" data-action="copy">Copy</button>
          <button type="button" class="tm-chip" data-action="rerun">Re-run</button>
          <button type="button" class="tm-chip" data-action="remove">Remove</button>
        </div>
      </article>
    `;
  }).join("");
}

async function handleResultAction(event) {
  const actionBtn = event.target.closest("[data-action]");
  if (!actionBtn) return;

  const card = actionBtn.closest("[data-result-id]");
  if (!card) return;

  const result = state.results.find((item) => item.id === card.dataset.resultId);
  if (!result) return;

  if (actionBtn.dataset.action === "copy") {
    try {
      await copyText(resultToText(result));
      actionStatus.textContent = "Sonuc kopyalandi";
    } catch {
      actionStatus.textContent = "Kopyalama desteklenmiyor";
    }
    return;
  }

  if (actionBtn.dataset.action === "remove") {
    state.results = state.results.filter((item) => item.id !== result.id);
    renderResults();
    actionStatus.textContent = "Kart kaldirildi";
    return;
  }

  if (actionBtn.dataset.action === "rerun") {
    actionStatus.textContent = "Tekrar cagriliyor...";
    actionButton.disabled = true;
    try {
      const rerunPayload = { ...result.requestPayload };
      const data = await callThumbnailFunction(rerunPayload);
      const rerunResult = normalizeApiResult(rerunPayload, data);
      state.results.unshift(rerunResult);
      renderResults();
      renderTitleHelper(rerunResult);
      actionStatus.textContent = "Yeni sonuc eklendi";
    } catch (error) {
      actionStatus.textContent = `Hata: ${error.message || "islem basarisiz"}`;
    } finally {
      actionButton.disabled = false;
    }
  }
}

async function handleAction() {
  const payload = collectPayload();
  actionButton.disabled = true;
  actionStatus.textContent = "Isleniyor...";

  try {
    const data = await callThumbnailFunction(payload);
    const normalized = normalizeApiResult(payload, data);

    state.results.unshift(normalized);
    renderResults();
    renderTitleHelper(normalized);
    actionStatus.textContent = "Sonuc hazir";
  } catch (error) {
    actionStatus.textContent = `Hata: ${error.message || "islem basarisiz"}`;
  } finally {
    actionButton.disabled = false;
  }
}

async function handleCopyAll() {
  if (!state.results.length) return;
  const text = state.results.map(resultToText).join("\n\n-----\n\n");
  try {
    await copyText(text);
    actionStatus.textContent = "Tum sonuclar kopyalandi";
  } catch {
    actionStatus.textContent = "Kopyalama desteklenmiyor";
  }
}

function handleClearResults() {
  state.results = [];
  titleResults.hidden = true;
  renderResults();
  actionStatus.textContent = "Sonuclar temizlendi";
}

function init() {
  bindModes();
  bindSource();
  bindToggleChips();
  bindDropzones();

  actionButton.addEventListener("click", handleAction);
  copyAllResultsBtn.addEventListener("click", handleCopyAll);
  clearResultsBtn.addEventListener("click", handleClearResults);
  resultsList.addEventListener("click", handleResultAction);

  panel.dataset.mode = state.mode;
  panel.dataset.activeSource = state.source;
  setMode("prompt");
  setSource("upload");
  renderResults();
}

init();
