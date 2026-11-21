'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// Render gibi sunucularda kalıcı disk yolu DATA_DIR ile verilir (örn. /var/data)
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'forum.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT,
  role TEXT NOT NULL DEFAULT 'uye',
  bio TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_post_at INTEGER NOT NULL,
  last_post_user INTEGER,
  reply_count INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS presence (
  vkey TEXT PRIMARY KEY,
  user_id INTEGER,
  last_seen INTEGER NOT NULL,
  location TEXT,
  url TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE INDEX IF NOT EXISTS ix_threads_cat ON threads(category_id, pinned DESC, last_post_at DESC);
CREATE INDEX IF NOT EXISTS ix_threads_last ON threads(last_post_at DESC);
CREATE INDEX IF NOT EXISTS ix_posts_thread ON posts(thread_id, id);
CREATE INDEX IF NOT EXISTS ix_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS ix_presence_seen ON presence(last_seen);
`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const getMetaStmt = db.prepare('SELECT v FROM meta WHERE k = ?');
const setMetaStmt = db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
const getMeta = (k) => { const r = getMetaStmt.get(k); return r ? r.v : null; };
const setMeta = (k, v) => setMetaStmt.run(k, v);

// ---- İlk kurulum: bölümler, kategoriler, hoş geldin konusu ----
function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM sections').get().c > 0) return;

  const sections = [
    ['Genel', [
      ['duyurular', '📢', 'Duyurular ve Kurallar', 'Forum duyuruları, güncellemeler ve kurallar.'],
      ['tanisma', '👋', 'Tanışma ve Genel Sohbet', 'Kendini tanıt, sohbet et, toplulukla kaynaş.'],
      ['kanal-tanitim', '📺', 'Kanal Tanıtımı', 'Kanalını tanıt, diğer üreticilerden geri bildirim al.'],
    ]],
    ['Kanal Büyütme', [
      ['kanal-stratejileri', '🚀', 'Kanal Stratejileri ve Büyüme', 'Abone kazanma, niş seçimi, yükleme düzeni.'],
      ['seo', '🔎', 'SEO, Başlık ve Etiketler', 'Arama, öneriler, başlık ve açıklama optimizasyonu.'],
      ['thumbnail', '🖼️', 'Thumbnail ve Kapak Tasarımı', 'Tıklanma oranını artıran kapak görselleri.'],
      ['analitik', '📊', 'Analitik ve İstatistikler', 'İzlenme süresi, TO, kitle verilerini yorumlama.'],
    ]],
    ['İçerik Üretimi', [
      ['video-duzenleme', '🎬', 'Video Düzenleme ve Kurgu', 'Premiere, DaVinci, CapCut ve kurgu teknikleri.'],
      ['senaryo', '✍️', 'Senaryo ve İçerik Fikirleri', 'Fikir bulma, hikâye kurma, giriş (hook) yazma.'],
      ['ekipman', '🎙️', 'Ekipman: Kamera, Mikrofon, Işık', 'Donanım önerileri ve kurulum tavsiyeleri.'],
      ['yapay-zeka', '🤖', 'YouTube ve Yapay Zeka', 'Yapay zeka araçları, otomasyon ve iş akışları.'],
    ]],
    ['Para Kazanma', [
      ['para-kazanma', '💰', 'YPP ve Para Kazanma', 'İş Ortağı Programı, RPM, gelir kaynakları.'],
      ['sponsorluk', '🤝', 'Sponsorluk ve İş Birlikleri', 'Marka anlaşmaları, fiyatlandırma, sözleşmeler.'],
      ['telif', '⚖️', 'Telif Hakkı ve Topluluk Kuralları', 'Telif hakkı, uyarılar, itirazlar ve kanal güvenliği.'],
    ]],
    ['Pazar Yeri', [
      ['hizmet', '🛠️', 'Hizmet Satışı', 'Kurgu, thumbnail, seslendirme ve diğer hizmetler.'],
      ['is-ilanlari', '📋', 'İş İlanları ve Ekip Arayanlar', 'Editör, tasarımcı, senarist arayanlar burada.'],
    ]],
  ];

  tx(() => {
    const insSec = db.prepare('INSERT INTO sections(name, sort) VALUES(?, ?)');
    const insCat = db.prepare('INSERT INTO categories(section_id, slug, icon, name, description, sort) VALUES(?,?,?,?,?,?)');
    sections.forEach(([name, cats], i) => {
      const sid = insSec.run(name, i).lastInsertRowid;
      cats.forEach(([slug, icon, cname, desc], j) => insCat.run(sid, slug, icon, cname, desc, j));
    });

    const now = Date.now();
    const sys = db.prepare("INSERT INTO users(username, pass, role, bio, created_at) VALUES('ytconsole', NULL, 'admin', 'Forumun resmi hesabı.', ?)").run(now).lastInsertRowid;
    const cat = db.prepare("SELECT id FROM categories WHERE slug = 'duyurular'").get().id;
    const tid = db.prepare('INSERT INTO threads(category_id, user_id, title, created_at, last_post_at, last_post_user, pinned, locked) VALUES(?,?,?,?,?,?,1,1)')
      .run(cat, sys, "ytconsole'a hoş geldiniz! (Kurallar)", now, now, sys).lastInsertRowid;
    db.prepare('INSERT INTO posts(thread_id, user_id, body, created_at) VALUES(?,?,?,?)').run(tid, sys,
`Merhaba ve hoş geldin!

ytconsole, YouTube içerik üreticilerinin bilgi paylaştığı, soru sorduğu ve birlikte büyüdüğü bir topluluk. Burada her şey ücretsiz.

Kısa kurallar:
1. Saygılı ol. Hakaret, küfür ve kişisel saldırı yasak.
2. Konunu doğru kategoriye aç, açmadan önce arama yap.
3. Spam, abone/izlenme takası ve sahte etkileşim satışı yasak.
4. Reklam ve hizmet satışı sadece "Pazar Yeri" bölümünde.
5. Başlıkları açıklayıcı yaz: "Yardım!!" yerine "Shorts izlenmeleri neden düştü?"

İpuçları:
> Bir mesajı alıntılamak için satırın başına > koy.
Mesajına bir YouTube bağlantısı eklersen video otomatik olarak gömülür.

Faydalı bulduğun mesajlara "Faydalı" ver, en çok katkı yapan üyeler ana sayfada görünür.

İyi forumlar!`, now);
  });
}
seed();

module.exports = { db, tx, getMeta, setMeta };
