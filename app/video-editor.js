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
  scenes: [
    {
      id: generateId(),
      text: "Dose control matters. Limit consumption to one ounce daily...",
      voice: "speech-01", // Minimax voice ID
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

// Drag & Drop State for Overlays
let activeDragOverlay = null;
let activeDragEl = null;
let dragStartX = 0;
let dragStartY = 0;
let dragInitialX = 0;
let dragInitialY = 0;

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  projectState.activeSceneId = projectState.scenes[0].id;
  
  initUI();
  bindEvents();
  renderScenes();
  renderTimeline();
  
  // Auto-search for the initial scene if it has text
  if (projectState.scenes[0].text && !projectState.scenes[0].media) {
    autoSearchMediaForScene(projectState.scenes[0]);
  }
});

// -- Utility Functions --
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
        id: generateId(), text: "", voice: "speech-01", media: null, overlays: [], duration: 5.0, autoSearched: false
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
    const halfDuration = activeScene.duration / 2;

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
      voice: "speech-01",
      media: null,
      overlays: [],
      duration: 3.0,
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
    zoomSlider.addEventListener('input', (e) => {
      document.querySelector('.control-text').textContent = e.target.value + '%';
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
        projectState.activeSceneId = scene.id;
        renderScenes(); // re-render to update active state
        updatePreview();
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
        <audio id="audio-${scene.id}" style="display:none;"></audio>
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
    scene.duration = Math.max(3.0, wordCount / 2.5); // Minimum 3 seconds
    
    updateTotalDuration();
    renderTimeline();
    
    // Auto-search logic: if text changed significantly and no media or not auto-searched yet
    if (scene.text.length > 10 && (!scene.media || !scene.autoSearched)) {
      autoSearchMediaForScene(scene);
    }
  }
}, 1000); // 1 second debounce

// -- Voice & TTS Management --
const MINIMAX_VOICES = [
  { id: "male-qn-qingse", label: "Qingse (Male)", gender: "Male" },
  { id: "female-shaonv", label: "Shaonv (Female)", gender: "Female" },
  { id: "speech-01", label: "Speech-01", gender: "Unknown" },
  { id: "speech-02", label: "Speech-02", gender: "Unknown" }
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
    MINIMAX_VOICES.forEach(voice => {
      optionsHtml += `
        <div class="voice-option" onclick="selectVoice('${voice.id}')" style="padding: 12px; border-bottom: 1px solid var(--border); cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 600; color: var(--text);">${voice.label}</span>
          <span style="font-size: 11px; padding: 2px 6px; background: var(--bg-page); border-radius: 4px; color: var(--text-muted);">${voice.gender}</span>
        </div>
      `;
    });

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

async function generateTTS(sceneId) {
  const scene = projectState.scenes.find(s => s.id === sceneId);
  if (!scene || !scene.text.trim()) {
    alert("Önce bu bölüm için bir metin yazmalısınız.");
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
    
    const { data, error } = await supabaseClient.functions.invoke('minimax-tts', {
      body: { text: scene.text, voice_id: scene.voice }
    });
    
    console.log("TTS Response:", data, error);
    
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    
    if (data && data.data && data.data.audio) {
      // Audio comes back as hex or base64 based on API. Usually base64 or hex.
      // MiniMax T2A V2 returns hex string in `data.audio`
      const hexString = data.data.audio;
      
      // Convert Hex to Base64
      let raw = '';
      for (let i = 0; i < hexString.length; i += 2) {
        raw += String.fromCharCode(parseInt(hexString.substr(i, 2), 16));
      }
      const b64 = btoa(raw);
      const audioUrl = "data:audio/mp3;base64," + b64;
      
      const audioEl = document.getElementById(`audio-${scene.id}`);
      if (!audioEl) {
        throw new Error("Audio element not found");
      }
      audioEl.src = audioUrl;
      
      // Load and update duration
      audioEl.onloadedmetadata = () => {
        scene.duration = Math.max(3.0, audioEl.duration);
        updateTotalDuration();
        renderTimeline();
      };
      
      // Auto-play the generated sound
      audioEl.play();
      alert("Ses başarıyla oluşturuldu!");
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
        <input type="number" value="${activeScene.duration.toFixed(1).replace('.', ',')}" step="0.5" min="1" onchange="updateSceneDuration(this.value.replace(',', '.'), '${activeScene.id}')" style="width:100%; padding:10px 12px; border-radius:6px; border:1px solid var(--border); background:var(--bg-page); color:var(--text); font-weight:500;">
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
    scene.duration = parseFloat(val);
    updateTotalDuration();
    renderTimeline();
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

  // Check if we have media to export
  const scenesWithMedia = projectState.scenes.filter(s => s.media);
  if (scenesWithMedia.length === 0) {
    alert("Dışa aktarılacak hiçbir medya (video) bulunamadı. Lütfen önce videoya sahne ekleyin.");
    document.getElementById('exportModal').remove();
    return;
  }

  ffmpeg.on('log', ({ message }) => {
    console.log('[FFmpeg]', message);
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

    statusEl.textContent = "Font yükleniyor...";
    let hasFont = false;
    try {
      // Roboto font
      const fontData = await fetchFile('https://raw.githubusercontent.com/googlefonts/roboto/main/src/hinted/Roboto-Regular.ttf');
      await ffmpeg.writeFile('font.ttf', fontData);
      hasFont = true;
    } catch(e) {
      console.warn("Font fetch failed, text overlays might not be exported.", e);
    }

    // 1. Download and Write Files to FFmpeg FS
    let concatFilter = '';
    let inputs = [];
    
    for (let i = 0; i < scenesWithMedia.length; i++) {
      const scene = scenesWithMedia[i];
      statusEl.textContent = `Medya indiriliyor (${i + 1}/${scenesWithMedia.length})...`;
      
      const isImage = scene.media.type === 'image';
      const extension = isImage ? 'jpg' : 'mp4';
      const inputName = `input_${i}.${extension}`;

      const vidData = await fetchFile(scene.media.url);
      await ffmpeg.writeFile(inputName, vidData);
      
      if (isImage) {
        inputs.push('-loop', '1', '-framerate', '30', '-t', scene.duration.toString(), '-i', inputName);
      } else {
        inputs.push(`-i`, inputName);
      }
      
      let textFilters = '';
      if (hasFont) {
        // Add Subtitle from scene.text
        if (scene.text && projectState.subtitlePreset !== 'none') {
           let safeText = scene.text.replace(/'/g, "\\'").replace(/:/g, "\\:");
           // Font size proportional to video height, positioned at bottom 10%
           let subProps = `fontfile=font.ttf:text='${safeText}':fontsize=(h*0.04):x=(w-text_w)/2:y=(h-text_h)-(h*0.1)`;
           
           switch(projectState.subtitlePreset) {
             case 'default':
               subProps += `:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10`; break;
             case 'white-box':
               subProps += `:fontcolor=black:box=1:boxcolor=white:boxborderw=10`; break;
             case 'black-box':
               subProps += `:fontcolor=white:box=1:boxcolor=black:boxborderw=10`; break;
             case 'stroke':
               subProps += `:fontcolor=white:borderw=3:bordercolor=black`; break;
             case 'blue-pill':
               subProps += `:fontcolor=white:box=1:boxcolor=blue:boxborderw=20`; break;
             case 'comic-yellow':
               subProps += `:fontcolor=yellow:borderw=4:bordercolor=black`; break;
             case 'shadow':
               subProps += `:fontcolor=white:shadowx=3:shadowy=3:shadowcolor=black@0.9`; break;
             case 'red-box':
               subProps += `:fontcolor=white:box=1:boxcolor=red:boxborderw=10`; break;
             default:
               subProps += `:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10`; break;
           }
           textFilters += `,drawtext=${subProps}`;
        }

        // Add custom text overlays
        if (scene.overlays && scene.overlays.length > 0) {
        scene.overlays.forEach(ov => {
          // Escape single quotes and colons for FFmpeg
          let safeText = ov.text.replace(/'/g, "\\'").replace(/:/g, "\\:");
          
          let drawtextProps = `fontfile=font.ttf:text='${safeText}':fontsize=${ov.fontSize}:x=(w-text_w)*(${ov.x}/100):y=(h-text_h)*(${ov.y}/100)`;
          
          if (ov.color) {
            let safeColor = ov.color.replace('#', '0x');
            drawtextProps += `:fontcolor=${safeColor}`;
          } else {
            drawtextProps += `:fontcolor=white`;
          }

          if (ov.bgColor && ov.bgColor !== 'transparent') {
            let safeBgColor = ov.bgColor;
            if (safeBgColor === 'rgba(0,0,0,0.7)') safeBgColor = 'black@0.7';
            else if (safeBgColor === 'rgba(255,255,255,0.7)') safeBgColor = 'white@0.7';
            else if (safeBgColor.startsWith('#')) safeBgColor = safeBgColor.replace('#', '0x');
            
            drawtextProps += `:box=1:boxcolor=${safeBgColor}:boxborderw=8`;
          }

          // Convert percentage to FFmpeg coordinates (w-text_w) * 0.5
          textFilters += `,drawtext=${drawtextProps}`;
        });
        }
      }

      // Resize to selected resolution (1080p etc.), set DAR to 16:9, trim to scene.duration, add text overlays
      concatFilter += `[${i}:v]scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:(ow-iw)/2:(oh-ih)/2,setdar=16/9${textFilters},trim=duration=${scene.duration}[v${i}];`;
    }

    // 2. Concat the streams
    statusEl.textContent = "Sahneler Birleştiriliyor (Render ediliyor)... Bu biraz zaman alabilir.";
    
    let concatStreamInputs = '';
    for (let i = 0; i < scenesWithMedia.length; i++) {
      concatStreamInputs += `[v${i}]`;
    }
    concatFilter += `${concatStreamInputs}concat=n=${scenesWithMedia.length}:v=1:a=0[outv]`;

    const args = [
      ...inputs,
      '-filter_complex', concatFilter,
      '-map', '[outv]',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-t', projectState.totalDuration.toString(),
      'output.mp4'
    ];

    console.log("Running FFmpeg with args:", args);
    await ffmpeg.exec(args);

    statusEl.textContent = "Video indiriliyor...";
    
    // 3. Read Output and Download
    const data = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([data], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectState.title.replace(/[^a-z0-9]/gi, '_')}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    const modal = document.getElementById('exportModal');
    if (modal) modal.remove();
    window.activeFFmpeg = null;
    alert("Video başarıyla oluşturuldu ve bilgisayarınıza indirildi!");

  } catch (err) {
    console.error("FFmpeg Export Error:", err);
    alert("Video oluşturulurken bir hata oluştu veya işlem iptal edildi: " + err.message + "\n(Tarayıcı CORS politikaları nedeniyle medya indirilememiş olabilir.)");
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

  badge.textContent = `Bölüm ${projectState.scenes.findIndex(s => s.id === activeScene.id) + 1}`;

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
        // Ensure the video plays immediately if we just assigned it
        player.play().catch(e => console.log("Auto-play prevented by browser policy", e));
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
  const playhead = document.getElementById('playhead');
  const pixelsPerSecond = 30;

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
    const rect = container.getBoundingClientRect();
    // Padding/margin offset for playhead is typically 0 for the start of the tracks
    let x = clientX - rect.left;
    
    // Constrain to bounds
    x = Math.max(0, Math.min(x, projectState.totalDuration * pixelsPerSecond));
    
    projectState.currentTime = x / pixelsPerSecond;
    updatePlayhead();
  }

  function handleClipResize(clientX) {
    const scene = projectState.scenes.find(s => s.id === resizeSceneId);
    if (!scene) return;

    const dx = clientX - resizeInitialX;
    const durationDelta = dx / pixelsPerSecond;

    if (resizeEdge === 'right') {
      let newDuration = resizeInitialDuration + durationDelta;
      newDuration = Math.max(1, newDuration); // Minimum 1 second
      scene.duration = parseFloat(newDuration.toFixed(1));
    } else if (resizeEdge === 'left') {
      // Modifying the left edge actually means changing the duration AND moving the start point,
      // but since our scenes flow sequentially, changing duration of scene N affects all N+1 scenes.
      // For simplicity in a sequential builder, left drag also just changes duration in reverse.
      let newDuration = resizeInitialDuration - durationDelta;
      newDuration = Math.max(1, newDuration);
      scene.duration = parseFloat(newDuration.toFixed(1));
    }
    
    // Fast visual update
    updateTotalDuration();
    renderTimeline();
  }
}

// -- Timeline & Playback --
function updateTotalDuration() {
  projectState.totalDuration = projectState.scenes.reduce((acc, scene) => acc + scene.duration, 0);
  document.getElementById('timeDisplay').textContent = `0:00 / ${formatTime(projectState.totalDuration)}`;
}

function renderTimeline() {
  const videoTrack = document.getElementById('videoTrack');
  const audioTrack = document.getElementById('audioTrack');
  videoTrack.innerHTML = '';
  audioTrack.innerHTML = '';
  
  const pixelsPerSecond = 30; // 30px per second for timeline scale
  
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
      
      projectState.activeSceneId = scene.id;
      renderScenes();
    };
    
    videoTrack.appendChild(vClip);
    
    // Audio Clip (Voiceover placeholder)
    if (scene.text.trim().length > 0) {
      const aClip = document.createElement('div');
      aClip.className = 'timeline-clip clip-audio';
      aClip.style.left = `${currentOffset}px`;
      aClip.style.width = `${width}px`;
      audioTrack.appendChild(aClip);
    }
    
    currentOffset += width;
  });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

let playbackInterval;
function togglePlay() {
  projectState.isPlaying = !projectState.isPlaying;
  const playIcon = document.querySelector('.icon-play');
  const pauseIcon = document.querySelector('.icon-pause');
  const player = document.getElementById('mainVideoPlayer');
  const currentSceneAudio = document.getElementById(`audio-${projectState.activeSceneId}`);

  if (projectState.isPlaying) {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
    
    if (player && player.src) player.play();
    if (currentSceneAudio && currentSceneAudio.src) {
        // Calculate where the audio should be based on scene offset
        let offset = 0;
        for (let s of projectState.scenes) {
            if (s.id === projectState.activeSceneId) break;
            offset += s.duration;
        }
        const audioCurrentTime = projectState.currentTime - offset;
        if (audioCurrentTime >= 0 && audioCurrentTime < currentSceneAudio.duration) {
            currentSceneAudio.currentTime = audioCurrentTime;
            currentSceneAudio.play();
        }
    }
    
    playbackInterval = setInterval(() => {
      projectState.currentTime += 0.1;
      if (projectState.currentTime >= projectState.totalDuration) {
        projectState.currentTime = 0;
        togglePlay(); // Pause at end
      }
      updatePlayhead();
    }, 100);
  } else {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
    
    if (player && player.src) player.pause();
    if (currentSceneAudio && currentSceneAudio.src) currentSceneAudio.pause();
    
    clearInterval(playbackInterval);
  }
}

function updatePlayhead() {
  const pixelsPerSecond = 30;
  const playhead = document.getElementById('playhead');
  // Ruler starts right at the edge in tracks-container, so offset is just for visual padding if needed.
  // Actually, left should just be currentTime * pixelsPerSecond.
  playhead.style.left = `${projectState.currentTime * pixelsPerSecond}px`;
  
  document.getElementById('timeDisplay').textContent = `${formatTime(projectState.currentTime)} / ${formatTime(projectState.totalDuration)}`;
  
  // Update active scene based on time
  let timeAccumulator = 0;
  for (let scene of projectState.scenes) {
    timeAccumulator += scene.duration;
      if (projectState.currentTime <= timeAccumulator) {
      if (projectState.activeSceneId !== scene.id) {
        // Pause previous scene's audio
        const oldSceneAudio = document.getElementById(`audio-${projectState.activeSceneId}`);
        if (oldSceneAudio && oldSceneAudio.src) oldSceneAudio.pause();
        
        projectState.activeSceneId = scene.id;
        renderScenes(); // updates UI and preview
        
        // Ensure video and new audio is playing if active
        if (projectState.isPlaying) {
          const player = document.getElementById('mainVideoPlayer');
          if (player.src) player.play();
          
          const newSceneAudio = document.getElementById(`audio-${scene.id}`);
          if (newSceneAudio && newSceneAudio.src) {
             newSceneAudio.currentTime = 0; // restart audio for new scene
             newSceneAudio.play();
          }
        }
      }
      break;
    }
  }
}
