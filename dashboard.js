/* YTConsole Dashboard - Auth, Language, Theme */

const THEME_KEY = "yt-gonderi-uzmani:theme";
const LANG_KEY = "ytconsole:lang";

const $ = (id) => document.getElementById(id);

/* ── Supabase ── */
const SUPABASE_URL = "https://bjcsbuvjumaigvsjphor.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ws-ubr-U3Uryo-oJxE0rvg_QTlz2Kqa";

let supabaseClient;
try {
  supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
} catch (e) {
  console.error("Supabase error:", e);
}

/* ── Toast ── */
function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("is-visible");
  setTimeout(() => t.classList.remove("is-visible"), 3000);
}

/* ── Animated Dashboard Background ── */
function buildBackgroundPaths(svgId, position) {
  const svg = $(svgId);
  if (!svg) return;

  svg.innerHTML = "";
  const pathCount = window.matchMedia("(max-width: 640px)").matches ? 24 : 36;

  for (let i = 0; i < pathCount; i++) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const baseX = 380 - i * 5 * position;
    const d = [
      `M-${baseX} -${189 + i * 6}`,
      `C-${baseX} -${189 + i * 6}`,
      `-${312 - i * 5 * position} ${216 - i * 6}`,
      `${152 - i * 5 * position} ${343 - i * 6}`,
      `C${616 - i * 5 * position} ${470 - i * 6}`,
      `${684 - i * 5 * position} ${875 - i * 6}`,
      `${684 - i * 5 * position} ${875 - i * 6}`
    ].join(" ");

    path.setAttribute("d", d);
    path.setAttribute("class", "dashboard-path");
    path.setAttribute("stroke-width", (0.45 + i * 0.03).toFixed(2));
    path.setAttribute("stroke-opacity", String(Math.min(0.65, 0.08 + i * 0.02)));

    const duration = 18 + Math.random() * 12;
    const pulseDuration = 6 + (i % 6) * 1.2;
    path.style.animationDuration = `${duration}s, ${pulseDuration}s`;
    path.style.animationDelay = `${-1 * i * 0.45}s, ${-1 * i * 0.2}s`;

    svg.appendChild(path);
    const totalLength = Math.max(1, Math.round(path.getTotalLength()));
    path.style.setProperty("--path-length", String(totalLength));
    path.style.strokeDasharray = `${Math.round(totalLength * 0.34)} ${Math.round(totalLength * 0.66)}`;
  }
}

function initBackgroundPaths() {
  if (!$("dashboardPathsLeft") || !$("dashboardPathsRight")) return;
  buildBackgroundPaths("dashboardPathsLeft", 1);
  buildBackgroundPaths("dashboardPathsRight", -1);

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      buildBackgroundPaths("dashboardPathsLeft", 1);
      buildBackgroundPaths("dashboardPathsRight", -1);
    }, 140);
  });
}

/* ── Auth Service ── */
const AuthService = {
  currentUser: null,

  async init() {
    if (!supabaseClient) return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      await this.fetchProfile(session.user.id);
    }
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        await this.fetchProfile(session.user.id);
      } else {
        this.currentUser = null;
        this.updateUI();
      }
    });
  },

  async fetchProfile(userId) {
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          const created = await this.createProfileFallback(userId);
          if (created) return;
        }
        console.error("Profile Error:", error);
        toast("Profil hatasi: " + error.message);
        return;
      }

      if (data) {
        this.currentUser = {
          id: data.id,
          email: data.email,
          name: data.full_name || data.email.split('@')[0],
          tokens: data.token_balance
        };
        this.updateUI();
      }
    } catch (err) {
      console.error("Profile system error", err);
    }
  },

  async createProfileFallback(userId) {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return false;

      const email = user.email;
      const fullName = user.user_metadata?.full_name || email?.split('@')[0] || '';

      const { data, error } = await supabaseClient
        .from('profiles')
        .insert({ id: userId, email, full_name: fullName, token_balance: 5 })
        .select()
        .single();

      if (error) {
        await new Promise(r => setTimeout(r, 2000));
        const { data: retryData, error: retryError } = await supabaseClient
          .from('profiles').select('*').eq('id', userId).single();

        if (!retryError && retryData) {
          this.currentUser = {
            id: retryData.id,
            email: retryData.email,
            name: retryData.full_name || retryData.email?.split('@')[0],
            tokens: retryData.token_balance
          };
          this.updateUI();
          return true;
        }
        toast("Profil olusturulamadi. Lutfen sayfayi yenileyip tekrar giris yapin.");
        return false;
      }

      if (data) {
        this.currentUser = {
          id: data.id,
          email: data.email,
          name: data.full_name || data.email?.split('@')[0],
          tokens: data.token_balance
        };
        this.updateUI();
        return true;
      }
      return false;
    } catch (err) {
      console.error("Profile creation fallback error:", err);
      return false;
    }
  },

  async login(email, password) {
    if (!supabaseClient) {
      toast("Supabase baglantisi kurulamadi. Sayfayi yenileyin.");
      return false;
    }
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        let msg = error.message;
        if (msg.includes("Invalid login credentials")) msg = "Gecersiz e-posta veya sifre.";
        else if (msg.includes("Email not confirmed")) msg = "E-posta adresiniz henuz dogrulanmamis.";
        else if (msg.includes("Too many requests") || msg.includes("rate limit")) msg = "Cok fazla deneme yaptiniz. Lutfen bekleyin.";
        toast("Giris hatasi: " + msg);
        return false;
      }
      return true;
    } catch (err) {
      toast("Giris sirasinda bir hata olustu.");
      return false;
    }
  },

  async register(name, email, password) {
    if (!supabaseClient) {
      toast("Supabase baglantisi kurulamadi. Sayfayi yenileyin.");
      return false;
    }
    if (!password || password.length < 6) {
      toast("Sifre en az 6 karakter olmalidir.");
      return false;
    }
    if (!name || name.trim().length === 0) {
      toast("Lutfen adinizi girin.");
      return false;
    }
    try {
      const { data, error } = await supabaseClient.auth.signUp({
        email, password,
        options: { data: { full_name: name.trim() } }
      });
      if (error) {
        let msg = error.message;
        if (msg.includes("already registered") || msg.includes("already been registered")) msg = "Bu e-posta adresi zaten kayitli. Giris yapmayi deneyin.";
        else if (msg.includes("invalid") && msg.includes("email")) msg = "Gecersiz e-posta adresi.";
        else if (msg.includes("Password")) msg = "Sifre en az 6 karakter olmalidir.";
        toast("Kayit hatasi: " + msg);
        return false;
      }
      if (data.user && !data.session) {
        if (!data.user.identities || data.user.identities.length === 0) {
          toast("Bu e-posta adresi zaten kayitli. Lutfen giris yapmayi deneyin.");
          return false;
        }
        toast("Kayit basarili! Lutfen e-postanizi dogrulayin.");
        return true;
      }
      toast("Kayit basarili! Giris yapiliyor...");
      return true;
    } catch (err) {
      toast("Kayit sirasinda bir hata olustu: " + err.message);
      return false;
    }
  },

  async logout() {
    await supabaseClient.auth.signOut();
    this.currentUser = null;
    this.updateUI();
    window.location.reload();
  },

  updateUI() {
    const user = this.currentUser;
    if (user) {
      if ($("authGuest")) $("authGuest").style.display = "none";
      if ($("authUser")) $("authUser").style.display = "flex";
      if ($("userTokens")) $("userTokens").textContent = user.tokens;
      if ($("dropdownName")) $("dropdownName").textContent = user.name;
      if ($("dropdownEmail")) $("dropdownEmail").textContent = user.email;
      if ($("userInitials")) $("userInitials").textContent = (user.name || "U")[0].toUpperCase();
    } else {
      if ($("authGuest")) $("authGuest").style.display = "flex";
      if ($("authUser")) $("authUser").style.display = "none";
    }
  }
};

/* ── Card Click Handler ── */
function handleCardClick(e) {
  const card = e.currentTarget;
  const url = card.dataset.url;
  const lang = document.documentElement.lang === "en" ? "en" : "tr";

  // Forum: ucretsiz erisim, sadece login gerekli, token gerekmez
  if (url && url.includes("forum.html")) {
    if (!AuthService.currentUser) {
      Modals.open("loginModal");
      toast(lang === "tr" ? "Önce giriş yapmalısınız." : "Please login first.");
      return;
    }
    window.location.href = url;
    return;
  }

  if (!AuthService.currentUser) {
    Modals.open("loginModal");
    toast(lang === "tr" ? "Önce giriş yapmalısınız." : "Please login first.");
    return;
  }

  if (AuthService.currentUser.tokens < 1) {
    Modals.open("buyTokensModal");
    return;
  }

  window.location.href = url;
}

/* ── Modals ── */
const Modals = {
  open(id) {
    const m = $(id);
    const o = $("modalOverlay");
    if (m && o) {
      o.style.display = "block";
      m.classList.add("is-visible");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          m.classList.add("is-open");
        });
      });
    }
  },
  closeAll() {
    const overlay = $("modalOverlay");
    if (overlay) overlay.style.display = "none";
    document.querySelectorAll(".modal").forEach(m => {
      m.classList.remove("is-open");
      m.classList.remove("is-visible");
    });
  }
};

/* ── Theme ── */
function setTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const moonIcon = document.querySelector('.icon-moon');
  const sunIcon = document.querySelector('.icon-sun');
  if (moonIcon && sunIcon) {
    moonIcon.style.display = theme === 'dark' ? 'none' : 'block';
    sunIcon.style.display = theme === 'dark' ? 'block' : 'none';
  }
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
}

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  setTheme(current === "dark" ? "light" : "dark");
}

/* ── Language ── */
const UI = {
  tr: {
    title: "YTConsole",
    subtitle: "YouTube Araçları",
    heroTitle: "YouTube İçerik Üreticileri İçin",
    heroSubtitle: "Araçlarımız ile içeriklerinizi kolayca oluşturun ve analiz edin",
    login: "Giriş Yap",
    register: "Kayıt Ol",
    logout: "Çıkış Yap",
    buyTokens: "Token Satın Al",
    privacy: "Gizlilik Politikası",
    terms: "Kullanım Şartları",
    // Tool cards
    toolPost: "YT Gönderi Uzmanı",
    toolPostDesc: "Video içeriklerinden YouTube topluluk gönderileri oluşturun",
    toolVideo: "Video Analizi",
    toolVideoDesc: "Videolarınızın performansını detaylı şekilde analiz edin",
    toolChannel: "Kanal Analizi",
    toolChannelDesc: "Kanal istatistiklerini karşılaştırın ve büyüme takibi yapın",
    toolTitlePipe: "Video Başlık Üretim Hattı",
    toolTitlePipeDesc: "Başlık ve açıklama odaklı üretim adımlarını doğrudan açın",
    toolThumbPipe: "Thumbnail Üretim Hattı",
    toolThumbPipeDesc: "Thumbnail hazırlama, yükleme ve kontrol adımlarını açın",
    toolProd: "Video Üretim Hattı",
    toolProdDesc: "Video üretim sürecinizi planlayın ve otomatikleştirin",
    toolPipe: "Pipeline",
    toolPipeDesc: "İçerik üretim pipeline'ınızı yönetin ve takip edin",
    toolRivals: "Rakipler",
    toolRivalsDesc: "Rakip kanalları analiz edin ve karşılaştırın",
    toolScript: "Script Yazımı",
    toolScriptDesc: "Video scriptlerinizi yapay zeka ile kolayca oluşturun",
    toolForum: "Forum",
    toolForumDesc: "Diğer içerik üreticileri ile deneyimlerinizi paylaşın",
    // Auth modals
    loginTitle: "Giriş Yap",
    registerTitle: "Kayıt Ol",
    emailLabel: "E-posta",
    passwordLabel: "Şifre",
    nameLabel: "Ad Soyad",
    loginSubmit: "Giriş Yap",
    registerSubmit: "Hesap Oluştur",
    noAccount: "Hesabın yok mu?",
    hasAccount: "Zaten üye misin?",
    // Buy tokens
    buyTokensTitle: "Token Satın Al",
    buyTokensSubtitle: "Shopier ile güvenli ödeme yaparak token satın alın.",
    howItWorks: "Nasıl çalışır?",
    step1: "1. Paket seçin, Shopier'e yönlendirileceksiniz",
    step2: '2. Sipariş notuna <strong style="color: var(--accent);">uygulama e-posta adresinizi</strong> yazın',
    step3: "3. Ödeme sonrası tokenler otomatik yüklenir",
    securePayment: 'Güvenli ödeme altyapısı: <strong>Shopier.com</strong>',
    copyEmail: "E-postayı Kopyala",
    shopierLoading: "Shopier yükleniyor...",
    shopierEmailNotice: "Sipariş notuna e-posta adresinizi yazın:"
  },
  en: {
    title: "YTConsole",
    subtitle: "YouTube Tools",
    heroTitle: "For YouTube Content Creators",
    heroSubtitle: "Create and analyze your content easily with our tools",
    login: "Login",
    register: "Sign Up",
    logout: "Logout",
    buyTokens: "Buy Tokens",
    privacy: "Privacy Policy",
    terms: "Terms of Use",
    // Tool cards
    toolPost: "YT Post Expert",
    toolPostDesc: "Create YouTube community posts from video content",
    toolVideo: "Video Analysis",
    toolVideoDesc: "Analyze your video performance in detail",
    toolChannel: "Channel Analysis",
    toolChannelDesc: "Compare channel stats and track growth",
    toolTitlePipe: "Video Title Production Line",
    toolTitlePipeDesc: "Jump directly into title and description production steps",
    toolThumbPipe: "Thumbnail Production Line",
    toolThumbPipeDesc: "Open thumbnail prep, upload and quality-check steps",
    toolProd: "Video Production Line",
    toolProdDesc: "Plan and automate your video production process",
    toolPipe: "Pipeline",
    toolPipeDesc: "Manage and track your content production pipeline",
    toolRivals: "Competitors",
    toolRivalsDesc: "Analyze and compare competitor channels",
    toolScript: "Script Writing",
    toolScriptDesc: "Create video scripts easily with AI",
    toolForum: "Forum",
    toolForumDesc: "Share your experiences with other content creators",
    // Auth modals
    loginTitle: "Login",
    registerTitle: "Sign Up",
    emailLabel: "Email",
    passwordLabel: "Password",
    nameLabel: "Full Name",
    loginSubmit: "Login",
    registerSubmit: "Create Account",
    noAccount: "Don't have an account?",
    hasAccount: "Already a member?",
    // Buy tokens
    buyTokensTitle: "Buy Tokens",
    buyTokensSubtitle: "Purchase tokens securely via Shopier.",
    howItWorks: "How does it work?",
    step1: "1. Select a package, you'll be redirected to Shopier",
    step2: '2. Write your <strong style="color: var(--accent);">app email address</strong> in order notes',
    step3: "3. Tokens are automatically loaded after payment",
    securePayment: 'Secure payment: <strong>Shopier.com</strong>',
    copyEmail: "Copy Email",
    shopierLoading: "Loading Shopier...",
    shopierEmailNotice: "Write your email in order notes:"
  }
};

let currentLang = "tr";

function setLanguage(lang) {
  currentLang = lang;
  document.documentElement.lang = lang;
  const t = UI[lang];

  $("langTr").classList.toggle("is-active", lang === "tr");
  $("langEn").classList.toggle("is-active", lang === "en");

  // Header
  $("dashboardTitle").textContent = t.title;
  $("dashboardSubtitle").textContent = t.subtitle;

  // Hero
  $("heroTitle").textContent = t.heroTitle;
  $("heroSubtitle").textContent = t.heroSubtitle;

  // Auth buttons
  $("loginBtn").textContent = t.login;
  $("registerBtn").textContent = t.register;
  if ($("logoutBtnText")) $("logoutBtnText").textContent = t.logout;
  if ($("buyTokensText")) $("buyTokensText").textContent = t.buyTokens;

  // Footer
  if ($("privacyLink")) $("privacyLink").textContent = t.privacy;
  if ($("termsLink")) $("termsLink").textContent = t.terms;

  // Tool cards
  if ($("toolPostTitle")) $("toolPostTitle").textContent = t.toolPost;
  if ($("toolPostDesc")) $("toolPostDesc").textContent = t.toolPostDesc;
  if ($("toolVideoTitle")) $("toolVideoTitle").textContent = t.toolVideo;
  if ($("toolVideoDesc")) $("toolVideoDesc").textContent = t.toolVideoDesc;
  if ($("toolChannelTitle")) $("toolChannelTitle").textContent = t.toolChannel;
  if ($("toolChannelDesc")) $("toolChannelDesc").textContent = t.toolChannelDesc;
  if ($("toolTitlePipeTitle")) $("toolTitlePipeTitle").textContent = t.toolTitlePipe;
  if ($("toolTitlePipeDesc")) $("toolTitlePipeDesc").textContent = t.toolTitlePipeDesc;
  if ($("toolThumbPipeTitle")) $("toolThumbPipeTitle").textContent = t.toolThumbPipe;
  if ($("toolThumbPipeDesc")) $("toolThumbPipeDesc").textContent = t.toolThumbPipeDesc;
  if ($("toolProdTitle")) $("toolProdTitle").textContent = t.toolProd;
  if ($("toolProdDesc")) $("toolProdDesc").textContent = t.toolProdDesc;
  if ($("toolPipeTitle")) $("toolPipeTitle").textContent = t.toolPipe;
  if ($("toolPipeDesc")) $("toolPipeDesc").textContent = t.toolPipeDesc;
  if ($("toolRivalsTitle")) $("toolRivalsTitle").textContent = t.toolRivals;
  if ($("toolRivalsDesc")) $("toolRivalsDesc").textContent = t.toolRivalsDesc;
  if ($("toolScriptTitle")) $("toolScriptTitle").textContent = t.toolScript;
  if ($("toolScriptDesc")) $("toolScriptDesc").textContent = t.toolScriptDesc;
  if ($("toolForumTitle")) $("toolForumTitle").textContent = t.toolForum;
  if ($("toolForumDesc")) $("toolForumDesc").textContent = t.toolForumDesc;

  // Auth modals
  if ($("loginModalTitle")) $("loginModalTitle").textContent = t.loginTitle;
  if ($("registerModalTitle")) $("registerModalTitle").textContent = t.registerTitle;
  if ($("loginEmailLabel")) $("loginEmailLabel").textContent = t.emailLabel;
  if ($("loginPasswordLabel")) $("loginPasswordLabel").textContent = t.passwordLabel;
  if ($("loginSubmitBtn")) $("loginSubmitBtn").textContent = t.loginSubmit;
  if ($("regNameLabel")) $("regNameLabel").textContent = t.nameLabel;
  if ($("regEmailLabel")) $("regEmailLabel").textContent = t.emailLabel;
  if ($("regPasswordLabel")) $("regPasswordLabel").textContent = t.passwordLabel;
  if ($("regSubmitBtn")) $("regSubmitBtn").textContent = t.registerSubmit;
  if ($("loginFooterText")) $("loginFooterText").innerHTML = t.noAccount + ' <a href="#" id="swToRegister">' + t.register + '</a>';
  if ($("registerFooterText")) $("registerFooterText").innerHTML = t.hasAccount + ' <a href="#" id="swToLogin">' + t.login + '</a>';

  // Buy tokens modal
  if ($("buyTokensTitle")) $("buyTokensTitle").textContent = t.buyTokensTitle;
  if ($("buyTokensSubtitle")) $("buyTokensSubtitle").textContent = t.buyTokensSubtitle;
  if ($("howItWorksTitle")) $("howItWorksTitle").textContent = t.howItWorks;
  if ($("step1Text")) $("step1Text").textContent = t.step1;
  if ($("step2Text")) $("step2Text").innerHTML = t.step2;
  if ($("step3Text")) $("step3Text").textContent = t.step3;
  if ($("securePaymentText")) $("securePaymentText").innerHTML = t.securePayment;
  if ($("copyEmailText")) $("copyEmailText").textContent = t.copyEmail;
  if ($("shopierLoadingText")) $("shopierLoadingText").textContent = t.shopierLoading;

  // Re-bind switcher links after innerHTML replacement
  bindSwitchers();

  try { localStorage.setItem(LANG_KEY, lang); } catch {}
}

function bindSwitchers() {
  const sw1 = $("swToRegister");
  const sw2 = $("swToLogin");
  if (sw1) {
    sw1.addEventListener("click", (e) => {
      e.preventDefault();
      Modals.closeAll();
      setTimeout(() => Modals.open("registerModal"), 50);
    });
  }
  if (sw2) {
    sw2.addEventListener("click", (e) => {
      e.preventDefault();
      Modals.closeAll();
      setTimeout(() => Modals.open("loginModal"), 50);
    });
  }
}

/* ── Shopier Checkout ── */
const SHOPIER_URLS = {
  100: "https://www.shopier.com/bymilyoner/44335263",
  500: "https://www.shopier.com/bymilyoner/44335254",
  1000: "https://www.shopier.com/bymilyoner/44335234",
};

const ShopierCheckout = {
  open(tokens) {
    const url = SHOPIER_URLS[tokens];
    if (!url) return;

    const overlay = $("shopierCheckoutOverlay");
    const iframe = $("shopierIframe");
    const loading = $("shopierIframeLoading");
    const emailEl = $("shopierUserEmail");
    const pkgNameEl = $("shopierCheckoutPkgName");

    const email = AuthService.currentUser?.email || "";
    if (emailEl) emailEl.textContent = email;
    if (pkgNameEl) pkgNameEl.textContent = `${tokens} Token`;

    if (loading) loading.style.display = "flex";
    if (iframe) {
      iframe.src = url;
      iframe.onload = () => { if (loading) loading.style.display = "none"; };
    }

    if (overlay) {
      overlay.style.display = "flex";
      document.body.style.overflow = "hidden";
    }

    if (email) {
      navigator.clipboard.writeText(email).catch(() => {});
    }

    Modals.closeAll();
    ShopierPolling.start();
  },

  close() {
    const overlay = $("shopierCheckoutOverlay");
    const iframe = $("shopierIframe");
    if (overlay) overlay.style.display = "none";
    if (iframe) iframe.src = "about:blank";
    document.body.style.overflow = "";
    ShopierPolling.stop();
  }
};

const ShopierPolling = {
  _interval: null,
  _initialBalance: 0,
  _attempts: 0,
  _maxAttempts: 60,

  start() {
    this.stop();
    if (!AuthService.currentUser) return;
    this._initialBalance = AuthService.currentUser.tokens;
    this._attempts = 0;
    this._interval = setInterval(() => this._check(), 5000);
  },

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  },

  async _check() {
    this._attempts++;
    if (this._attempts >= this._maxAttempts || !AuthService.currentUser) {
      this.stop();
      return;
    }
    try {
      await AuthService.fetchProfile(AuthService.currentUser.id);
      if (AuthService.currentUser.tokens > this._initialBalance) {
        const added = AuthService.currentUser.tokens - this._initialBalance;
        toast(`${added} Token hesabiniza eklendi!`);
        ShopierCheckout.close();
        this.stop();
      }
    } catch (e) {
      // Silently retry
    }
  }
};

/* ── Wire Events ── */
function wire() {
  // Language
  $("langTr").addEventListener("click", () => setLanguage("tr"));
  $("langEn").addEventListener("click", () => setLanguage("en"));

  // Theme
  $("themeToggle").addEventListener("click", toggleTheme);

  // Tool Cards
  document.querySelectorAll(".tool-card").forEach(card => {
    card.addEventListener("click", handleCardClick);
    card.style.cursor = "pointer";
  });

  // Auth - Login
  $("loginBtn").addEventListener("click", () => Modals.open("loginModal"));
  $("loginClose").addEventListener("click", Modals.closeAll);

  // Auth - Register
  $("registerBtn").addEventListener("click", () => Modals.open("registerModal"));
  $("registerClose").addEventListener("click", Modals.closeAll);

  // Buy tokens
  if ($("buyTokensBtn")) {
    $("buyTokensBtn").addEventListener("click", () => {
      if ($("userDropdown")) $("userDropdown").classList.remove("is-open");
      Modals.open("buyTokensModal");
    });
  }
  if ($("buyTokensClose")) {
    $("buyTokensClose").addEventListener("click", Modals.closeAll);
  }

  // Switchers (Login <-> Register)
  bindSwitchers();

  // Login form
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    try {
      submitBtn.disabled = true;
      submitBtn.textContent = currentLang === "tr" ? "Giriş yapılıyor..." : "Logging in...";
      const ok = await AuthService.login($("loginEmail").value, $("loginPassword").value);
      if (ok) {
        e.target.reset();
        Modals.closeAll();
        toast(currentLang === "tr" ? "Giriş yapıldı" : "Logged in");
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  // Register form
  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    try {
      submitBtn.disabled = true;
      submitBtn.textContent = currentLang === "tr" ? "Hesap oluşturuluyor..." : "Creating account...";
      const ok = await AuthService.register($("regName").value, $("regEmail").value, $("regPassword").value);
      if (ok) {
        e.target.reset();
        Modals.closeAll();
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  // User dropdown
  if ($("userProfileBtn")) {
    $("userProfileBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      if ($("userDropdown")) $("userDropdown").classList.toggle("is-open");
    });
  }

  document.addEventListener("click", () => {
    if ($("userDropdown")) $("userDropdown").classList.remove("is-open");
  });

  // Logout
  if ($("logoutBtn")) {
    $("logoutBtn").addEventListener("click", () => AuthService.logout());
  }

  // Modal overlay close
  $("modalOverlay").addEventListener("click", Modals.closeAll);

  // ESC key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      Modals.closeAll();
      if ($("userDropdown")) $("userDropdown").classList.remove("is-open");
      if ($("shopierCheckoutOverlay") && $("shopierCheckoutOverlay").style.display === "flex") {
        ShopierCheckout.close();
      }
    }
  });

  // Password toggles
  document.querySelectorAll(".password-toggle").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetId = btn.getAttribute("data-target");
      const input = $(targetId);
      if (!input) return;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      const eyeOpen = btn.querySelector(".eye-open");
      const eyeClosed = btn.querySelector(".eye-closed");
      if (eyeOpen && eyeClosed) {
        eyeOpen.style.display = isPassword ? "none" : "block";
        eyeClosed.style.display = isPassword ? "block" : "none";
      }
    });
  });

  // Shopier checkout close
  if ($("shopierCheckoutClose")) {
    $("shopierCheckoutClose").addEventListener("click", () => ShopierCheckout.close());
  }

  if ($("shopierCheckoutOverlay")) {
    $("shopierCheckoutOverlay").addEventListener("click", (e) => {
      if (e.target === $("shopierCheckoutOverlay")) ShopierCheckout.close();
    });
  }

  // Copy email
  if ($("shopierCopyEmail")) {
    $("shopierCopyEmail").addEventListener("click", () => {
      const email = AuthService.currentUser?.email || "";
      if (!email) return;
      navigator.clipboard.writeText(email).then(() => {
        const btn = $("shopierCopyEmail");
        btn.classList.add("copied");
        const span = btn.querySelector("span");
        const origText = span.textContent;
        span.textContent = currentLang === "tr" ? "Kopyalandı!" : "Copied!";
        setTimeout(() => {
          btn.classList.remove("copied");
          span.textContent = origText;
        }, 2000);
      });
    });
  }

  // Package cards -> open Shopier checkout
  document.querySelectorAll(".package-card").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const amount = parseInt(link.dataset.tokens, 10);
      ShopierCheckout.open(amount);
    });
  });
}

/* ── Init ── */
function init() {
  // Theme
  const storedTheme = getStoredTheme();
  if (storedTheme) {
    setTheme(storedTheme);
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    setTheme("dark");
  } else {
    setTheme("light");
  }

  // Language
  let savedLang;
  try { savedLang = localStorage.getItem(LANG_KEY); } catch {}
  setLanguage(savedLang === "en" ? "en" : "tr");

  // Auth
  AuthService.init();

  // Wire events
  wire();

  // Animated dashboard background
  initBackgroundPaths();
}

init();
