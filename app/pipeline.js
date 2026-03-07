const SUPABASE_URL = "https://bjcsbuvjumaigvsjphor.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ws-ubr-U3Uryo-oJxE0rvg_QTlz2Kqa";
const CACHE_KEY = "ytconsole:pipeline:cache:v1";

const STAGES = ["title", "edit", "script", "thumbnail", "publish"];

const STAGE_LABELS = {
  title: "Title & Description",
  edit: "Edit",
  script: "Script",
  thumbnail: "Thumbnail",
  publish: "Publish"
};

const state = {
  userId: null,
  tasks: [],
  view: "active",
  manualOrder: true,
  currentTaskId: null,
  dragTaskId: null,
  supabaseReady: true,
  youtubePreview: null
};

const supabaseClient = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

function $(id) {
  return document.getElementById(id);
}

function showNotice(msg) {
  const el = $("pipelineNotice");
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || "";
}

function setWriteEnabled(enabled) {
  ["newTaskBtn", "orderModeBtn", "resetOrderBtn", "previewYoutubeBtn", "addYoutubeBtn", "startScratchBtn"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.disabled = !enabled;
    el.style.opacity = enabled ? "1" : "0.55";
    el.style.cursor = enabled ? "pointer" : "not-allowed";
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(d) {
  if (!d) return "Tarih yok";
  const parsed = new Date(d + "T00:00:00");
  return parsed.toLocaleDateString("tr-TR");
}

function taskPayload(task) {
  return {
    description: task.description || "",
    scriptText: task.scriptText || "",
    videoUrl: task.videoUrl || "",
    audioUrl: task.audioUrl || "",
    thumbnailUrl: task.thumbnailUrl || "",
    thumbnailDataUrl: task.thumbnailDataUrl || "",
    seoDescription: task.seoDescription || "",
    channelStyle: task.channelStyle || "Documentary",
    targetAudience: task.targetAudience || "Informative",
    scriptLength: task.scriptLength || "Medium"
  };
}

function rowToTask(row) {
  const payload = row.payload || {};
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title || "Untitled task",
    stage: STAGES.includes(row.stage) ? row.stage : "title",
    isArchived: !!row.is_archived,
    scheduledDate: row.scheduled_date || "",
    sortOrder: Number.isFinite(row.sort_order) ? row.sort_order : 9999,
    description: payload.description || "",
    scriptText: payload.scriptText || "",
    videoUrl: payload.videoUrl || "",
    audioUrl: payload.audioUrl || "",
    thumbnailUrl: payload.thumbnailUrl || "",
    thumbnailDataUrl: payload.thumbnailDataUrl || "",
    seoDescription: payload.seoDescription || "",
    channelStyle: payload.channelStyle || "Documentary",
    targetAudience: payload.targetAudience || "Informative",
    scriptLength: payload.scriptLength || "Medium",
    updatedAt: row.updated_at || new Date().toISOString()
  };
}

function taskToRow(task) {
  return {
    id: task.id,
    user_id: state.userId,
    title: task.title,
    stage: task.stage,
    is_archived: !!task.isArchived,
    scheduled_date: task.scheduledDate || null,
    sort_order: Number.isFinite(task.sortOrder) ? task.sortOrder : 9999,
    payload: taskPayload(task),
    updated_at: new Date().toISOString()
  };
}

function persistCache() {
  if (!state.userId) return;
  const raw = {
    userId: state.userId,
    manualOrder: state.manualOrder,
    tasks: state.tasks
  };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(raw));
  } catch {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.userId !== state.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function compareTasks(a, b) {
  if (state.manualOrder) return a.sortOrder - b.sortOrder;
  const da = a.scheduledDate || "9999-12-31";
  const db = b.scheduledDate || "9999-12-31";
  if (da !== db) return da.localeCompare(db);
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function getVisibleTasks(stage) {
  return state.tasks
    .filter((task) => task.stage === stage)
    .filter((task) => (state.view === "active" ? !task.isArchived : task.isArchived))
    .sort(compareTasks);
}

function renderBoard() {
  STAGES.forEach((stage) => {
    const list = document.querySelector(`.pl-column-list[data-stage="${stage}"]`);
    if (!list) return;
    const items = getVisibleTasks(stage);

    list.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "pl-empty";
      empty.textContent = "No items";
      list.appendChild(empty);
      return;
    }

    items.forEach((task) => {
      const card = document.createElement("article");
      card.className = "pl-card";
      card.draggable = true;
      card.dataset.id = task.id;

      const thumb = task.thumbnailDataUrl || task.thumbnailUrl || "../favicon.svg";
      const archiveLabel = task.isArchived ? "Unarchive" : "Archive";
      const snippet = (task.description || task.scriptText || "No description yet.").trim();
      const chipText = STAGE_LABELS[task.stage] || "Task";

      card.innerHTML = `
        <img src="${thumb}" class="pl-card-thumb" alt="Task thumbnail" />
        <div class="pl-card-title">${escapeHtml(task.title)}</div>
        <div class="pl-card-meta">${formatDate(task.scheduledDate)}</div>
        <div class="pl-card-snippet">${escapeHtml(snippet)}</div>
        <div class="pl-card-chip">${escapeHtml(chipText)}</div>
        <div class="pl-card-actions">
          <button class="pl-action" data-action="edit">Edit</button>
          <button class="pl-action archive" data-action="archive">${archiveLabel}</button>
          <button class="pl-action delete" data-action="delete">Delete</button>
        </div>
      `;

      card.classList.add(`pl-card--${task.stage}`);

      card.addEventListener("dragstart", onCardDragStart);
      card.addEventListener("dragend", onCardDragEnd);

      card.querySelector('[data-action="edit"]').addEventListener("click", () => openTaskModal(task.id));
      card.querySelector('[data-action="archive"]').addEventListener("click", () => toggleArchive(task.id));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTask(task.id));

      list.appendChild(card);
    });
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchTasksFromSupabase() {
  const { data, error } = await supabaseClient
    .from("pipeline_tasks")
    .select("*")
    .eq("user_id", state.userId)
    .order("sort_order", { ascending: true });

  if (error) throw error;
  return (data || []).map(rowToTask);
}

async function saveTaskToSupabase(task) {
  const row = taskToRow(task);
  const { error } = await supabaseClient
    .from("pipeline_tasks")
    .upsert(row, { onConflict: "id" });

  if (error) throw error;
}

async function saveAllOrderToSupabase(tasks) {
  if (!tasks.length) return;
  const rows = tasks.map(taskToRow);
  const { error } = await supabaseClient
    .from("pipeline_tasks")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

async function deleteTaskFromSupabase(taskId) {
  const { error } = await supabaseClient
    .from("pipeline_tasks")
    .delete()
    .eq("id", taskId)
    .eq("user_id", state.userId);

  if (error) throw error;
}

function nextSortForStage(stage) {
  const inStage = state.tasks.filter((t) => t.stage === stage);
  if (!inStage.length) return 100;
  return Math.max(...inStage.map((x) => x.sortOrder || 0)) + 100;
}

function createBlankTask() {
  return {
    id: crypto.randomUUID(),
    title: "New task",
    description: "",
    stage: "title",
    isArchived: false,
    scheduledDate: todayISO(),
    sortOrder: nextSortForStage("title"),
    scriptText: "",
    videoUrl: "",
    audioUrl: "",
    thumbnailUrl: "",
    thumbnailDataUrl: "",
    seoDescription: "",
    channelStyle: "Documentary",
    targetAudience: "Informative",
    scriptLength: "Medium",
    updatedAt: new Date().toISOString()
  };
}

async function addTask() {
  const task = createBlankTask();
  state.tasks.push(task);
  persistCache();
  renderBoard();
  openTaskModal(task.id);
  await safeSaveTask(task);
}

function openProductionModal() {
  state.youtubePreview = null;
  renderYoutubePreview(null);
  $("youtubeInput").value = "";
  $("productionModal").classList.add("is-open");
  $("productionModal").setAttribute("aria-hidden", "false");
  $("youtubeInput").focus();
}

function closeProductionModal() {
  $("productionModal").classList.remove("is-open");
  $("productionModal").setAttribute("aria-hidden", "true");
}

function getYouTubeId(input) {
  const value = (input || "").trim();
  if (!value) return "";
  const idMatch = value.match(/^[a-zA-Z0-9_-]{11}$/);
  if (idMatch) return idMatch[0];

  try {
    const url = new URL(value);
    if (url.hostname.includes("youtu.be")) {
      const pathId = url.pathname.replace(/^\//, "");
      if (/^[a-zA-Z0-9_-]{11}$/.test(pathId)) return pathId;
    }
    const v = url.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
  } catch {
    return "";
  }

  return "";
}

async function fetchYouTubePreview(input) {
  const id = getYouTubeId(input);
  if (!id) {
    showNotice("Gecerli YouTube URL veya 11 karakter ID gir.");
    return null;
  }

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  const thumbnail = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  let title = `YouTube video ${id}`;

  try {
    const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(videoUrl)}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.title) title = data.title;
    }
  } catch {}

  return { id, title, videoUrl, thumbnail };
}

function renderYoutubePreview(preview) {
  const wrap = $("youtubePreview");
  const img = $("youtubePreviewImg");
  const title = $("youtubePreviewTitle");
  const id = $("youtubePreviewId");
  if (!preview) {
    wrap.hidden = true;
    return;
  }
  img.src = preview.thumbnail;
  title.textContent = preview.title;
  id.textContent = `ID: ${preview.id}`;
  wrap.hidden = false;
}

async function handleYoutubePreview() {
  const preview = await fetchYouTubePreview($("youtubeInput").value);
  state.youtubePreview = preview;
  renderYoutubePreview(preview);
  if (preview) showNotice("Preview hazir.");
}

async function addTaskFromYoutube() {
  let preview = state.youtubePreview;
  if (!preview) {
    preview = await fetchYouTubePreview($("youtubeInput").value);
    if (!preview) return;
  }

  const task = createBlankTask();
  task.title = preview.title;
  task.videoUrl = preview.videoUrl;
  task.thumbnailUrl = preview.thumbnail;
  task.description = "Imported from YouTube";
  task.updatedAt = new Date().toISOString();

  state.tasks.push(task);
  persistCache();
  renderBoard();
  closeProductionModal();
  await safeSaveTask(task);
  showNotice("YouTube videosu production'a eklendi.");
}

async function toggleArchive(taskId) {
  const task = state.tasks.find((x) => x.id === taskId);
  if (!task) return;
  task.isArchived = !task.isArchived;
  task.updatedAt = new Date().toISOString();
  persistCache();
  renderBoard();
  await safeSaveTask(task);
}

async function deleteTask(taskId) {
  state.tasks = state.tasks.filter((x) => x.id !== taskId);
  persistCache();
  renderBoard();

  if (!state.supabaseReady) return;
  try {
    await deleteTaskFromSupabase(taskId);
  } catch (err) {
    showNotice(`Supabase delete hatasi: ${err.message}.`);
  }
}

function taskProductionStatus(task) {
  const titleMetaOk = !!task.title && !!task.scheduledDate;
  return [
    { label: "Script", ok: !!task.scriptText.trim() },
    { label: "Audio", ok: !!task.audioUrl.trim() },
    { label: "Thumbnail", ok: !!(task.thumbnailDataUrl || task.thumbnailUrl) },
    { label: "Title/Meta", ok: titleMetaOk }
  ];
}

function renderStatusGrid(task) {
  const grid = $("statusGrid");
  if (!grid) return;
  const statuses = taskProductionStatus(task);
  grid.innerHTML = "";

  statuses.forEach((s) => {
    const div = document.createElement("div");
    div.className = `pl-status-chip ${s.ok ? "complete" : "pending"}`;
    div.textContent = `${s.label} - ${s.ok ? "Complete" : "Needs work"}`;
    grid.appendChild(div);
  });
}

function openTaskModal(taskId) {
  const task = state.tasks.find((x) => x.id === taskId);
  if (!task) return;
  state.currentTaskId = task.id;

  $("taskTitleInput").value = task.title || "";
  $("scheduledDateInput").value = task.scheduledDate || "";
  $("taskStageSelect").value = task.stage;
  $("videoUrlInput").value = task.videoUrl || "";
  $("scriptInput").value = task.scriptText || "";
  $("audioUrlInput").value = task.audioUrl || "";
  $("thumbUrlInput").value = task.thumbnailUrl || "";
  $("seoInput").value = task.seoDescription || "";
  $("channelStyleSelect").value = task.channelStyle || "Documentary";
  $("targetAudienceSelect").value = task.targetAudience || "Informative";
  $("scriptLengthSelect").value = task.scriptLength || "Medium";

  renderThumbnailPreview(task);
  renderStatusGrid(task);

  $("taskModal").classList.add("is-open");
  $("taskModal").setAttribute("aria-hidden", "false");
}

function closeTaskModal() {
  $("taskModal").classList.remove("is-open");
  $("taskModal").setAttribute("aria-hidden", "true");
}

function renderThumbnailPreview(task) {
  const img = $("thumbPreview");
  const empty = $("thumbEmpty");
  const src = task.thumbnailDataUrl || task.thumbnailUrl;
  if (src) {
    img.src = src;
    img.style.display = "block";
    empty.style.display = "none";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
    empty.style.display = "block";
  }
}

async function safeSaveTask(task) {
  persistCache();
  if (!state.supabaseReady) return;
  try {
    await saveTaskToSupabase(task);
  } catch (err) {
    state.supabaseReady = false;
    showNotice(
      "Supabase baglantisi su an yazilamiyor. Local cache acik. Tablo kontrolu: pipeline_tasks"
    );
  }
}

async function handleTaskSubmit(e) {
  e.preventDefault();
  const task = state.tasks.find((x) => x.id === state.currentTaskId);
  if (!task) return;

  task.title = $("taskTitleInput").value.trim() || "Untitled task";
  task.scheduledDate = $("scheduledDateInput").value;
  task.stage = $("taskStageSelect").value;
  task.videoUrl = $("videoUrlInput").value.trim();
  task.scriptText = $("scriptInput").value;
  task.audioUrl = $("audioUrlInput").value.trim();
  task.thumbnailUrl = $("thumbUrlInput").value.trim();
  task.seoDescription = $("seoInput").value;
  task.channelStyle = $("channelStyleSelect").value;
  task.targetAudience = $("targetAudienceSelect").value;
  task.scriptLength = $("scriptLengthSelect").value;
  task.updatedAt = new Date().toISOString();

  if (!state.manualOrder) {
    task.sortOrder = nextSortForStage(task.stage);
  }

  renderStatusGrid(task);
  renderBoard();
  closeTaskModal();
  await safeSaveTask(task);
}

function onCardDragStart(e) {
  const el = e.currentTarget;
  state.dragTaskId = el.dataset.id;
  el.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
}

function onCardDragEnd(e) {
  e.currentTarget.classList.remove("is-dragging");
}

function bindDropZones() {
  document.querySelectorAll(".pl-column-list").forEach((list) => {
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    list.addEventListener("drop", async (e) => {
      e.preventDefault();
      const taskId = state.dragTaskId;
      if (!taskId) return;

      const task = state.tasks.find((x) => x.id === taskId);
      if (!task) return;

      const targetStage = list.dataset.stage;
      task.stage = targetStage;
      task.updatedAt = new Date().toISOString();

      if (state.manualOrder) {
        const inStage = state.tasks
          .filter((t) => t.stage === targetStage)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const maxSort = inStage.length ? inStage[inStage.length - 1].sortOrder : 0;
        task.sortOrder = maxSort + 100;
      } else {
        task.sortOrder = nextSortForStage(targetStage);
      }

      renderBoard();
      await safeSaveTask(task);
    });
  });
}

function resetOrder() {
  state.manualOrder = false;
  state.tasks
    .sort(compareTasks)
    .forEach((task, idx) => {
      task.sortOrder = (idx + 1) * 100;
      task.updatedAt = new Date().toISOString();
    });
  $("orderModeLabel").textContent = "Auto by date";
  persistCache();
  renderBoard();
  saveAllOrderToSupabase(state.tasks).catch(() => {
    showNotice("Siralama Supabase'e yazilamadi. Cache uzerinden devam ediliyor.");
  });
}

function toggleOrderMode() {
  state.manualOrder = !state.manualOrder;
  $("orderModeLabel").textContent = state.manualOrder ? "Manual order" : "Auto by date";
  persistCache();
  renderBoard();
}

function setView(view) {
  state.view = view;
  $("viewActiveBtn").classList.toggle("is-active", view === "active");
  $("viewArchivedBtn").classList.toggle("is-active", view === "archived");
  renderBoard();
}

function applyFocusFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const focus = params.get("focus");
  if (!focus) return;
  if (!STAGES.includes(focus)) return;

  setView("active");

  requestAnimationFrame(() => {
    const section = document.querySelector(`.pl-column[data-stage="${focus}"]`);
    if (!section) return;

    section.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    section.classList.add("pl-column-focus");
    setTimeout(() => section.classList.remove("pl-column-focus"), 1600);
  });
}

function bindModalActions() {
  $("closeProductionModalBtn").addEventListener("click", closeProductionModal);
  $("productionModal").addEventListener("click", (e) => {
    if (e.target === $("productionModal")) closeProductionModal();
  });
  $("previewYoutubeBtn").addEventListener("click", handleYoutubePreview);
  $("addYoutubeBtn").addEventListener("click", addTaskFromYoutube);
  $("startScratchBtn").addEventListener("click", async () => {
    closeProductionModal();
    await addTask();
  });

  $("closeTaskModalBtn").addEventListener("click", closeTaskModal);
  $("taskModal").addEventListener("click", (e) => {
    if (e.target === $("taskModal")) closeTaskModal();
  });

  $("taskForm").addEventListener("submit", handleTaskSubmit);

  $("thumbUploadBtn").addEventListener("click", () => $("thumbFileInput").click());
  $("thumbFileInput").addEventListener("change", async (e) => {
    const task = state.tasks.find((x) => x.id === state.currentTaskId);
    if (!task) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      task.thumbnailDataUrl = String(reader.result || "");
      task.updatedAt = new Date().toISOString();
      renderThumbnailPreview(task);
      renderBoard();
      await safeSaveTask(task);
      e.target.value = "";
    };
    reader.readAsDataURL(file);
  });

  $("thumbOpenBtn").addEventListener("click", () => {
    const task = state.tasks.find((x) => x.id === state.currentTaskId);
    if (!task) return;
    const src = task.thumbnailDataUrl || task.thumbnailUrl;
    if (!src) return;
    window.open(src, "_blank", "noopener,noreferrer");
  });

  $("thumbDownloadBtn").addEventListener("click", () => {
    const task = state.tasks.find((x) => x.id === state.currentTaskId);
    if (!task) return;
    const src = task.thumbnailDataUrl || task.thumbnailUrl;
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = `${task.title || "thumbnail"}.jpg`;
    a.click();
  });

  $("thumbCopyBtn").addEventListener("click", async () => {
    const task = state.tasks.find((x) => x.id === state.currentTaskId);
    if (!task) return;
    const src = task.thumbnailDataUrl || task.thumbnailUrl;
    if (!src) return;
    try {
      await navigator.clipboard.writeText(src);
      showNotice("Thumbnail link kopyalandi.");
      setTimeout(() => showNotice(""), 1600);
    } catch {
      showNotice("Kopyalama desteklenmiyor.");
    }
  });

  $("thumbRemoveBtn").addEventListener("click", async () => {
    const task = state.tasks.find((x) => x.id === state.currentTaskId);
    if (!task) return;
    task.thumbnailDataUrl = "";
    task.thumbnailUrl = "";
    $("thumbUrlInput").value = "";
    task.updatedAt = new Date().toISOString();
    renderThumbnailPreview(task);
    renderBoard();
    await safeSaveTask(task);
  });

  $("mockAiBtn").addEventListener("click", () => {
    const el = $("scriptInput");
    if (!el.value.trim()) {
      el.value = "Hook: Start with a surprising claim.\n\nBody: Add 3 concise evidence points.\n\nCTA: Ask viewers to test and comment their result.";
    }
  });
}

async function initData() {
  if (!supabaseClient) {
    state.supabaseReady = false;
    showNotice("Supabase istemcisi bulunamadi. Local cache modunda.");
    setWriteEnabled(false);
    return;
  }

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    const user = data?.session?.user;
    if (!user) {
      showNotice("Pipeline kayitlari icin once giris yapin.");
      state.supabaseReady = false;
      setWriteEnabled(false);
      return;
    }
    state.userId = user.id;
    setWriteEnabled(true);

    const cache = loadCache();
    if (cache?.tasks?.length) {
      state.tasks = cache.tasks;
      state.manualOrder = cache.manualOrder !== false;
      $("orderModeLabel").textContent = state.manualOrder ? "Manual order" : "Auto by date";
    }

    try {
      const remote = await fetchTasksFromSupabase();
      state.tasks = remote;
      state.supabaseReady = true;
      showNotice("");
      persistCache();
    } catch (err) {
      state.supabaseReady = false;
      showNotice(
        `Supabase okuma hatasi: ${err.message}. Tablo/policy/grant ayarlarini kontrol edin (pipeline_tasks).`
      );
      setWriteEnabled(true);
    }
  } catch (err) {
    state.supabaseReady = false;
    showNotice(`Auth kontrol hatasi: ${err.message}`);
    setWriteEnabled(false);
  }
}

function bindTopActions() {
  $("newTaskBtn").addEventListener("click", openProductionModal);
  $("resetOrderBtn").addEventListener("click", resetOrder);
  $("orderModeBtn").addEventListener("click", toggleOrderMode);
  $("viewActiveBtn").addEventListener("click", () => setView("active"));
  $("viewArchivedBtn").addEventListener("click", () => setView("archived"));
}

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTaskModal();
      closeProductionModal();
    }
  });
}

async function init() {
  bindTopActions();
  bindModalActions();
  bindDropZones();
  setupKeyboard();
  await initData();
  renderBoard();
  applyFocusFromQuery();
}

init();
