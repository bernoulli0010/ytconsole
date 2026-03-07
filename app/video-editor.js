/**
 * Video Production Line (Video Üretim Hattı)
 * Core Logic & State Management
 */

// API Keys provided by user
const PEXELS_API_KEY = "xaKuGpofQUgZYx6JlPEZJdqhgUnsUu8ZpJmbT4tnhA0J2Rpb5vO3ibx0";
const PIXABAY_API_KEY = "54799067-a3fed06a32d899bc1ede143be";

// State Management
let projectState = {
  title: "Başlıksız",
  subtitlePreset: "default",
  logo: {
    url: null,
    position: 'top-right',
    size: 15,
    margin: 5
  },
  backgroundMusic: null,
  scenes: [
    {
      id: generateId(),
      text: "Dose control matters. Limit consumption to one ounce daily...",
      voice: "aura-asteria-en", // Deepgram voice ID
      audioUrl: null, // to persist generated TTS
      media: null, // { type: 'video', url: '...', thumbnail: '...', duration: 5 }
      overlays: [], // Text overlays { id, type, text, fontSize, color, x, y, fontWeight }
      duration: 5.0, // estimated duration in seconds
      autoSearched: false
    }
  ],
  activeSceneId: null,
  isPlaying: false,
  currentTime: 0,
  totalDuration: 5.0
};

const SUPABASE_URL = "https://bjcsbuvjumaigvsjphor.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ws-ubr-U3Uryo-oJxE0rvg_QTlz2Kqa";
const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const SCRIPT_TRANSFER_KEY = "ytconsole_script_transfer_v1";
const DEFAULT_PIXELS_PER_SECOND = 30;
const MIN_SCENE_DURATION = 1;
const MAX_SCENE_DURATION = 120;

// Drag & Drop State for Overlays
let activeDragOverlay = null;
let activeDragEl = null;
let dragStartX = 0;
let dragStartY = 0;
let dragInitialX = 0;
let dragInitialY = 0;
let playbackRafId = null;
let lastPlaybackTick = 0;
let timelineZoom = 100;

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  const hasImportedScenes = importScenesFromScriptStorage(false);
  if (!hasImportedScenes) {
    projectState.activeSceneId = projectState.scenes[0].id;
  }
  
  initUI();
  bindEvents();
  renderScenes();
  renderTimeline();
  
  // Auto-search for the initial scene if it has text
  if (!hasImportedScenes && projectState.scenes[0].text && !projectState.scenes[0].media) {
    autoSearchMediaForScene(projectState.scenes[0]);
  }
});

// -- Utility Functions --
function estimateSceneDuration(text) {
  const wordCount = (text || "").trim().split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(3.0, wordCount / 2.5);
}

function normalizeSceneDuration(rawDuration, fallbackDuration) {
  let duration = Number(rawDuration);
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = Number(fallbackDuration);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = 8;
  }

  if (duration > 300) {
    duration = duration / 1000;
  }

  duration = Math.max(MIN_SCENE_DURATION, Math.min(MAX_SCENE_DURATION, duration));
  return Number(duration.toFixed(2));
}

function getPixelsPerSecond() {
  return DEFAULT_PIXELS_PER_SECOND * (timelineZoom / 100);
}

function getSceneStartTime(sceneId) {
  let offset = 0;
  for (const scene of projectState.scenes) {
    if (scene.id === sceneId) return offset;
    offset += scene.duration;
  }
  return 0;
}

function getSceneAtTime(time) {
  if (!projectState.scenes.length) return null;
  if (time <= 0) {
    return {
      scene: projectState.scenes[0],
      sceneStart: 0,
      timeIntoScene: 0
    };
  }

  let sceneStart = 0;
  for (const scene of projectState.scenes) {
    const sceneEnd = sceneStart + scene.duration;
    if (time <= sceneEnd) {
      return {
        scene,
        sceneStart,
        timeIntoScene: Math.max(0, time - sceneStart)
      };
    }
    sceneStart = sceneEnd;
  }

  const lastScene = projectState.scenes[projectState.scenes.length - 1];
  return {
    scene: lastScene,
    sceneStart: Math.max(0, projectState.totalDuration - lastScene.duration),
    timeIntoScene: Math.max(0, lastScene.duration - 0.05)
  };
}

function syncSceneMediaAtTime(scene, timeIntoScene) {
  const player = document.getElementById('mainVideoPlayer');
  const sceneAudio = document.getElementById(`audio-${scene.id}`);

  if (scene.media && scene.media.type === 'video' && player && player.src) {
    const mediaDuration = Number(player.duration);
    if (Number.isFinite(mediaDuration) && mediaDuration > 0.1) {
      const target = Math.max(0, Math.min(timeIntoScene, mediaDuration - 0.05));
      if (Math.abs(player.currentTime - target) > 0.25) {
        player.currentTime = target;
      }
    }
  }

  if (sceneAudio && sceneAudio.src) {
    const audioDuration = Number(sceneAudio.duration);
    if (Number.isFinite(audioDuration) && audioDuration > 0.1) {
      const audioTarget = Math.max(0, Math.min(timeIntoScene, audioDuration - 0.05));
      if (Math.abs(sceneAudio.currentTime - audioTarget) > 0.1) {
        sceneAudio.currentTime = audioTarget;
      }
    }
  }
}

function seekToTime(time, options = {}) {
  const {
    pausePlayback = false,
    syncMedia = true,
    keepPlaying = projectState.isPlaying,
    forceRender = false
  } = options;

  if (pausePlayback && projectState.isPlaying) {
    togglePlay();
  }

  const clamped = Math.max(0, Math.min(time, projectState.totalDuration));
  projectState.currentTime = clamped;

  const sceneInfo = getSceneAtTime(clamped);
  if (sceneInfo && (forceRender || projectState.activeSceneId !== sceneInfo.scene.id)) {
    projectState.activeSceneId = sceneInfo.scene.id;
    renderScenes();
    renderPropertiesPanel();
  }

  if (sceneInfo && syncMedia) {
    syncSceneMediaAtTime(sceneInfo.scene, sceneInfo.timeIntoScene);
  }

  updatePlayhead();

  const player = document.getElementById('mainVideoPlayer');
  const sceneAudio = sceneInfo ? document.getElementById(`audio-${sceneInfo.scene.id}`) : null;
  const bgMusicPlayer = document.getElementById('bgMusicPlayer');

  if (keepPlaying) {
    if (player && player.src) player.play().catch(() => {});
    if (sceneAudio && sceneAudio.src) sceneAudio.play().catch(() => {});
    if (bgMusicPlayer && bgMusicPlayer.src) {
      const bgDuration = Number(bgMusicPlayer.duration);
      if (Number.isFinite(bgDuration) && bgDuration > 0) {
        bgMusicPlayer.currentTime = clamped % bgDuration;
      }
      bgMusicPlayer.play().catch(() => {});
    }
  }
}

function importScenesFromScriptStorage(showFeedback = true) {
  try {
    const raw = localStorage.getItem(SCRIPT_TRANSFER_KEY);
    if (!raw) {
      if (showFeedback) {
        alert("Aktarılacak script bulunamadı. Önce Script Yazımı sayfasından aktarım yapın.");
      }
      return false;
    }

    const payload = JSON.parse(raw);
    const imported = Array.isArray(payload?.scenes) ? payload.scenes : [];
    const normalizedScenes = imported
      .map((scene) => {
        const text = String(scene?.text || "").replace(/\s+/g, " ").trim();
        if (!text) return null;
        const duration = normalizeSceneDuration(scene?.duration, estimateSceneDuration(text));

        return {
          id: generateId(),
          text,
          voice: "aura-asteria-en",
          audioUrl: null,
          media: null,
          overlays: [],
          duration,
          autoSearched: false
        };
      })
      .filter(Boolean);

    if (!normalizedScenes.length) {
      localStorage.removeItem(SCRIPT_TRANSFER_KEY);
      if (showFeedback) {
        alert("Aktarım verisinde geçerli bölüm bulunamadı.");
      }
      return false;
    }

    projectState.title = String(payload?.title || "Script Aktarımı").trim() || "Script Aktarımı";
    projectState.scenes = normalizedScenes;
    projectState.activeSceneId = normalizedScenes[0].id;
    projectState.currentTime = 0;
    updateTotalDuration();

    localStorage.removeItem(SCRIPT_TRANSFER_KEY);

    if (showFeedback) {
      alert(`Script başarıyla aktarıldı. ${normalizedScenes.length} bölüm yüklendi.`);
    }
    return true;
  } catch (e) {
    console.error("Script import error:", e);
    if (showFeedback) {
      alert("Script aktarımı sırasında hata oluştu.");
    }
    return false;
  }
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// -- UI Initialization & Events --
function initUI() {
  document.getElementById('projectTitle').value = projectState.title;
}

function bindEvents() {
  // Project Title Input Logic
  const titleInput = document.getElementById('projectTitle');
  if (titleInput) {
    titleInput.addEventListener('input', (e) => {
      projectState.title = e.target.value || "Başlıksız";
    });
  }

  const importScriptBtn = document.getElementById('importScriptBtn');
  if (importScriptBtn) {
    importScriptBtn.addEventListener('click', () => {
      const imported = importScenesFromScriptStorage(true);
      if (imported) {
        renderScenes();
        renderTimeline();
        updatePreview();
        renderPropertiesPanel();
      }
    });
  }

  // Overlay Dragging Logic
  document.addEventListener('mousemove', (e) => {
    if (!activeDragOverlay || !activeDragEl) return;
    const container = document.getElementById('overlaysContainer');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    
    const dx = ((e.clientX - dragStartX) / rect.width) * 100;
    const dy = ((e.clientY - dragStartY) / rect.height) * 100;
    
    activeDragOverlay.x = Math.max(0, Math.min(100, dragInitialX + dx));
    activeDragOverlay.y = Math.max(0, Math.min(100, dragInitialY + dy));
    
    activeDragEl.style.left = activeDragOverlay.x + '%';
    activeDragEl.style.top = activeDragOverlay.y + '%';
  });

  document.addEventListener('mouseup', () => {
    if (activeDragOverlay) {
      activeDragOverlay = null;
      activeDragEl = null;
    }
  });

  // -- Header Buttons --
  document.getElementById('newVideoBtn').addEventListener('click', () => {
    if (confirm("Mevcut projeyi silip yeni bir video başlatmak istiyor musunuz?")) {
      projectState.title = "Başlıksız Proje";
      document.getElementById('projectTitle').value = projectState.title;
      projectState.scenes = [{
        id: generateId(), text: "", voice: "aura-asteria-en",
      audioUrl: null, media: null, overlays: [], duration: normalizeSceneDuration(5.0, 5.0), autoSearched: false
      }];
      projectState.activeSceneId = projectState.scenes[0].id;
      projectState.currentTime = 0;
      updateTotalDuration();
      renderScenes();
      renderTimeline();
    }
  });

  document.getElementById('exportVideoBtn').addEventListener('click', () => {
    // Show Export Modal
    const modalHtml = `
      <div id="exportModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:9999;">
        <div style="background:var(--bg); padding:24px; border-radius:var(--radius); width:400px; box-shadow:var(--shadow-md);">
          <h3 style="margin-bottom:16px;">Video Oluştur</h3>
          <div style="margin-bottom:16px;">
            <label style="display:block; margin-bottom:8px; font-weight:600; font-size:14px;">Çözünürlük</label>
            <select id="exportResolution" style="width:100%; padding:10px; border-radius:var(--radius-sm); border:1px solid var(--border); background:var(--bg); color:var(--text);">
              <option value="1280x720">720p (Hızlı)</option>
              <option value="1920x1080" selected>1080p (Önerilen)</option>
              <option value="3840x2160">4K (En Yüksek Kalite)</option>
            </select>
          </div>
          <div id="exportProgress" style="display:none; margin-bottom:16px;">
             <p style="font-size:13px; font-weight:600; color:var(--text);">İşleniyor: <span id="exportStatusText">Başlıyor...</span></p>
             <div style="width:100%; height:6px; background:var(--border); border-radius:3px; margin-top:6px; overflow:hidden;">
                <div id="exportProgressBar" style="width:0%; height:100%; background:var(--brand); transition:width 0.3s ease;"></div>
             </div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:24px;">
            <button onclick="document.getElementById('exportModal').remove()" class="btn-secondary" id="cancelExportBtn">İptal</button>
            <button id="startExportBtn" class="btn-primary">Oluştur ve İndir</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('startExportBtn').addEventListener('click', async () => {
      const res = document.getElementById('exportResolution').value;
      
      // Prevent multiple clicks
      document.getElementById('startExportBtn').disabled = true;
      document.getElementById('exportProgress').style.display = 'block';
      
      await performVideoExport(res);
    });

    document.getElementById('cancelExportBtn').addEventListener('click', () => {
      if (window.activeFFmpeg) {
        try {
          window.activeFFmpeg.terminate();
        } catch (e) {
          console.error("FFmpeg terminate error:", e);
        }
        window.activeFFmpeg = null;
      }
      const modal = document.getElementById('exportModal');
      if (modal) modal.remove();
    });
  });

  // Tabs
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('is-active'));
      e.currentTarget.classList.add('is-active');
      
      const panel = e.currentTarget.getAttribute('data-panel');
      
      // Hide all panels
      document.getElementById('activePanelContent').style.display = 'none';
      document.getElementById('medyaPanelContent').style.display = 'none';
      const metinPanel = document.getElementById('metinPanelContent');
      if(metinPanel) metinPanel.style.display = 'none';
      const altyaziPanel = document.getElementById('altyazilarPanelContent');
      if(altyaziPanel) altyaziPanel.style.display = 'none';
      const logoPanel = document.getElementById('logoPanelContent');
      if(logoPanel) logoPanel.style.display = 'none';
      const muzikPanel = document.getElementById('muzikPanelContent');
      if(muzikPanel) muzikPanel.style.display = 'none';
      
      if (panel === 'senaryo') {
        document.getElementById('activePanelContent').style.display = 'flex';
        document.querySelector('#activePanelContent .panel-title').textContent = 'Senaryo';
      } else if (panel === 'medya') {
        document.getElementById('medyaPanelContent').style.display = 'flex';
        // Trigger generic search if empty
        if (document.getElementById('mediaGrid').innerHTML.trim() === '') {
          searchAllMedia("nature", true);
        }
      } else if (panel === 'metin') {
        if(metinPanel) metinPanel.style.display = 'flex';
      } else if (panel === 'altyazilar') {
        if(altyaziPanel) altyaziPanel.style.display = 'flex';
      } else if (panel === 'logo') {
        if(logoPanel) logoPanel.style.display = 'flex';
      } else if (panel === 'muzik') {
        if(muzikPanel) muzikPanel.style.display = 'flex';
      } else {
        // Fallback for others
        document.getElementById('activePanelContent').style.display = 'flex';
        document.querySelector('#activePanelContent .panel-title').textContent = panel.charAt(0).toUpperCase() + panel.slice(1);
      }
    });
  });

  // Timeline Buttons - Ekle
  document.getElementById('timelineAddBtn').addEventListener('click', () => {
    document.getElementById('addSceneBtn').click();
  });

  // Timeline Buttons - Sil
  document.getElementById('timelineDeleteBtn').addEventListener('click', () => {
    if (projectState.scenes.length > 1) {
      const deletedId = projectState.activeSceneId;
      const deletedIndex = projectState.scenes.findIndex(s => s.id === deletedId);
      projectState.scenes = projectState.scenes.filter(s => s.id !== deletedId);
      // Silinen sahnenin yanındaki sahneyi aktif yap
      const newIndex = Math.min(deletedIndex, projectState.scenes.length - 1);
      projectState.activeSceneId = projectState.scenes[newIndex].id;
      updateTotalDuration();
      renderScenes();
      renderTimeline();
    } else {
      alert("En az bir bölüm olmak zorunda.");
    }
  });

  // Timeline Buttons - Böl (Split)
  document.getElementById('timelineSplitBtn').addEventListener('click', () => {
    const activeScene = projectState.scenes.find(s => s.id === projectState.activeSceneId);
    if (!activeScene) return;

    if (activeScene.duration < 2) {
      alert("Bu bölüm çok kısa, bölünemez. (En az 2 saniye olmalı)");
      return;
    }

    const activeIndex = projectState.scenes.findIndex(s => s.id === projectState.activeSceneId);
    const halfDuration = normalizeSceneDuration(activeScene.duration / 2, activeScene.duration / 2);

    // Metni ikiye böl (kelime bazında)
    const words = activeScene.text.trim().split(/\s+/).filter(w => w.length > 0);
    const midWord = Math.ceil(words.length / 2);
    const firstHalfText = words.slice(0, midWord).join(' ');
    const secondHalfText = words.slice(midWord).join(' ');

    // Mevcut sahneyi güncelle (ilk yarı)
    activeScene.text = firstHalfText;
    activeScene.duration = halfDuration;

    // Yeni sahne oluştur (ikinci yarı)
    const newScene = {
      id: generateId(),
      text: secondHalfText,
      voice: activeScene.voice,
      media: activeScene.media ? { ...activeScene.media } : null,
      overlays: [],
      duration: halfDuration,
      autoSearched: activeScene.autoSearched
    };

    // Yeni sahneyi mevcut sahnenin hemen arkasına ekle
    projectState.scenes.splice(activeIndex + 1, 0, newScene);
    projectState.activeSceneId = newScene.id;

    updateTotalDuration();
    renderScenes();
    renderTimeline();
  });

  // Add Scene
  document.getElementById('addSceneBtn').addEventListener('click', () => {
    const newScene = {
      id: generateId(),
      text: "",
      voice: "aura-asteria-en",
      audioUrl: null,
      media: null,
      overlays: [],
      duration: normalizeSceneDuration(3.0, 3.0),
      autoSearched: false
    };
    projectState.scenes.push(newScene);
    projectState.activeSceneId = newScene.id;
    updateTotalDuration();
    renderScenes();
    renderTimeline();
  });

  // Play/Pause
  document.getElementById('playBtn').addEventListener('click', togglePlay);

  // Timeline Interactions (Playhead Seek/Drag & Resize)
  initTimelineInteractions();

  // Trigger properties panel on load
  if (projectState.scenes.length > 0) renderPropertiesPanel();

  // Media Tabs
  document.querySelectorAll('.media-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.media-tab').forEach(t => t.classList.remove('active'));
      e.currentTarget.classList.add('active');
      const searchInput = document.getElementById('mediaSearchInput');
      searchAllMedia(searchInput.value || "nature", true);
    });
  });

  // Subtitle Presets
  document.querySelectorAll('.preset-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.preset-item').forEach(b => b.classList.remove('active'));
      
      // Need to find the closest .preset-item because the user might click the inner preview element
      const target = e.target.closest('.preset-item');
      if(target) {
        target.classList.add('active');
        const preset = target.getAttribute('data-preset');
        projectState.subtitlePreset = preset;
        updatePreview();
      }
    });
  });

  // Manual Media Search
  const searchInput = document.getElementById('mediaSearchInput');
  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        searchAllMedia(e.target.value, true);
      }
    });
  }

  // Zoom Slider
  const zoomSlider = document.querySelector('.zoom-slider');
  if (zoomSlider) {
    timelineZoom = Number(zoomSlider.value) || 100;
    const zoomTextEl = document.querySelector('.control-text');
    if (zoomTextEl) {
      zoomTextEl.textContent = timelineZoom === 100 ? 'Uygun' : `${timelineZoom}%`;
    }

    zoomSlider.addEventListener('input', (e) => {
      const nextZoom = Number(e.target.value) || 100;
      timelineZoom = Math.max(50, Math.min(200, nextZoom));

      const controlText = document.querySelector('.control-text');
      if (controlText) {
        controlText.textContent = timelineZoom === 100 ? 'Uygun' : `${timelineZoom}%`;
      }

      renderTimeline();

      const timelineContainer = document.getElementById('timelineContainer');
      if (timelineContainer) {
        const targetX = projectState.currentTime * getPixelsPerSecond();
        timelineContainer.scrollLeft = Math.max(0, targetX - timelineContainer.clientWidth * 0.35);
      }
    });
  }

  // Change Aspect Ratio
  const aspectBtn = document.getElementById('changeAspectBtn');
  if (aspectBtn) {
    let aspects = ['16/9', '9/16', '1/1'];
    let currentAspect = 0;
    aspectBtn.addEventListener('click', () => {
      currentAspect = (currentAspect + 1) % aspects.length;
      document.getElementById('videoPreviewPlayer').style.aspectRatio = aspects[currentAspect];
      aspectBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect></svg> ${aspects[currentAspect]}`;
    });
  }

  // Text Presets (Add Overlay)
  document.querySelectorAll('.text-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const type = e.currentTarget.getAttribute('data-type');
      const activeScene = projectState.scenes.find(s => s.id === projectState.activeSceneId);
      if (!activeScene) return;
      
      if (!activeScene.overlays) activeScene.overlays = [];
      
      let newOverlay = {
        id: generateId(),
        type: type,
        text: '',
        x: 50,
        y: 50,
        fontSize: 32,
        fontWeight: 'bold',
        color: '#ffffff',
        bgColor: 'transparent',
        fontFamily: 'Arial'
      };
      
      if (type === 'title') {
         newOverlay.text = 'Başlık metni';
         newOverlay.fontSize = 48;
         newOverlay.fontWeight = '800';
      } else if (type === 'subtitle') {
         newOverlay.text = 'Altyazı metni';
         newOverlay.fontSize = 32;
         newOverlay.fontWeight = '600';
         newOverlay.y = 80;
      } else {
         newOverlay.text = 'Metin';
         newOverlay.fontSize = 24;
         newOverlay.fontWeight = '400';
      }
      
      activeScene.overlays.push(newOverlay);
      updatePreview();
      renderPropertiesPanel();
    });
  });

  // Properties Panel Toggle (Dolar butonu)
  const togglePropsBtn = document.getElementById('togglePropsBtn');
  if (togglePropsBtn) {
    togglePropsBtn.addEventListener('click', () => {
      const panel = document.getElementById('propertiesPanel');
      if (panel) {
        if (panel.style.display === 'none') {
          panel.style.display = 'block';
        } else {
          panel.style.display = 'none';
        }
      }
    });
  }

  // Search Scenes (Arama butonu)
  const searchScenesBtn = document.getElementById('searchScenesBtn');
  if (searchScenesBtn) {
    searchScenesBtn.addEventListener('click', () => {
      const query = prompt("Senaryolarda aramak için metin girin:");
      if (query && query.trim()) {
        filterScenes(query.trim());
      }
    });
  }

  // Müzik Panel Logic
  const YOUTUBE_MUSIC_LIBRARY = [
    { id: 'm1', title: 'The Four Seasons - Spring', artist: 'Antonio Vivaldi', genre: 'Classical', url: 'https://upload.wikimedia.org/wikipedia/commons/f/ff/Vivaldi_-_Four_Seasons_1_Spring_mvt_1_Allegro_-_John_Harrison_violin.oga' },
    { id: 'm2', title: 'Symphony No. 40 in G minor', artist: 'Wolfgang Amadeus Mozart', genre: 'Classical', url: 'https://upload.wikimedia.org/wikipedia/commons/9/99/Wolfgang_Amadeus_Mozart_-_Symphony_40_g-moll_-_1._Molto_allegro.ogg' },
    { id: 'm3', title: 'Moonlight Sonata - 1st Mvt', artist: 'Ludwig van Beethoven', genre: 'Piano', url: 'https://upload.wikimedia.org/wikipedia/commons/e/eb/Beethoven_Moonlight_1st_movement.ogg' },
    { id: 'm4', title: 'The Planets - Jupiter', artist: 'Gustav Holst', genre: 'Orchestral', url: 'https://upload.wikimedia.org/wikipedia/commons/e/e2/Holst_The_Planets_Jupiter.ogg' },
    { id: 'm5', title: 'Dance of the Sugar Plum Fairy', artist: 'Pyotr Ilyich Tchaikovsky', genre: 'Ballet', url: 'https://upload.wikimedia.org/wikipedia/commons/9/9d/Tchaikovsky_-_Dance_of_the_Sugar_Plum_Fairy_-_The_Nutcracker.ogg' }
  ];

  function renderMusicList(query = '') {
    const container = document.getElementById('musicListContainer');
    if (!container) return;
    container.innerHTML = '';
    
    const filtered = YOUTUBE_MUSIC_LIBRARY.filter(m => 
      m.title.toLowerCase().includes(query.toLowerCase()) || 
      m.genre.toLowerCase().includes(query.toLowerCase())
    );

    filtered.forEach(music => {
      const el = document.createElement('div');
      el.style.cssText = 'padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between; background: var(--bg-page);';
      el.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:4px;">
          <h4 style="margin:0; font-size:14px; font-weight:600;">${music.title}</h4>
          <span style="font-size:11px; color:var(--text-muted);">${music.artist} • ${music.genre}</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-icon mini play-preview-music" data-url="${music.url}" title="Dinle">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </button>
          <button class="btn-secondary mini select-music-btn" data-id="${music.id}" title="Videoya Ekle">Ekle</button>
        </div>
      `;
      container.appendChild(el);
    });

    // Add event listeners for preview
    container.querySelectorAll('.play-preview-music').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.currentTarget.getAttribute('data-url');
        let audio = window.previewMusicAudio;
        if (!audio) {
           audio = new Audio();
           window.previewMusicAudio = audio;
        }
        if (audio.src === url && !audio.paused) {
           audio.pause();
           e.currentTarget.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
        } else {
           audio.src = url;
           audio.play();
           // Reset all icons
           container.querySelectorAll('.play-preview-music').forEach(b => b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`);
           e.currentTarget.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
        }
      });
    });

    // Add event listeners for selecting
    container.querySelectorAll('.select-music-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const music = YOUTUBE_MUSIC_LIBRARY.find(m => m.id === id);
        if (music) {
          projectState.backgroundMusic = music;
          updateActiveMusicUI();
          renderTimeline(); // to show the track
          
          // Stop preview if playing
          if (window.previewMusicAudio) {
            window.previewMusicAudio.pause();
            container.querySelectorAll('.play-preview-music').forEach(b => b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`);
          }
        }
      });
    });
  }

  function updateActiveMusicUI() {
    const container = document.getElementById('activeMusicContainer');
    const titleEl = document.getElementById('activeMusicTitle');
    if (!container || !titleEl) return;
    
    if (projectState.backgroundMusic) {
       titleEl.textContent = projectState.backgroundMusic.title;
       container.style.display = 'flex';
       
       // Setup main audio player
       let bgPlayer = document.getElementById('bgMusicPlayer');
       if (!bgPlayer) {
          bgPlayer = document.createElement('audio');
          bgPlayer.id = 'bgMusicPlayer';
          bgPlayer.loop = true;
          bgPlayer.volume = 0.3; // Default background volume
          document.body.appendChild(bgPlayer);
       }
       bgPlayer.src = projectState.backgroundMusic.url;
    } else {
       container.style.display = 'none';
       let bgPlayer = document.getElementById('bgMusicPlayer');
       if (bgPlayer) {
          bgPlayer.pause();
          bgPlayer.src = '';
       }
    }
  }

  const removeMusicBtn = document.getElementById('removeMusicBtn');
  if (removeMusicBtn) {
    removeMusicBtn.addEventListener('click', () => {
       projectState.backgroundMusic = null;
       updateActiveMusicUI();
       renderTimeline();
    });
  }

  const musicSearchInput = document.getElementById('musicSearchInput');
  if (musicSearchInput) {
    musicSearchInput.addEventListener('input', (e) => {
       renderMusicList(e.target.value);
    });
  }

  // Initial render of music list
  if (document.getElementById('musicListContainer')) {
    renderMusicList();
    updateActiveMusicUI();
  }

  // Logo Panel Logic
  const logoUploadInput = document.getElementById('logoUploadInput');
  const logoPreviewContainer = document.getElementById('logoPreviewContainer');
  const logoPreviewImg = document.getElementById('logoPreviewImg');
  const removeLogoBtn = document.getElementById('removeLogoBtn');
  const logoPositionSelect = document.getElementById('logoPositionSelect');
  const logoSizeSlider = document.getElementById('logoSizeSlider');
  const logoSizeVal = document.getElementById('logoSizeVal');
  const logoMarginSlider = document.getElementById('logoMarginSlider');
  const logoMarginVal = document.getElementById('logoMarginVal');

  if (logoUploadInput) {
    logoUploadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        projectState.logo.url = ev.target.result;
        logoPreviewImg.src = projectState.logo.url;
        logoPreviewContainer.style.display = 'block';
        updatePreview();
      };
      reader.readAsDataURL(file);
    });
  }

  if (removeLogoBtn) {
    removeLogoBtn.addEventListener('click', () => {
      projectState.logo.url = null;
      logoPreviewContainer.style.display = 'none';
      if(logoUploadInput) logoUploadInput.value = "";
      updatePreview();
    });
  }

  if (logoPositionSelect) {
    logoPositionSelect.addEventListener('change', (e) => {
      projectState.logo.position = e.target.value;
      updatePreview();
    });
  }

  if (logoSizeSlider) {
    logoSizeSlider.addEventListener('input', (e) => {
      projectState.logo.size = parseInt(e.target.value);
      if (logoSizeVal) logoSizeVal.textContent = projectState.logo.size + '%';
      updatePreview();
    });
  }

  if (logoMarginSlider) {
    logoMarginSlider.addEventListener('input', (e) => {
      projectState.logo.margin = parseInt(e.target.value);
      if (logoMarginVal) logoMarginVal.textContent = projectState.logo.margin + '%';
      updatePreview();
    });
  }
}

function filterScenes(query) {
  const container = document.getElementById('scenesList');
  const sceneItems = container.querySelectorAll('.scene-item');
  const lowerQuery = query.toLowerCase();
  
  let found = false;
  sceneItems.forEach((item, index) => {
    const scene = projectState.scenes[index];
    if (scene && scene.text.toLowerCase().includes(lowerQuery)) {
      item.style.display = 'block';
      found = true;
    } else {
      item.style.display = 'none';
    }
  });
  
  if (!found) {
    alert('Hiçbir senaryo bulunamadı.');
    renderScenes();
  }
}

// -- Scene Management --
function renderScenes() {
  const container = document.getElementById('scenesList');
  container.innerHTML = '';

  projectState.scenes.forEach((scene, index) => {
    const isActive = scene.id === projectState.activeSceneId;
    
    const sceneEl = document.createElement('div');
    sceneEl.className = `scene-item ${isActive ? 'is-active' : ''}`;
    sceneEl.onclick = (e) => {
      // Prevent clicking textarea from instantly re-triggering if already active
      if (!isActive) {
        seekToTime(getSceneStartTime(scene.id), { pausePlayback: true, forceRender: true });
      }
      renderPropertiesPanel();
    };

    let mediaThumbHtml = '';
    if (scene.media) {
       mediaThumbHtml = `<img src="${scene.media.thumbnail}" style="width: 40px; height: 24px; object-fit: cover; border-radius: 2px; margin-left: auto;" />`;
    }

    sceneEl.innerHTML = `
      <div class="scene-header">
        <div class="scene-title-group">
          <span>Bölüm ${index + 1}</span>
          <div class="scene-voice" onclick="openVoiceSelector('${scene.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
            <span id="voice-label-${scene.id}">${scene.voice}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:4px;"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </div>
        </div>
        ${mediaThumbHtml}
      </div>
      <div class="scene-body">
        <textarea class="scene-textarea" placeholder="Bu bölüm için senaryonuzu yazın..." data-id="${scene.id}">${scene.text}</textarea>
        <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
           <button class="btn-secondary mini" onclick="generateTTS('${scene.id}')" title="Sesi Oluştur" style="font-size: 11px; padding: 4px 8px; border-radius: 4px;">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
             Seslendir
           </button>
        </div>
         <audio id="audio-${scene.id}" style="display:none;" ${scene.audioUrl ? 'src="' + scene.audioUrl + '"' : ''} preload="metadata"></audio>
      </div>
    `;

    container.appendChild(sceneEl);

    // Bind textarea
    const textarea = sceneEl.querySelector('.scene-textarea');
    textarea.addEventListener('input', handleTextChange);
  });

  updatePreview();
}

const handleTextChange = debounce((e) => {
  const sceneId = e.target.getAttribute('data-id');
  const scene = projectState.scenes.find(s => s.id === sceneId);
  if (scene) {
    const oldText = scene.text;
    scene.text = e.target.value;
    
    // Estimate duration based on word count (roughly 2.5 words per second)
    const wordCount = scene.text.trim().split(/\s+/).filter(w => w.length > 0).length;
    scene.duration = normalizeSceneDuration(wordCount / 2.5, 3.0);
    
    updateTotalDuration();
    renderTimeline();
    
    // Auto-search logic: if text changed significantly and no media or not auto-searched yet
    if (scene.text.length > 10 && (!scene.media || !scene.autoSearched)) {
      autoSearchMediaForScene(scene);
    }
  }
}, 1000); // 1 second debounce

// -- Voice & TTS Management --
const TTS_VOICES = [
  { id: "aura-asteria-en", label: "Asteria", gender: "Female" },
  { id: "aura-luna-en", label: "Luna", gender: "Female" },
  { id: "aura-stella-en", label: "Stella", gender: "Female" },
  { id: "aura-hera-en", label: "Hera", gender: "Female" },
  { id: "aura-orion-en", label: "Orion", gender: "Male" },
  { id: "aura-arcas-en", label: "Arcas", gender: "Male" },
  { id: "aura-perseus-en", label: "Perseus", gender: "Male" },
  { id: "aura-angus-en", label: "Angus", gender: "Male" },
  { id: "aura-orpheus-en", label: "Orpheus", gender: "Male" },
  { id: "aura-helios-en", label: "Helios", gender: "Male" },
  { id: "aura-zeus-en", label: "Zeus", gender: "Male" }
];

function openVoiceSelector(sceneId) {
  // Check if voice selector modal exists, if not create it
  let modal = document.getElementById('voiceSelectorModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'voiceSelectorModal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.background = 'rgba(0,0,0,0.5)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.zIndex = '9999';
    
    let optionsHtml = '';
    TTS_VOICES.forEach(voice => {
      optionsHtml += `
        <div class="voice-option" onclick="selectVoice('${voice.id}')" style="padding: 12px; border-bottom: 1px solid var(--border); cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 600; color: var(--text);">${voice.label}</span>
          <span style="font-size: 11px; padding: 2px 6px; background: var(--bg-page); border-radius: 4px; color: var(--text-muted);">${voice.gender}</span>
        </div>
      `;
    });
    
    // Add "Apply to All" option
    optionsHtml += `
      <div style="padding: 12px; background: var(--bg-page); display: flex; align-items: center; gap: 8px; border-top: 2px solid var(--border);">
        <input type="checkbox" id="applyVoiceToAllScenes" style="cursor: pointer;">
        <label for="applyVoiceToAllScenes" style="font-size: 12px; cursor: pointer; color: var(--text); font-weight: 500;">Seçtiğim sesi tüm bölümlere uygula</label>
      </div>
    `;

    modal.innerHTML = `
      <div style="background: var(--bg); width: 400px; border-radius: var(--radius); box-shadow: var(--shadow-md); overflow: hidden;">
        <div style="padding: 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
          <h3 style="margin: 0; font-size: 16px;">Ses Seçimi</h3>
          <button onclick="document.getElementById('voiceSelectorModal').style.display='none'" class="btn-icon mini"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
        </div>
        <div style="max-height: 300px; overflow-y: auto;">
          ${optionsHtml}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  
  // Store the target scene ID globally so we know which one to update
  window.currentVoiceSceneId = sceneId;
  modal.style.display = 'flex';
}

window.selectVoice = function(voiceId) {
  const scene = projectState.scenes.find(s => s.id === window.currentVoiceSceneId);
  if (scene) {
    scene.voice = voiceId;
    // Update the label in the UI
    const label = document.getElementById(`voice-label-${scene.id}`);
    if (label) label.textContent = voiceId;
    
    // Update right panel if it's open
    renderPropertiesPanel();
  }
  document.getElementById('voiceSelectorModal').style.display = 'none';
};

window.generateAllTTS = async () => {
  const btn = document.getElementById('generateAllTtsBtn');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin" style="margin-right:4px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Seslendiriliyor...`;
  btn.disabled = true;

  let successCount = 0;
  for (let i = 0; i < projectState.scenes.length; i++) {
    const scene = projectState.scenes[i];
    if (scene.text && scene.text.trim().length > 0) {
      try {
        await generateTTS(scene.id, true);
        successCount++;
      } catch (err) {
        console.error("Batch TTS Error for scene " + scene.id, err);
      }
    }
  }

  btn.innerHTML = originalHtml;
  btn.disabled = false;
  alert(`Toplam ${successCount} bölüm başarıyla seslendirildi.`);
};

async function generateTTS(sceneId, isBatch = false) {
  const scene = projectState.scenes.find(s => s.id === sceneId);
  if (!scene || !scene.text.trim()) {
    if(!isBatch) alert("Önce bu bölüm için bir metin yazmalısınız.");
    return;
  }
  
  const btn = document.querySelector(`.scene-item [onclick="generateTTS('${sceneId}')"]`);
  if (!btn) {
    console.error("Button not found for TTS");
    return;
  }
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
  
  try {
    if (!supabaseClient) {
      alert("Supabase bağlantısı kurulamadı. Lütfen sayfayı yenileyin.");
      throw new Error("Supabase is not initialized.");
    }
    
    console.log("Calling TTS function with text:", scene.text.substring(0, 50) + "...");
    
    const { data, error } = await supabaseClient.functions.invoke('deepgram-tts', {
      body: { text: scene.text, voice_id: scene.voice }
    });
    
    console.log("TTS Response:", data, error);
    
    if (error) { console.error("Supabase Invoke Error Full:", error); throw new Error(error.message || "Bilinmeyen API Hatası"); }
    if (data && data.error) { console.error("API Returned Error:", data.error); throw new Error(data.error); }
    
    if (data && data.audio) {
      const audioUrl = "data:audio/mp3;base64," + data.audio;
      
      const audioEl = document.getElementById(`audio-${scene.id}`);
      if (!audioEl) {
        throw new Error("Audio element not found");
      }
      audioEl.src = audioUrl;
      scene.audioUrl = audioUrl; // Save to state so it doesn't get lost on render!
      
      // Load and update duration
      audioEl.onloadedmetadata = () => {
        scene.duration = normalizeSceneDuration(audioEl.duration, scene.duration);
        updateTotalDuration();
        renderTimeline();
      };
      
      // Auto-play the generated sound
      audioEl.play();
      if(!isBatch) alert("Ses başarıyla oluşturuldu!");
    } else {
      throw new Error("Ses verisi alınamadı. Lütfen tekrar deneyin.");
    }
  } catch (err) {
    console.error("TTS Error:", err);
    alert("Ses oluşturulamadı: " + err.message);
  } finally {
    btn.innerHTML = originalHtml;
  }
}

// -- API Search & Auto-Assign --
async function autoSearchMediaForScene(scene) {
  const words = scene.text.replace(/[^\w\s\ğ\ü\ş\ı\ö\ç\Ğ\Ü\Ş\İ\Ö\Ç]/gi, '').split(/\s+/);
  const meaningfulWords = words.filter(w => w.length > 4);
  
  let query = meaningfulWords.slice(0, 2).join(" ");
  if (!query) query = words.slice(0, 2).join(" ");
  if (!query) query = "nature"; // fallback

  console.log(`Auto-searching Pexels & Pixabay for scene ${scene.id} with query: "${query}"`);
  
  try {
    const results = await fetchAllMedia(query, 3, 'all');
    
    if (results && results.length > 0) {
      // Pick the first result from our combined pool
      scene.media = results[0];
      scene.autoSearched = true;
      console.log("Auto-assigned media:", scene.media);
      
      renderScenes(); // Refresh thumbnail in sidebar
      renderTimeline(); // Refresh timeline visuals
      updatePreview(); // Show in player if active
    }
  } catch (err) {
    console.error("Auto-search error:", err);
  }
}

async function searchAllMedia(query, showInPanel = false) {
  try {
    const activeTab = document.querySelector('.media-tab.active');
    const mediaType = activeTab ? activeTab.getAttribute('data-type') : 'all';
    const combinedResults = await fetchAllMedia(query, 10, mediaType);
    
    if (showInPanel) {
      const grid = document.getElementById('mediaGrid');
      grid.innerHTML = '';
      
      combinedResults.forEach(media => {
        const el = document.createElement('div');
        el.className = 'media-item';
        el.innerHTML = `
          <img src="${media.thumbnail}" alt="Stock Video">
          <div class="media-item-duration">${media.duration}s <span style="font-size:8px; opacity:0.8;">(${media.source})</span></div>
        `;
        el.onclick = () => {
          // Assign to active scene
          const activeScene = projectState.scenes.find(s => s.id === projectState.activeSceneId);
          if (activeScene) {
            activeScene.media = media;
            activeScene.autoSearched = true;
            renderScenes();
            renderTimeline();
            updatePreview();
          }
        };
        grid.appendChild(el);
      });
    }
    return combinedResults;
  } catch (e) {
    console.error("Combined Search Error:", e);
  }
}

async function fetchAllMedia(query, limitPerSource = 5, mediaType = 'all') {
  let results = [];
  let promises = [];

  const fetchVideos = mediaType === 'all' || mediaType === 'video';
  const fetchImages = mediaType === 'all' || mediaType === 'image';
  
  // Pixabay requires minimum per_page of 3
  const pixabayLimit = Math.max(3, limitPerSource);

  // 1. Fetch Pexels Videos
  if (fetchVideos) {
    promises.push(fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${limitPerSource}&orientation=landscape`, {
      headers: { 'Authorization': PEXELS_API_KEY }
    })
    .then(res => res.json())
    .then(data => {
      if (data.videos) {
        return data.videos.map(v => {
          const hdFile = v.video_files.find(f => f.quality === 'hd') || v.video_files[0];
          return {
            type: 'video',
            url: hdFile.link,
            thumbnail: v.image,
            duration: v.duration,
            source: 'Pexels'
          };
        });
      }
      return [];
    })
    .catch(err => {
      console.error("Pexels error:", err);
      return [];
    }));
  }

  // 2. Fetch Pexels Images
  if (fetchImages) {
    promises.push(fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${limitPerSource}&orientation=landscape`, {
      headers: { 'Authorization': PEXELS_API_KEY }
    })
    .then(res => res.json())
    .then(data => {
      if (data.photos) {
        return data.photos.map(p => {
          return {
            type: 'image',
            url: p.src.original,
            thumbnail: p.src.medium,
            duration: 5, // Default duration for image
            source: 'Pexels Image'
          };
        });
      }
      return [];
    })
    .catch(err => {
      console.error("Pexels Image error:", err);
      return [];
    }));
  }

  // 3. Fetch Pixabay Videos
  if (fetchVideos) {
    promises.push(fetch(`https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&per_page=${pixabayLimit}&video_type=film`)
    .then(res => res.json())
    .then(data => {
      if (data.hits) {
        return data.hits.map(v => {
          const vidUrl = v.videos.medium ? v.videos.medium.url : v.videos.tiny.url;
          const thumb = v.videos.medium ? v.videos.medium.thumbnail : v.videos.tiny.thumbnail;
          return {
            type: 'video',
            url: vidUrl,
            thumbnail: thumb,
            duration: v.duration,
            source: 'Pixabay'
          };
        });
      }
      return [];
    })
    .catch(err => {
      console.error("Pixabay error:", err);
      return [];
    }));
  }

  // 4. Fetch Pixabay Images
  if (fetchImages) {
    promises.push(fetch(`https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&image_type=photo&per_page=${pixabayLimit}&orientation=horizontal`)
    .then(res => res.json())
    .then(data => {
      if (data.hits) {
        return data.hits.map(p => {
          return {
            type: 'image',
            url: p.largeImageURL,
            thumbnail: p.webformatURL,
            duration: 5,
            source: 'Pixabay Image'
          };
        });
      }
      return [];
    })
    .catch(err => {
      console.error("Pixabay Image error:", err);
      return [];
    }));
  }

  // Wait for all
  const allResultsArrays = await Promise.all(promises);
  
  // Interleave the results so we get a mix of platforms and types
  const maxLength = Math.max(...allResultsArrays.map(arr => arr.length));
  for (let i = 0; i < maxLength; i++) {
    for (let j = 0; j < allResultsArrays.length; j++) {
      if (allResultsArrays[j][i]) results.push(allResultsArrays[j][i]);
    }
  }
  
  return results;
}

// -- Right Panel (Properties) --
function renderPropertiesPanel() {
  const panel = document.getElementById('propertiesPanel');
  const activeScene = projectState.scenes.find(s => s.id === projectState.activeSceneId);

  if (!activeScene) {
    panel.innerHTML = `<div class="properties-empty"><p>Buradan bir varlık veya bölümü seçerek özelliklerini düzenleyin.</p></div>`;
    return;
  }

  const idx = projectState.scenes.indexOf(activeScene) + 1;
  const wordCount = activeScene.text.trim().split(/\s+/).filter(w => w.length > 0).length;
  
  panel.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid var(--border);">
      <h3 style="font-size:15px; margin:0; font-weight:700;">Bölüm ${idx} Özellikleri</h3>
    </div>
    <div style="padding: 20px; display:flex; flex-direction:column; gap:20px; font-size:13px;">
      <div>
        <label style="color:var(--text-muted); font-weight:600; display:block; margin-bottom:8px;">Süre (Saniye)</label>
        <input type="number" value="${activeScene.duration.toFixed(1)}" step="0.5" min="1" onchange="updateSceneDuration(this.value.replace(',', '.'), '${activeScene.id}')" style="width:100%; padding:10px 12px; border-radius:6px; border:1px solid var(--border); background:var(--bg-page); color:var(--text); font-weight:500;">
      </div>
      <div>
        <label style="color:var(--text-muted); font-weight:600; display:block; margin-bottom:8px;">Kelime Sayısı</label>
        <div style="color:var(--text); font-weight:500;">${wordCount} kelime</div>
      </div>
      <div>
        <label style="color:var(--text-muted); font-weight:600; display:block; margin-bottom:8px;">Arka Plan Medya</label>
        <div style="display:flex; align-items:center; gap:8px;">
           ${activeScene.media ? `<img src="${activeScene.media.thumbnail}" style="width:60px; height:34px; object-fit:cover; border-radius:4px;"> <span style="font-size:11px; color:var(--text-muted);">${activeScene.media.source}</span>` : `<span style="color:#ef5350; font-weight:500;">Yok</span>`}
        </div>
        ${activeScene.media ? `<button class="btn-secondary mini" style="margin-top:8px; width:100%;" onclick="clearSceneMedia('${activeScene.id}')">Kaldır</button>` : ''}
      </div>
      <div>
        <label style="color:var(--text-muted); font-weight:600; display:block; margin-bottom:8px;">Seçili Ses</label>
        <div style="padding:10px 12px; border:1px solid var(--border); border-radius:6px; background:var(--bg-page); color:var(--text); font-weight:500; cursor:pointer;" onclick="openVoiceSelector('${activeScene.id}')">
          ${activeScene.voice}
        </div>
      </div>
      ${activeScene.overlays && activeScene.overlays.length > 0 ? `
      <div style="border-top: 1px solid var(--border); padding-top: 20px;">
        <label style="color:var(--text-muted); font-weight:600; display:block; margin-bottom:8px;">Metin Katmanları</label>
        ${activeScene.overlays.map((ov, i) => `
          <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-page); border: 1px solid var(--border); border-radius: 6px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px; align-items:center;">
              <span style="font-weight:600; font-size:12px;">Katman ${i+1}</span>
              <button class="btn-icon mini" onclick="removeOverlay('${ov.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef5350" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </div>
            <input type="text" id="overlay-input-${ov.id}" value="${ov.text.replace(/"/g, '&quot;')}" oninput="updateOverlayText('${ov.id}', this.value)" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:13px; margin-bottom: 8px;" />
            
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
               <div style="flex: 1;">
                 <label style="font-size: 11px; color: var(--text-muted); display:block; margin-bottom:4px;">Yazı Rengi</label>
                 <input type="color" value="${ov.color || '#ffffff'}" onchange="updateOverlayProp('${ov.id}', 'color', this.value)" style="width:100%; height:28px; border:none; border-radius:4px; cursor:pointer;" />
               </div>
               <div style="flex: 1;">
                 <label style="font-size: 11px; color: var(--text-muted); display:block; margin-bottom:4px;">Arka Plan</label>
                 <select onchange="updateOverlayProp('${ov.id}', 'bgColor', this.value)" style="width:100%; height:28px; padding:0 4px; border-radius:4px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:12px;">
                   <option value="transparent" ${ov.bgColor === 'transparent' ? 'selected' : ''}>Yok</option>
                   <option value="rgba(0,0,0,0.7)" ${ov.bgColor === 'rgba(0,0,0,0.7)' ? 'selected' : ''}>Siyah Yarı-Saydam</option>
                   <option value="rgba(255,255,255,0.7)" ${ov.bgColor === 'rgba(255,255,255,0.7)' ? 'selected' : ''}>Beyaz Yarı-Saydam</option>
                   <option value="#000000" ${ov.bgColor === '#000000' ? 'selected' : ''}>Siyah</option>
                   <option value="#ffffff" ${ov.bgColor === '#ffffff' ? 'selected' : ''}>Beyaz</option>
                   <option value="#ef5350" ${ov.bgColor === '#ef5350' ? 'selected' : ''}>Kırmızı</option>
                   <option value="#3b82f6" ${ov.bgColor === '#3b82f6' ? 'selected' : ''}>Mavi</option>
                 </select>
               </div>
            </div>
            
            <div style="display: flex; gap: 8px;">
               <div style="flex: 1;">
                 <label style="font-size: 11px; color: var(--text-muted); display:block; margin-bottom:4px;">Yazı Tipi (Font)</label>
                 <select onchange="updateOverlayProp('${ov.id}', 'fontFamily', this.value)" style="width:100%; height:28px; padding:0 4px; border-radius:4px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:12px;">
                   <option value="Arial" ${ov.fontFamily === 'Arial' ? 'selected' : ''}>Arial</option>
                   <option value="Georgia" ${ov.fontFamily === 'Georgia' ? 'selected' : ''}>Georgia</option>
                   <option value="Courier New" ${ov.fontFamily === 'Courier New' ? 'selected' : ''}>Courier New</option>
                   <option value="Impact" ${ov.fontFamily === 'Impact' ? 'selected' : ''}>Impact</option>
                 </select>
               </div>
            </div>
          </div>
        `).join('')}
      </div>` : ''}
    </div>
  `;
}

window.removeOverlay = (id) => {
  const scene = projectState.scenes.find(s => s.id === projectState.activeSceneId);
  if (scene && scene.overlays) {
    scene.overlays = scene.overlays.filter(o => o.id !== id);
    updatePreview();
    renderPropertiesPanel();
  }
};

window.updateOverlayText = (id, newText) => {
  const scene = projectState.scenes.find(s => s.id === projectState.activeSceneId);
  if (scene && scene.overlays) {
    const overlay = scene.overlays.find(o => o.id === id);
    if (overlay) {
      overlay.text = newText;
      updatePreview();
    }
  }
};

window.updateOverlayProp = (id, prop, value) => {
  const scene = projectState.scenes.find(s => s.id === projectState.activeSceneId);
  if (scene && scene.overlays) {
    const overlay = scene.overlays.find(o => o.id === id);
    if (overlay) {
      overlay[prop] = value;
      updatePreview();
    }
  }
};

window.updateSceneDuration = (val, id) => {
  const scene = projectState.scenes.find(s => s.id === id);
  if (scene) {
    scene.duration = normalizeSceneDuration(val, scene.duration);
    updateTotalDuration();
    renderTimeline();
    seekToTime(projectState.currentTime, { syncMedia: true, keepPlaying: projectState.isPlaying });
  }
};

window.clearSceneMedia = (id) => {
  const scene = projectState.scenes.find(s => s.id === id);
  if (scene) {
    scene.media = null;
    scene.autoSearched = false;
    renderScenes();
    renderTimeline();
    updatePreview();
    renderPropertiesPanel();
  }
};

// -- FFmpeg.wasm Export System --
async function performVideoExport(resolution) {
  const { FFmpeg } = window.FFmpegWASM;
  const { fetchFile, toBlobURL } = window.FFmpegUtil;
  
  const ffmpeg = new FFmpeg();
  window.activeFFmpeg = ffmpeg;

  const statusEl = document.getElementById('exportStatusText');
  const progressEl = document.getElementById('exportProgressBar');
  const ffmpegLogs = []; // Capture all FFmpeg logs

  // Check if we have media to export. We MUST filter out scenes without media from the entire export logic,
  // AND recalculate the total export duration based ONLY on the scenes we are actually exporting.

  const scenesWithMedia = projectState.scenes.filter(s => s.media && s.duration > 0);
  if (scenesWithMedia.length === 0) {
    alert("Dışa aktarılacak hiçbir medya (video) bulunamadı. Lütfen önce videoya sahne ekleyin.");
    document.getElementById('exportModal').remove();
    return;
  }
  
  // Validate durations
  for (const scene of scenesWithMedia) {
    if (!scene.duration || scene.duration <= 0 || isNaN(scene.duration)) {
      alert(`Sahne süresi geçersiz: ${scene.duration}. Lütfen sahne sürelerini kontrol edin.`);
      document.getElementById('exportModal').remove();
      return;
    }
  }
  
  // CRITICAL FIX: The export duration must exactly match the sum of scenes we are actually exporting
  const exportDuration = scenesWithMedia.reduce((acc, s) => acc + s.duration, 0);
  
  console.log("[Export] Starting export with", scenesWithMedia.length, "scenes, total duration:", exportDuration);


  // --- TOKEN CHECK ---
  let userId = null;
  let currentTokens = 0;
  const TOKEN_COST = 5;

  if (supabaseClient) {
    statusEl.textContent = "Kullanıcı bilgileri kontrol ediliyor...";
    const { data: { session } } = await supabaseClient.auth.getSession();
    
    if (!session) {
      alert("Video oluşturmak için lütfen sisteme giriş yapın.");
      document.getElementById('exportModal').remove();
      return;
    }
    
    userId = session.user.id;
    const { data: profile, error: profileErr } = await supabaseClient
      .from('profiles')
      .select('token_balance')
      .eq('id', userId)
      .single();
      
    if (profileErr || !profile) {
      alert("Kullanıcı token bilgileri alınamadı.");
      document.getElementById('exportModal').remove();
      return;
    }
    
    currentTokens = profile.token_balance || 0;
    if (currentTokens < TOKEN_COST) {
      alert(`Yetersiz token! Video oluşturmak için en az ${TOKEN_COST} token gereklidir. (Mevcut: ${currentTokens})`);
      document.getElementById('exportModal').remove();
      return;
    }
  } else {
    console.warn("Supabase client bulunamadı, token kontrolü atlanıyor.");
  }
  // -------------------

  ffmpeg.on('log', ({ message }) => {
    console.log('[FFmpeg]', message);
    ffmpegLogs.push(message); // Store logs
    // Add error details
    if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
      statusEl.textContent = "FFmpeg Hatası: " + message.substring(0, 100);
    }
  });
  
  ffmpeg.on('progress', ({ progress }) => {
    // progress goes from 0 to 1
    const p = Math.round(progress * 100);
    progressEl.style.width = `${p}%`;
    statusEl.textContent = `%${p} tamamlandı...`;
  });

  try {
    statusEl.textContent = "FFmpeg Çekirdeği Yükleniyor...";
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
    const ffmpegURL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      classWorkerURL: await toBlobURL(`${ffmpegURL}/814.ffmpeg.js`, 'text/javascript')
    });

    statusEl.textContent = "Fontlar yükleniyor...";
    let hasFont = false;
    let fontMap = {}; // { 'Arial_normal': 'font_Arial_normal.ttf' }

    try {
      // Default font for subtitles
      const defaultFontData = await fetchFile('https://raw.githubusercontent.com/googlefonts/roboto/main/src/hinted/Roboto-Bold.ttf');
      await ffmpeg.writeFile('font.ttf', defaultFontData);
      hasFont = true;

      // Extract unique fonts used in overlays
      const uniqueFonts = new Set();
      scenesWithMedia.forEach(scene => {
        if (scene.overlays && scene.overlays.length > 0) {
          scene.overlays.forEach(ov => {
             const family = ov.fontFamily || 'Arial';
             const weight = ov.fontWeight || 'normal';
             uniqueFonts.add(`${family}_${weight}`);
          });
        }
      });

      // Helper to map UI fonts to actual TTF URLs (Using Google Fonts where possible)
      const getFontUrl = (family, weight) => {
        let isBold = weight === 'bold' || weight === '600' || weight === '700' || weight === '800';
        let baseUrl = 'https://raw.githubusercontent.com/googlefonts/';
        
        switch(family) {
          case 'Georgia':
            return isBold ? `${baseUrl}noto-fonts/main/hinted/ttf/NotoSerif/NotoSerif-Bold.ttf` : `${baseUrl}noto-fonts/main/hinted/ttf/NotoSerif/NotoSerif-Regular.ttf`;
          case 'Courier New':
            return isBold ? `${baseUrl}roboto/main/src/hinted/RobotoMono-Bold.ttf` : `${baseUrl}roboto/main/src/hinted/RobotoMono-Regular.ttf`;
          case 'Impact':
            return `${baseUrl}roboto/main/src/hinted/Roboto-Black.ttf`; // Impact alternative
          case 'Arial':
          default:
            return isBold ? `${baseUrl}roboto/main/src/hinted/Roboto-Bold.ttf` : `${baseUrl}roboto/main/src/hinted/Roboto-Regular.ttf`;
        }
      };

      for (const fontKey of uniqueFonts) {
         const [family, weight] = fontKey.split('_');
         const url = getFontUrl(family, weight);
         const fileName = `font_${family.replace(/\s+/g, '')}_${weight}.ttf`;
         try {
           const fData = await fetchFile(url);
           await ffmpeg.writeFile(fileName, fData);
           fontMap[fontKey] = fileName;
           console.log(`[Export] Loaded font ${fontKey} -> ${fileName}`);
         } catch(e) {
           console.warn(`[Export] Failed to load font ${fontKey}`, e);
           fontMap[fontKey] = 'font.ttf'; // Fallback
         }
      }

    } catch(e) {
      console.warn("Font fetch failed, text overlays might not be exported correctly.", e);
    }

    // 1. Download and Write Files to FFmpeg FS
    let concatFilter = '';
    let inputs = [];
    
    // Pass 1: Add Video Inputs
    for (let i = 0; i < scenesWithMedia.length; i++) {
      const scene = scenesWithMedia[i];
      statusEl.textContent = `Medya indiriliyor (${i + 1}/${scenesWithMedia.length})...`;
      
      const isImage = scene.media.type === 'image';
      const extension = isImage ? 'jpg' : 'mp4';
      const inputName = `input_${i}.${extension}`;

      console.log(`[Export] Downloading media ${i}: ${scene.media.url} (type: ${scene.media.type})`);
      
      try {
        const vidData = await fetchFile(scene.media.url);
        await ffmpeg.writeFile(inputName, vidData);
        console.log(`[Export] Media ${i} written successfully (${vidData.byteLength} bytes)`);
      } catch (mediaErr) {
        console.error(`[Export] Media ${i} download error:`, mediaErr);
        throw new Error(`Medya indirilemedi (Sahne ${i+1}): ${mediaErr.message}. CORS sorunu olabilir.`);
      }
      
      if (isImage) {
        inputs.push('-loop', '1', '-framerate', '60', '-t', scene.duration.toString(), '-i', inputName);
      } else {
        inputs.push(`-i`, inputName);
      }
    }

    // Pass 2: Add Audio Inputs (TTS)
    let audioIndices = [];
    for (let i = 0; i < scenesWithMedia.length; i++) {
      const scene = scenesWithMedia[i];
      
      // First check scene.audioUrl (persisted TTS), then fallback to DOM element
      let audioSrc = scene.audioUrl || null;
      if (!audioSrc) {
        const audioEl = document.getElementById(`audio-${scene.id}`);
        if (audioEl && audioEl.src) {
          audioSrc = audioEl.src;
        }
      }
      
      if (audioSrc && (audioSrc.startsWith('data:audio/') || audioSrc.startsWith('blob:'))) {
        statusEl.textContent = `Ses dosyaları hazırlanıyor (${i + 1}/${scenesWithMedia.length})...`;
        const inputName = `audio_${i}.mp3`;
        try {
          const audData = await fetchFile(audioSrc);
          await ffmpeg.writeFile(inputName, audData);
          inputs.push('-i', inputName);
          audioIndices.push(inputs.filter(arg => arg === '-i').length - 1);
          console.log(`[Export] TTS audio added for scene ${i}: ${inputName}`);
        } catch (e) {
          console.warn('TTS ses alma hatası:', e);
          audioIndices.push(-1);
        }
      } else {
        console.log(`[Export] No TTS audio for scene ${i} (audioSrc: ${audioSrc ? 'exists but not data/blob' : 'null'})`);
        audioIndices.push(-1);
      }
    }

    // Pass 3: Background Music
    let bgMusicIndex = -1;
    if (projectState.backgroundMusic && projectState.backgroundMusic.url) {
      statusEl.textContent = "Arka plan müziği indiriliyor...";
      console.log("[Export] Downloading background music:", projectState.backgroundMusic.url);
      try {
        const bgData = await fetchFile(projectState.backgroundMusic.url);
        await ffmpeg.writeFile('bgmusic.mp3', bgData);
        inputs.push('-i', 'bgmusic.mp3');
        bgMusicIndex = inputs.filter(arg => arg === '-i').length - 1;
        console.log("[Export] Background music added at index:", bgMusicIndex);
      } catch (err) {
        console.error("[Export] Background music download error:", err);
        console.warn("Müzik indirilemedi (CORS veya Ağ hatası olabilir), sessiz export ediliyor:", err);
      }
    }

    // Pass 4: Logo
    let logoIndex = -1;
    if (projectState.logo && projectState.logo.url) {
      statusEl.textContent = "Logo indiriliyor...";
      console.log("[Export] Downloading logo:", projectState.logo.url);
      try {
        const logoData = await fetchFile(projectState.logo.url);
        await ffmpeg.writeFile('logo.png', logoData);
        inputs.push('-loop', '1', '-t', exportDuration.toString(), '-i', 'logo.png');
        logoIndex = inputs.filter(arg => arg === '-i').length - 1;
        console.log("[Export] Logo added at index:", logoIndex);
      } catch (err) {
        console.error("[Export] Logo download error:", err);
      }
    }

    // Pass 5: Build Filters
    for (let i = 0; i < scenesWithMedia.length; i++) {
      const scene = scenesWithMedia[i];
      let textFilters = '';
      if (hasFont) {
        // Helper function for completely safe FFmpeg text encoding
        const encodeFFmpegText = (str) => {
          if(!str) return '';
          return str.replace(/[\n\r]+/g, ' ')
             .split("'").join('\\u2019')
             .split(':').join('\\\\\\\\:')
             .split(',').join('\\\\\\\\,')
             .split('%').join('\\\\\\\\%');
        };

        // Add Subtitle from scene.text
        if (scene.text && projectState.subtitlePreset !== 'none') {
           let safeText = encodeFFmpegText(scene.text);
           // Font size proportional to video height, positioned at bottom 10%
           let subProps = `fontfile=font.ttf:text='${safeText}':fontsize=(h*0.04):x=(w-text_w)/2:y=(h-text_h)-(h*0.1)`;
           
           switch(projectState.subtitlePreset) {
             case 'classic-dark':
               subProps += `:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8`; break;
             case 'classic-light':
               subProps += `:fontcolor=black:box=1:boxcolor=white@0.9:boxborderw=8`; break;
             case 'neon-blue':
               subProps += `:fontcolor=0x22d3ee:box=1:boxcolor=0x0f172a:boxborderw=8`; break;
             case 'neon-pink':
               subProps += `:fontcolor=0xf472b6:box=1:boxcolor=0x1a0a14:boxborderw=8`; break;
             case 'comic':
               subProps += `:fontcolor=0x000000:box=1:boxcolor=0xfde047:boxborderw=4`; break;
             case 'minimal':
               subProps += `:fontcolor=white:borderw=1:bordercolor=black`; break;
             case 'gradient':
               subProps += `:fontcolor=white:box=1:boxcolor=0xec4899@0.8:boxborderw=8`; break; // Gradient cannot be easily done in simple drawtext box, fallback to solid color
             case 'solid':
               subProps += `:fontcolor=black:box=1:boxcolor=white:boxborderw=8:borderw=3:bordercolor=black`; break;
             default:
               subProps += `:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10`; break;
           }
           textFilters += `,drawtext=${subProps}`;
        }

        // Add custom text overlays
        if (scene.overlays && scene.overlays.length > 0) {
        scene.overlays.forEach(ov => {
          let safeText = encodeFFmpegText(ov.text);
          const fontKey = `${ov.fontFamily || 'Arial'}_${ov.fontWeight || 'normal'}`;
          const fontFile = fontMap[fontKey] || 'font.ttf';
          let drawtextProps = `fontfile=${fontFile}:text='${safeText}':fontsize=${ov.fontSize}:x=(w*(${ov.x}/100))-(text_w/2):y=(h*(${ov.y}/100))-(text_h/2)`;
          if (ov.color) drawtextProps += `:fontcolor=${ov.color.replace('#', '0x')}`; else drawtextProps += `:fontcolor=white`;
          if (ov.bgColor && ov.bgColor !== 'transparent') {
            let safeBgColor = ov.bgColor;
            if (safeBgColor === 'rgba(0,0,0,0.7)') safeBgColor = 'black@0.7';
            else if (safeBgColor === 'rgba(255,255,255,0.7)') safeBgColor = 'white@0.7';
            else if (safeBgColor.startsWith('#')) safeBgColor = safeBgColor.replace('#', '0x');
            drawtextProps += `:box=1:boxcolor=${safeBgColor}:boxborderw=8`;
          }
          textFilters += `,drawtext=${drawtextProps}`;
        });
        }
      }

      // Video filters (scale, pad, text overlays) - Simplified approach
      const resColon = resolution.replace('x', ':');
      let videoFilter = `[${i}:v]fps=60,format=yuv420p,scale=${resColon}:force_original_aspect_ratio=decrease,pad=${resColon}:(ow-iw)/2:(oh-ih)/2,setdar=16/9`;
      
      // Add text filter if exists
      if (textFilters) {
        videoFilter += textFilters;
      }
      
      videoFilter += `,trim=duration=${scene.duration},setpts=PTS-STARTPTS[v${i}];`;
      concatFilter += videoFilter;
      
      // Audio filters
      // Use standard resample layout for all inputs so they perfectly match
      if (audioIndices[i] !== -1) {
         concatFilter += `[${audioIndices[i]}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${scene.duration},asetpts=PTS-STARTPTS[a${i}];`;
      } else {
         // anullsrc generates silence. Then we format it explicitly just like the rest
         concatFilter += `anullsrc=r=44100:cl=stereo:d=${scene.duration},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}];`;
      }
    }

    // 2. Concat the streams (Video + Audio)
    statusEl.textContent = "Sahneler Birleştiriliyor (Render ediliyor)... Bu biraz zaman alabilir.";
    
    let concatStreamInputs = '';
    for (let i = 0; i < scenesWithMedia.length; i++) {
      concatStreamInputs += `[v${i}][a${i}]`;
    }
    
    // Concat both V and A
    concatFilter += `${concatStreamInputs}concat=n=${scenesWithMedia.length}:v=1:a=1[vbase][abase];`;
    let outv = '[vbase]';
    let outa = '[abase]';

    // Apply Logo
    if (logoIndex !== -1) {
      const pos = projectState.logo.position || 'top-right';
      const sizePct = projectState.logo.size || 15;
      const marginPct = projectState.logo.margin || 5;
      const [resW, resH] = resolution.split('x').map(Number);
      const logoW = Math.round(resW * (sizePct / 100));
      const marginX = Math.round(resW * (marginPct / 100));
      const marginY = Math.round(resH * (marginPct / 100));
      
      let xPos = "0", yPos = "0";
      if (pos.includes('left')) xPos = `${marginX}`;
      if (pos.includes('right')) xPos = `W-w-${marginX}`;
      if (pos.includes('top')) yPos = `${marginY}`;
      if (pos.includes('bottom')) yPos = `H-h-${marginY}`;

      // 'shortest=1' makes overlay stop when the shortest input (vbase) stops, avoiding infinite looping logo
      concatFilter += `[${logoIndex}:v]scale=${logoW}:-1,format=rgba[logo];[vbase][logo]overlay=x=${xPos}:y=${yPos}:shortest=1[vlogo];`;
      outv = '[vlogo]';
    }
    
    // Apply Background Music
    if (bgMusicIndex !== -1) {
      // Loop background music if it is shorter than the video, then trim to total video duration, format and mix
      // We removed stream_loop from inputs.push because it can be buggy with WebAssembly. Instead, we use aloop filter.
      concatFilter += `[${bgMusicIndex}:a]aloop=loop=-1:size=2e+09,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.15,atrim=0:${exportDuration},asetpts=PTS-STARTPTS[bga];`;
      // amix mixes the main audio (abase) and background audio (bga). duration=first ensures the output ends when the video audio ends.
      concatFilter += `[abase][bga]amix=inputs=2:duration=first:dropout_transition=2[amixed];`;
      outa = '[amixed]';
    }

    // Sondaki fazla noktalı virgülü kaldır ki FFmpeg "No such filter: ''" hatası vermesin
    if (concatFilter.endsWith(';')) {
      concatFilter = concatFilter.slice(0, -1);
    }

    const args = [
      ...inputs,
      '-filter_complex', concatFilter,
      '-map', outv,
      '-map', outa,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-t', exportDuration.toString(),
      'output.mp4'
    ];

    console.log("=== FFmpeg Export Debug Info ===");
    console.log("Resolution:", resolution);
    console.log("Export Duration:", exportDuration);
    console.log("Scenes with media:", scenesWithMedia.length);
    console.log("Audio indices:", audioIndices);
    console.log("Background music index:", bgMusicIndex);
    console.log("Logo index:", logoIndex);
    console.log("Total inputs:", inputs.length / 2, "(video+audio pairs)");
    console.log("Running FFmpeg with args:", args);
    console.log("FULL CONCAT FILTER:", concatFilter);
    
    try {
      const code = await ffmpeg.exec(args);
      
      if (code !== 0) {
        throw new Error(`FFmpeg işlemi hata kodu ile sonlandı: ${code}`);
      }
    } catch (execErr) {
      console.error("FFmpeg exec error details:", execErr);
      throw execErr;
    }

    statusEl.textContent = "Video indiriliyor...";
    
    // 3. Read Output and Download
    const data = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([data], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    
    // Turkish characters and spaces preservation logic
    const safeTitle = projectState.title
      .replace(/[\/\\:*?"<>|]/g, '') // remove invalid filename characters
      .trim() || "Basliksiz";
      
    a.download = `${safeTitle}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    let tokenMsg = "";
    if (supabaseClient && userId) {
      statusEl.textContent = "Token düşülüyor...";
      const newBalance = currentTokens - TOKEN_COST;
      
      const { error: deductErr } = await supabaseClient
        .from('profiles')
        .update({ token_balance: newBalance })
        .eq('id', userId);
        
      if (!deductErr) {
        tokenMsg = `\n\nHesabınızdan ${TOKEN_COST} token düşüldü. (Kalan: ${newBalance})`;
      } else {
        console.error("Token deduction failed:", deductErr);
      }
    }

    const modal = document.getElementById('exportModal');
    if (modal) modal.remove();
    window.activeFFmpeg = null;
    alert(`Video başarıyla oluşturuldu ve bilgisayarınıza indirildi!${tokenMsg}`);

  } catch (err) {
    console.error("=== FFmpeg Export Error ===");
    console.error("Error message:", err.message);
    console.error("FFmpeg logs (last 20):", ffmpegLogs.slice(-20));
    console.error("Error stack:", err.stack);
    console.error("projectState.scenes:", JSON.stringify(projectState.scenes.map(s => ({id: s.id, hasMedia: !!s.media, mediaType: s.media?.type, duration: s.duration, hasAudioUrl: !!s.audioUrl}))));
    alert("Video oluşturulurken bir hata oluştu: " + err.message + "\n\nLütfen tarayıcı konsolunu (F12) açarak detaylı hata bilgilerini kontrol edin.");
    const modal = document.getElementById('exportModal');
    if (modal) modal.remove();
    window.activeFFmpeg = null;
  }
}

// -- Preview Player --
function updatePreview() {
  const activeScene = projectState.scenes.find(s => s.id === projectState.activeSceneId);
  if (!activeScene) return;

  const player = document.getElementById('mainVideoPlayer');
  const imgPreview = document.getElementById('mainImagePreview');
  const placeholder = document.getElementById('previewPlaceholder');
  const subtitle = document.getElementById('previewSubtitle');
  const badge = document.getElementById('currentSceneBadge');
  const globalLogo = document.getElementById('globalLogoPreview');

  badge.textContent = `Bölüm ${projectState.scenes.findIndex(s => s.id === activeScene.id) + 1}`;

  // Update Global Logo Preview
  if (globalLogo) {
    if (projectState.logo && projectState.logo.url) {
      globalLogo.style.display = 'block';
      globalLogo.src = projectState.logo.url;
      
      const pos = projectState.logo.position || 'top-right';
      const size = projectState.logo.size || 15;
      const margin = projectState.logo.margin || 5;

      globalLogo.style.width = `${size}%`;
      globalLogo.style.height = 'auto';
      globalLogo.style.top = 'auto';
      globalLogo.style.bottom = 'auto';
      globalLogo.style.left = 'auto';
      globalLogo.style.right = 'auto';

      if (pos.includes('top')) globalLogo.style.top = `${margin}%`;
      if (pos.includes('bottom')) globalLogo.style.bottom = `${margin}%`;
      if (pos.includes('left')) globalLogo.style.left = `${margin}%`;
      if (pos.includes('right')) globalLogo.style.right = `${margin}%`;

    } else {
      globalLogo.style.display = 'none';
    }
  }

  if (activeScene.media) {
    placeholder.style.display = 'none';
    if (activeScene.media.type === 'image') {
      player.style.display = 'none';
      imgPreview.style.display = 'block';
      imgPreview.src = activeScene.media.url;
    } else {
      imgPreview.style.display = 'none';
      player.style.display = 'block';
      if (player.src !== activeScene.media.url) {
        player.src = activeScene.media.url;
        if (projectState.isPlaying) {
          player.play().catch(e => console.log("Auto-play prevented by browser policy", e));
        }
      }
    }
  } else {
    player.style.display = 'none';
    if (imgPreview) imgPreview.style.display = 'none';
    placeholder.style.display = 'flex';
    player.src = '';
  }

  if (activeScene.text && projectState.subtitlePreset !== 'none') {
    const presetClass = projectState.subtitlePreset ? `preset-${projectState.subtitlePreset}` : 'preset-classic-dark';
    subtitle.innerHTML = `<div class="subtitle-text ${presetClass}">${activeScene.text}</div>`;
  } else {
    subtitle.innerHTML = '';
  }

  const overlaysContainer = document.getElementById('overlaysContainer');
  if (overlaysContainer) {
    overlaysContainer.innerHTML = '';
    if (activeScene.overlays && activeScene.overlays.length > 0) {
      activeScene.overlays.forEach(overlay => {
        const el = document.createElement('div');
        el.textContent = overlay.text;
        el.style.position = 'absolute';
        el.style.left = overlay.x + '%';
        el.style.top = overlay.y + '%';
        el.style.transform = 'translate(-50%, -50%)';
        el.style.color = overlay.color || '#ffffff';
        el.style.backgroundColor = overlay.bgColor && overlay.bgColor !== 'transparent' ? overlay.bgColor : 'transparent';
        el.style.fontSize = overlay.fontSize + 'px';
        el.style.fontWeight = overlay.fontWeight || 'normal';
        el.style.fontFamily = overlay.fontFamily ? `"${overlay.fontFamily}", sans-serif` : 'var(--sans, sans-serif)';
        el.style.textShadow = '1px 1px 4px rgba(0,0,0,0.8)';
        el.style.textAlign = 'center';
        el.style.width = 'max-content';
        el.style.maxWidth = '90%';
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'move';
        el.contentEditable = "true";
        el.style.outline = "none";
        el.style.padding = "4px 8px";
        el.style.borderRadius = "4px";
        el.style.border = "1px solid transparent";

        el.addEventListener('mousedown', (e) => {
          if (document.activeElement === el) return; // Don't drag if editing
          activeDragOverlay = overlay;
          activeDragEl = el;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragInitialX = overlay.x;
          dragInitialY = overlay.y;
        });

        el.addEventListener('focus', () => {
          el.style.border = "1px dashed rgba(255,255,255,0.7)";
          el.style.cursor = "text";
        });

        el.addEventListener('blur', () => {
          el.style.border = "1px solid transparent";
          el.style.cursor = "move";
          // Safely extract text without newlines that could break FFmpeg
          overlay.text = el.innerText.replace(/\n/g, ' ') || "Metin";
          el.textContent = overlay.text;
          renderPropertiesPanel();
        });

        el.addEventListener('input', () => {
          overlay.text = el.innerText.replace(/\n/g, ' ');
          const panelInput = document.getElementById(`overlay-input-${overlay.id}`);
          if (panelInput) panelInput.value = overlay.text;
        });

        // Prevent dragging from firing if clicking inside while focused
        el.addEventListener('click', (e) => {
           if (document.activeElement === el) e.stopPropagation();
        });

        overlaysContainer.appendChild(el);
      });
    }
  }
}

// -- Timeline Interactions --
let isDraggingPlayhead = false;
let isResizingClip = false;
let resizeSceneId = null;
let resizeEdge = null; // 'left' or 'right'
let resizeInitialX = 0;
let resizeInitialDuration = 0;

function initTimelineInteractions() {
  const container = document.getElementById('timelineContainer');

  // 1. Seek on timeline click
  container.addEventListener('mousedown', (e) => {
    // If clicking on a resize handle, don't seek
    if (e.target.classList.contains('clip-resize-handle')) {
      isResizingClip = true;
      resizeSceneId = e.target.parentElement.getAttribute('data-id');
      resizeEdge = e.target.classList.contains('clip-resize-right') ? 'right' : 'left';
      resizeInitialX = e.clientX;
      const scene = projectState.scenes.find(s => s.id === resizeSceneId);
      resizeInitialDuration = scene ? scene.duration : 0;
      return;
    }

    // Playhead drag or direct seek
    isDraggingPlayhead = true;
    updateSeekPosition(e.clientX);
    
    // Pause if playing while seeking
    if (projectState.isPlaying) {
      togglePlay();
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (isDraggingPlayhead) {
      updateSeekPosition(e.clientX);
    } else if (isResizingClip) {
      handleClipResize(e.clientX);
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDraggingPlayhead) {
      isDraggingPlayhead = false;
      // Re-render to ensure active scene logic fires correctly after seek
      updatePlayhead();
    }
    
    if (isResizingClip) {
      isResizingClip = false;
      resizeSceneId = null;
      resizeEdge = null;
      updateTotalDuration();
      renderScenes(); // Refresh duration in properties panel if open
      renderTimeline(); // Snap back to grid properly
    }
  });

  function updateSeekPosition(clientX) {
    const pixelsPerSecond = getPixelsPerSecond();
    const rect = container.getBoundingClientRect();
    let x = clientX - rect.left + container.scrollLeft;
    
    // Constrain to bounds
    x = Math.max(0, Math.min(x, projectState.totalDuration * pixelsPerSecond));
    
    seekToTime(x / pixelsPerSecond, {
      syncMedia: true,
      keepPlaying: false,
      forceRender: true
    });
  }

  function handleClipResize(clientX) {
    const pixelsPerSecond = getPixelsPerSecond();
    const scene = projectState.scenes.find(s => s.id === resizeSceneId);
    if (!scene) return;

    const dx = clientX - resizeInitialX;
    const durationDelta = dx / pixelsPerSecond;

    if (resizeEdge === 'right') {
      let newDuration = resizeInitialDuration + durationDelta;
      scene.duration = normalizeSceneDuration(newDuration, scene.duration);
    } else if (resizeEdge === 'left') {
      // Modifying the left edge actually means changing the duration AND moving the start point,
      // but since our scenes flow sequentially, changing duration of scene N affects all N+1 scenes.
      // For simplicity in a sequential builder, left drag also just changes duration in reverse.
      let newDuration = resizeInitialDuration - durationDelta;
      scene.duration = normalizeSceneDuration(newDuration, scene.duration);
    }
    
    // Fast visual update
    updateTotalDuration();
    renderTimeline();
  }
}

// -- Timeline & Playback --
function updateTotalDuration() {
  projectState.scenes.forEach((scene) => {
    scene.duration = normalizeSceneDuration(scene.duration, estimateSceneDuration(scene.text));
  });
  projectState.totalDuration = Number(projectState.scenes.reduce((acc, scene) => acc + scene.duration, 0).toFixed(2));
  projectState.currentTime = Math.max(0, Math.min(projectState.currentTime, projectState.totalDuration));
  document.getElementById('timeDisplay').textContent = `${formatTime(projectState.currentTime)} / ${formatTime(projectState.totalDuration)}`;
}

function renderTimeline() {
  const videoTrack = document.getElementById('videoTrack');
  const audioTrack = document.getElementById('audioTrack');
  videoTrack.innerHTML = '';
  audioTrack.innerHTML = '';
  
  let bgMusicTrack = document.getElementById('bgMusicTrack');
  if (!bgMusicTrack) {
     bgMusicTrack = document.createElement('div');
     bgMusicTrack.id = 'bgMusicTrack';
     bgMusicTrack.className = 'timeline-track audio-track';
     bgMusicTrack.style.marginTop = '4px';
     bgMusicTrack.style.display = 'none';
     document.querySelector('.timeline-track-group').appendChild(bgMusicTrack);
  }
  bgMusicTrack.innerHTML = '';
  
  const pixelsPerSecond = getPixelsPerSecond();
  
  // -- Render Ruler --
  const ruler = document.getElementById('timelineRuler');
  ruler.innerHTML = '';
  // Ruler is at least as wide as the window, or the total duration, plus some padding
  const totalWidth = Math.max(window.innerWidth, projectState.totalDuration * pixelsPerSecond + 200);
  ruler.style.width = `${totalWidth}px`;
  
  // Draw marks every 1 second, text every 5 seconds
  for (let i = 0; i <= projectState.totalDuration + 5; i++) {
    const x = i * pixelsPerSecond;
    if (i % 5 === 0) {
      ruler.innerHTML += `<div class="ruler-text" style="left:${x}px">${formatTime(i)}</div>`;
      ruler.innerHTML += `<div class="ruler-mark" style="left:${x}px; height:10px;"></div>`;
    } else {
      ruler.innerHTML += `<div class="ruler-mark" style="left:${x}px; height:5px; top:19px;"></div>`;
    }
  }
  
  // -- Render Tracks --
  let currentOffset = 0;
  
  // Update track group width
  document.querySelector('.timeline-track-group').style.width = `${projectState.totalDuration * pixelsPerSecond + 100}px`;
  
  projectState.scenes.forEach((scene, index) => {
    const width = scene.duration * pixelsPerSecond;
    
    // Video Clip
    const vClip = document.createElement('div');
    vClip.className = `timeline-clip clip-video ${!scene.media ? 'empty' : ''}`;
    vClip.setAttribute('data-id', scene.id);
    vClip.style.left = `${currentOffset}px`;
    vClip.style.width = `${width}px`;
    if (scene.media) {
      vClip.style.backgroundImage = `url(${scene.media.thumbnail})`;
    }
    vClip.innerHTML = `
      <div class="clip-resize-handle clip-resize-left"></div>
      <span class="clip-label">Bölüm ${index + 1} (${scene.duration}s)</span>
      <div class="clip-resize-handle clip-resize-right"></div>
    `;
    
    vClip.onclick = (e) => {
      // Ignore click if clicking resize handles
      if (e.target.classList.contains('clip-resize-handle')) return;

      seekToTime(getSceneStartTime(scene.id), {
        pausePlayback: true,
        syncMedia: true,
        keepPlaying: false,
        forceRender: true
      });
    };
    
    videoTrack.appendChild(vClip);
    
    // Audio Clip (Generated TTS Voice)
    const audioEl = document.getElementById(`audio-${scene.id}`);
    const hasAudio = scene.audioUrl && scene.audioUrl.startsWith('data:audio/');
    if (hasAudio) {
      const aClip = document.createElement('div');
      aClip.className = 'timeline-clip clip-audio';
      aClip.style.left = `${currentOffset}px`;
      
      // Calculate width based on actual audio duration or scene duration, whichever is smaller,
      // but typically we match the scene width to keep it neat, or show real duration.
      // Let's use scene width for now, but label it.
      aClip.style.width = `${width}px`;
      aClip.innerHTML = `<span class="clip-label" style="color:#fff; text-shadow:1px 1px 2px rgba(0,0,0,0.8);">${scene.voice} 🎙️</span>`;
      audioTrack.appendChild(aClip);
    }
    
    currentOffset += width;
  });

  if (projectState.backgroundMusic) {
    bgMusicTrack.style.display = 'block';
    const bgClip = document.createElement('div');
    bgClip.className = 'timeline-clip clip-audio';
    bgClip.style.left = '0px';
    bgClip.style.width = `${projectState.totalDuration * pixelsPerSecond}px`;
    bgClip.style.backgroundColor = 'rgba(0, 163, 255, 0.4)';
    bgClip.style.borderColor = 'rgba(0, 163, 255, 0.8)';
    bgClip.style.borderStyle = 'solid';
    bgClip.style.borderWidth = '1px';
    bgClip.innerHTML = `<span class="clip-label" style="color:#fff; text-shadow:1px 1px 2px rgba(0,0,0,0.8);">${projectState.backgroundMusic.title} (Arka Plan)</span>`;
    bgMusicTrack.appendChild(bgClip);
  } else {
    bgMusicTrack.style.display = 'none';
  }

  updatePlayhead();
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function togglePlay() {
  projectState.isPlaying = !projectState.isPlaying;
  const playIcon = document.querySelector('.icon-play');
  const pauseIcon = document.querySelector('.icon-pause');
  const player = document.getElementById('mainVideoPlayer');
  const bgMusicPlayer = document.getElementById('bgMusicPlayer');

  if (projectState.isPlaying) {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';

    seekToTime(projectState.currentTime, {
      syncMedia: true,
      keepPlaying: true,
      forceRender: true
    });

    lastPlaybackTick = performance.now();
    const tick = (now) => {
      if (!projectState.isPlaying) return;

      const elapsed = Math.max(0, (now - lastPlaybackTick) / 1000);
      lastPlaybackTick = now;
      const nextTime = projectState.currentTime + elapsed;

      if (nextTime >= projectState.totalDuration) {
        seekToTime(projectState.totalDuration, {
          syncMedia: true,
          keepPlaying: false,
          forceRender: true
        });
        togglePlay();
        return;
      }

      seekToTime(nextTime, {
        syncMedia: false,
        keepPlaying: false
      });

      playbackRafId = requestAnimationFrame(tick);
    };

    playbackRafId = requestAnimationFrame(tick);
  } else {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';

    if (player && player.src) player.pause();
    projectState.scenes.forEach((scene) => {
      const sceneAudio = document.getElementById(`audio-${scene.id}`);
      if (sceneAudio && sceneAudio.src) sceneAudio.pause();
    });
    if (bgMusicPlayer && bgMusicPlayer.src) bgMusicPlayer.pause();

    if (playbackRafId) {
      cancelAnimationFrame(playbackRafId);
      playbackRafId = null;
    }
  }
}

function updatePlayhead() {
  const pixelsPerSecond = getPixelsPerSecond();
  const playhead = document.getElementById('playhead');
  playhead.style.left = `${projectState.currentTime * pixelsPerSecond}px`;

  document.getElementById('timeDisplay').textContent = `${formatTime(projectState.currentTime)} / ${formatTime(projectState.totalDuration)}`;

  const sceneInfo = getSceneAtTime(projectState.currentTime);
  if (!sceneInfo) return;

  if (projectState.activeSceneId !== sceneInfo.scene.id) {
    projectState.scenes.forEach((scene) => {
      if (scene.id !== sceneInfo.scene.id) {
        const otherAudio = document.getElementById(`audio-${scene.id}`);
        if (otherAudio && !otherAudio.paused) otherAudio.pause();
      }
    });

    projectState.activeSceneId = sceneInfo.scene.id;
    renderScenes();
    renderPropertiesPanel();

    if (projectState.isPlaying) {
      syncSceneMediaAtTime(sceneInfo.scene, sceneInfo.timeIntoScene);
    }
  }

  const timelineContainer = document.getElementById('timelineContainer');
  if (timelineContainer) {
    const targetX = projectState.currentTime * pixelsPerSecond;
    const leftBound = timelineContainer.scrollLeft;
    const rightBound = leftBound + timelineContainer.clientWidth;
    if (targetX < leftBound || targetX > rightBound) {
      timelineContainer.scrollLeft = Math.max(0, targetX - timelineContainer.clientWidth * 0.35);
    }
  }
}
