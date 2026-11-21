'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, tx, getMeta, setMeta } = require('./db');
const h = require('./helpers');

const PORT = Number(process.env.PORT) || 3000;
const ONLINE_WINDOW = 5 * 60 * 1000;          // son 5 dk içinde aktif olan = çevrimiçi
const SESSION_MS = 30 * 24 * 3600 * 1000;
const THREADS_PER_PAGE = 25;
const POSTS_PER_PAGE = 20;
const FLOOD_MS = 15 * 1000;
// Render (ve benzeri) HTTPS proxy arkasında çalışır: gerçek IP'yi al, çerezleri Secure yap
const BEHIND_PROXY = !!process.env.RENDER || process.env.TRUST_PROXY === '1';
const SECURE_COOKIES = BEHIND_PROXY || process.env.NODE_ENV === 'production';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', BEHIND_PROXY ? 1 : 'loopback');
app.disable('x-powered-by');
// Sağlık kontrolü: çevrimiçi sayacına ziyaretçi olarak yazılmaz
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ---------- Sorgular ----------
const S = (sql) => db.prepare(sql);
const q = {
  sessionUser: S('SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?'),
  insSession: S('INSERT INTO sessions(token, user_id, expires) VALUES(?,?,?)'),
  delSession: S('DELETE FROM sessions WHERE token = ?'),
  userByName: S('SELECT * FROM users WHERE username = ?'),
  realUserCount: S('SELECT COUNT(*) AS c FROM users WHERE pass IS NOT NULL'),
  insUser: S('INSERT INTO users(username, pass, role, created_at, last_seen) VALUES(?,?,?,?,?)'),
  userSeen: S('UPDATE users SET last_seen = ? WHERE id = ?'),
  updProfile: S('UPDATE users SET bio = ?, channel = ? WHERE id = ?'),

  upsertPresence: S(`INSERT INTO presence(vkey, user_id, last_seen, location, url) VALUES(?,?,?,?,?)
    ON CONFLICT(vkey) DO UPDATE SET user_id = excluded.user_id, last_seen = excluded.last_seen, location = excluded.location, url = excluded.url`),
  touchPresence: S('UPDATE presence SET last_seen = ? WHERE vkey = ?'),
  delPresence: S('DELETE FROM presence WHERE vkey = ?'),
  onlineMembers: S(`SELECT u.id, u.username, u.role, p.location, p.url, p.last_seen FROM presence p JOIN users u ON u.id = p.user_id
    WHERE p.last_seen > ? ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'mod' THEN 1 ELSE 2 END, u.username COLLATE NOCASE`),
  onlineGuests: S('SELECT COUNT(*) AS c FROM presence WHERE user_id IS NULL AND last_seen > ?'),
  onlineGuestList: S('SELECT location, url, last_seen FROM presence WHERE user_id IS NULL AND last_seen > ? ORDER BY last_seen DESC LIMIT 100'),

  sections: S('SELECT * FROM sections ORDER BY sort'),
  allCategories: S('SELECT id, slug, name, icon FROM categories ORDER BY section_id, sort'),
  categoriesWithStats: S(`SELECT c.*,
      (SELECT COUNT(*) FROM threads t WHERE t.category_id = c.id) AS thread_count,
      (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.category_id = c.id) AS post_count,
      lt.id AS last_id, lt.title AS last_title, lt.last_post_at AS last_at, lu.username AS last_user
    FROM categories c
    LEFT JOIN threads lt ON lt.id = (SELECT id FROM threads WHERE category_id = c.id ORDER BY last_post_at DESC LIMIT 1)
    LEFT JOIN users lu ON lu.id = lt.last_post_user
    ORDER BY c.section_id, c.sort`),
  categoryBySlug: S('SELECT * FROM categories WHERE slug = ?'),
  categoryById: S('SELECT * FROM categories WHERE id = ?'),

  countThreadsInCat: S('SELECT COUNT(*) AS c FROM threads WHERE category_id = ?'),
  threadsInCat: S(`SELECT t.*, u.username AS author, lu.username AS last_user, c.name AS cat_name, c.slug AS cat_slug
    FROM threads t JOIN users u ON u.id = t.user_id LEFT JOIN users lu ON lu.id = t.last_post_user JOIN categories c ON c.id = t.category_id
    WHERE t.category_id = ? ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`),
  latestThreads: S(`SELECT t.*, u.username AS author, lu.username AS last_user, c.name AS cat_name, c.slug AS cat_slug
    FROM threads t JOIN users u ON u.id = t.user_id LEFT JOIN users lu ON lu.id = t.last_post_user JOIN categories c ON c.id = t.category_id
    ORDER BY t.last_post_at DESC LIMIT ? OFFSET ?`),
  countAllThreads: S('SELECT COUNT(*) AS c FROM threads'),
  threadById: S(`SELECT t.*, c.name AS cat_name, c.slug AS cat_slug, c.icon AS cat_icon FROM threads t JOIN categories c ON c.id = t.category_id WHERE t.id = ?`),
  incViews: S('UPDATE threads SET views = views + 1 WHERE id = ?'),
  insThread: S('INSERT INTO threads(category_id, user_id, title, created_at, last_post_at, last_post_user) VALUES(?,?,?,?,?,?)'),
  setPinned: S('UPDATE threads SET pinned = ? WHERE id = ?'),
  setLocked: S('UPDATE threads SET locked = ? WHERE id = ?'),
  setTitle: S('UPDATE threads SET title = ? WHERE id = ?'),
  delThread: S('DELETE FROM threads WHERE id = ?'),
  recompute: S(`UPDATE threads SET
      reply_count = (SELECT COUNT(*) - 1 FROM posts WHERE thread_id = threads.id),
      last_post_at = COALESCE((SELECT MAX(created_at) FROM posts WHERE thread_id = threads.id), created_at),
      last_post_user = (SELECT user_id FROM posts WHERE thread_id = threads.id ORDER BY id DESC LIMIT 1)
    WHERE id = ?`),

  countPosts: S('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ?'),
  postsInThread: S(`SELECT p.*, u.username, u.role, u.created_at AS joined, u.last_seen AS user_seen, u.channel,
      (SELECT COUNT(*) FROM posts x WHERE x.user_id = u.id) AS post_count,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id WHERE p.thread_id = ? ORDER BY p.id LIMIT ? OFFSET ?`),
  postById: S('SELECT * FROM posts WHERE id = ?'),
  firstPostId: S('SELECT MIN(id) AS id FROM posts WHERE thread_id = ?'),
  postIndex: S('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND id <= ?'),
  insPost: S('INSERT INTO posts(thread_id, user_id, body, created_at) VALUES(?,?,?,?)'),
  updPost: S('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?'),
  delPost: S('DELETE FROM posts WHERE id = ?'),
  lastPostByUser: S('SELECT MAX(created_at) AS t FROM posts WHERE user_id = ?'),

  hasLike: S('SELECT 1 AS x FROM likes WHERE post_id = ? AND user_id = ?'),
  insLike: S('INSERT INTO likes(post_id, user_id) VALUES(?,?)'),
  delLike: S('DELETE FROM likes WHERE post_id = ? AND user_id = ?'),
  likeCount: S('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?'),
  topHelpers: S(`SELECT u.username, COUNT(*) AS likes FROM likes l JOIN posts p ON p.id = l.post_id JOIN users u ON u.id = p.user_id
    WHERE l.user_id <> p.user_id GROUP BY u.id ORDER BY likes DESC LIMIT 5`),

  stats: S(`SELECT (SELECT COUNT(*) FROM threads) AS threads, (SELECT COUNT(*) FROM posts) AS posts,
      (SELECT COUNT(*) FROM users WHERE pass IS NOT NULL) AS users,
      (SELECT username FROM users WHERE pass IS NOT NULL ORDER BY id DESC LIMIT 1) AS newest`),

  profile: S(`SELECT u.*, (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS post_count,
      (SELECT COUNT(*) FROM threads WHERE user_id = u.id) AS thread_count,
      (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = u.id AND l.user_id <> u.id) AS like_count
    FROM users u WHERE u.username = ?`),
  userThreads: S(`SELECT t.*, u.username AS author, lu.username AS last_user, c.name AS cat_name, c.slug AS cat_slug
    FROM threads t JOIN users u ON u.id = t.user_id LEFT JOIN users lu ON lu.id = t.last_post_user JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 15`),
  userPosts: S(`SELECT p.id, p.body, p.created_at, t.id AS tid, t.title FROM posts p JOIN threads t ON t.id = p.thread_id
    WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 10`),
  members: S(`SELECT u.username, u.role, u.created_at, u.last_seen, (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS post_count
    FROM users u WHERE u.pass IS NOT NULL OR u.role = 'admin' ORDER BY post_count DESC, u.id LIMIT 200`),

  search: S(`SELECT DISTINCT t.*, u.username AS author, lu.username AS last_user, c.name AS cat_name, c.slug AS cat_slug
    FROM threads t JOIN users u ON u.id = t.user_id LEFT JOIN users lu ON lu.id = t.last_post_user JOIN categories c ON c.id = t.category_id
    LEFT JOIN posts p ON p.thread_id = t.id
    WHERE t.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\'
    ORDER BY t.last_post_at DESC LIMIT 50`),
  searchUsers: S("SELECT username, role FROM users WHERE username LIKE ? ESCAPE '\\' LIMIT 10"),

  cleanPresence: S('DELETE FROM presence WHERE last_seen < ?'),
  cleanSessions: S('DELETE FROM sessions WHERE expires < ?'),
};

// ---------- Yardımcılar ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* yoksay */ } }
  }
  return out;
}
function setCookie(res, name, val, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIES ? '; Secure' : ''}`);
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [, salt, hex] = stored.split('$');
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const isMod = (u) => !!u && (u.role === 'admin' || u.role === 'mod');
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const clampPage = (v, pages) => Math.min(Math.max(1, toInt(v) || 1), pages);
const safeRedirect = (r) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : '/');
const str = (v) => (typeof v === 'string' ? v : '');

// ---------- Çevrimiçi takibi ----------
function track(req, label, url) {
  const now = Date.now();
  if (req.user) {
    q.upsertPresence.run('u' + req.user.id, req.user.id, now, label, url);
    q.delPresence.run('g' + req.vid);
    q.userSeen.run(now, req.user.id);
  } else {
    q.upsertPresence.run('g' + req.vid, null, now, label, url);
  }
}

function onlineStats() {
  const since = Date.now() - ONLINE_WINDOW;
  const members = q.onlineMembers.all(since);
  const guests = q.onlineGuests.get(since).c;
  const total = members.length + guests;
  let record = null;
  try { record = JSON.parse(getMeta('record_online')); } catch { /* yoksay */ }
  if (!record || total > record.count) {
    record = { count: total, at: Date.now() };
    setMeta('record_online', JSON.stringify(record));
  }
  return { members, guests, total, record };
}
const isOnline = (lastSeen) => !!lastSeen && lastSeen > Date.now() - ONLINE_WINDOW;

function forumStats() { return q.stats.get(); }

function page(req, res, view, data, label) {
  if (label) track(req, label, req.originalUrl.slice(0, 300));
  res.render(view, { title: null, ...data, online: onlineStats() });
}
function sidebarData() {
  return { stats: forumStats(), helpers: q.topHelpers.all(), latest: q.latestThreads.all(6, 0) };
}
function fail(req, res, status, message) {
  res.status(status);
  page(req, res, 'message', { title: 'Hata', heading: status === 404 ? 'Sayfa bulunamadı' : 'Bir sorun oluştu', message }, null);
}
const notFound = (req, res) => fail(req, res, 404, 'Aradığın sayfa taşınmış ya da silinmiş olabilir.');

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect('/giris?r=' + encodeURIComponent(req.originalUrl));
  return res.redirect('/giris');
}
function requireMod(req, res, next) {
  if (isMod(req.user)) return next();
  fail(req, res, 403, 'Bu işlem için yetkin yok.');
}

// Basit deneme sınırlayıcı (giriş / kayıt)
const attempts = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => t > now - windowMs);
  list.push(now);
  attempts.set(key, list);
  return list.length > max;
}

// ---------- Ortak ara katman ----------
app.use((req, res, next) => {
  req.cookies = parseCookies(req);
  let vid = req.cookies.vid;
  if (!vid || !/^[a-f0-9]{32}$/.test(vid)) {
    vid = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'vid', vid, 365 * 86400);
  }
  req.vid = vid;
  req.user = null;
  if (req.cookies.sid) req.user = q.sessionUser.get(req.cookies.sid, Date.now()) || null;

  if (req.method === 'POST' && req.headers.origin) {
    let ok = false;
    try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* yoksay */ }
    if (!ok) return res.status(403).send('Geçersiz istek kaynağı');
  }

  res.locals.user = req.user;
  res.locals.isMod = isMod(req.user);
  res.locals.h = h;
  res.locals.isOnline = isOnline;
  res.locals.path = req.path;
  res.locals.searchQ = '';
  next();
});

// ---------- Sayfalar ----------
app.get('/', (req, res) => {
  const cats = q.categoriesWithStats.all();
  const sections = q.sections.all().map((s) => ({ ...s, categories: cats.filter((c) => c.section_id === s.id) }));
  page(req, res, 'index', { sections, ...sidebarData() }, 'Ana sayfa');
});

app.get('/kategori/:slug', (req, res) => {
  const cat = q.categoryBySlug.get(req.params.slug);
  if (!cat) return notFound(req, res);
  const total = q.countThreadsInCat.get(cat.id).c;
  const pages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const p = clampPage(req.query.sayfa, pages);
  const threads = q.threadsInCat.all(cat.id, THREADS_PER_PAGE, (p - 1) * THREADS_PER_PAGE);
  page(req, res, 'category', { title: cat.name, cat, threads, total, page: p, pages, base: `/kategori/${cat.slug}`, ...sidebarData() }, `Kategori: ${cat.name}`);
});

app.get('/yeni-mesajlar', (req, res) => {
  const total = q.countAllThreads.get().c;
  const pages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const p = clampPage(req.query.sayfa, pages);
  const threads = q.latestThreads.all(THREADS_PER_PAGE, (p - 1) * THREADS_PER_PAGE);
  page(req, res, 'latest', { title: 'Yeni Mesajlar', threads, page: p, pages, base: '/yeni-mesajlar', ...sidebarData() }, 'Yeni mesajlara bakıyor');
});

app.get('/konu/:id', (req, res) => {
  const t = q.threadById.get(toInt(req.params.id));
  if (!t) return notFound(req, res);
  const total = q.countPosts.get(t.id).c;
  const pages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
  const p = clampPage(req.query.sayfa, pages);
  q.incViews.run(t.id);
  t.views += 1;
  const posts = q.postsInThread.all(req.user ? req.user.id : 0, t.id, POSTS_PER_PAGE, (p - 1) * POSTS_PER_PAGE);
  const firstPostId = q.firstPostId.get(t.id).id;
  page(req, res, 'thread', { title: t.title, t, posts, firstPostId, page: p, pages, base: h.threadUrl(t), offset: (p - 1) * POSTS_PER_PAGE }, `Konu: ${t.title}`);
});

app.get('/mesaj/:id', (req, res) => {
  const post = q.postById.get(toInt(req.params.id));
  if (!post) return notFound(req, res);
  const t = q.threadById.get(post.thread_id);
  const idx = q.postIndex.get(post.thread_id, post.id).c;
  const p = Math.ceil(idx / POSTS_PER_PAGE);
  res.redirect(`${h.threadUrl(t)}${p > 1 ? '?sayfa=' + p : ''}#m${post.id}`);
});

// ---------- Konu / mesaj yazma ----------
function validatePost(body) {
  const b = str(body).trim();
  if (b.length < 2) return 'Mesaj çok kısa.';
  if (b.length > 10000) return 'Mesaj en fazla 10.000 karakter olabilir.';
  return null;
}
function floodCheck(user) {
  if (isMod(user)) return null;
  const last = q.lastPostByUser.get(user.id).t;
  if (last && Date.now() - last < FLOOD_MS) return `Çok hızlı yazıyorsun. ${Math.ceil((FLOOD_MS - (Date.now() - last)) / 1000)} sn sonra tekrar dene.`;
  return null;
}

app.get('/yeni-konu', requireUser, (req, res) => {
  page(req, res, 'new-thread', { title: 'Yeni konu', categories: q.allCategories.all(), form: { kategori: str(req.query.kategori) }, error: null }, 'Yeni konu açıyor');
});

app.post('/yeni-konu', requireUser, (req, res) => {
  const form = { kategori: str(req.body.kategori), baslik: str(req.body.baslik).trim().replace(/\s+/g, ' '), mesaj: str(req.body.mesaj) };
  const cat = q.categoryBySlug.get(form.kategori);
  let error = null;
  if (!cat) error = 'Bir kategori seç.';
  else if (cat.slug === 'duyurular' && !isMod(req.user)) error = 'Duyurular kategorisine sadece yöneticiler konu açabilir.';
  else if (form.baslik.length < 5 || form.baslik.length > 120) error = 'Başlık 5 ile 120 karakter arasında olmalı.';
  else error = validatePost(form.mesaj) || floodCheck(req.user);
  if (error) {
    res.status(400);
    return page(req, res, 'new-thread', { title: 'Yeni konu', categories: q.allCategories.all(), form, error }, 'Yeni konu açıyor');
  }
  const now = Date.now();
  const tid = tx(() => {
    const id = q.insThread.run(cat.id, req.user.id, form.baslik, now, now, req.user.id).lastInsertRowid;
    q.insPost.run(id, req.user.id, form.mesaj.trim(), now);
    return id;
  });
  res.redirect(h.threadUrl({ id: tid, title: form.baslik }));
});

app.post('/konu/:id/cevap', requireUser, (req, res) => {
  const t = q.threadById.get(toInt(req.params.id));
  if (!t) return notFound(req, res);
  if (t.locked && !isMod(req.user)) return fail(req, res, 403, 'Bu konu kilitli, cevap yazılamaz.');
  const error = validatePost(req.body.mesaj) || floodCheck(req.user);
  if (error) return fail(req, res, 400, error);
  const now = Date.now();
  const pid = tx(() => {
    const id = q.insPost.run(t.id, req.user.id, str(req.body.mesaj).trim(), now).lastInsertRowid;
    q.recompute.run(t.id);
    return id;
  });
  res.redirect('/mesaj/' + pid);
});

app.get('/mesaj/:id/duzenle', requireUser, (req, res) => {
  const post = q.postById.get(toInt(req.params.id));
  if (!post) return notFound(req, res);
  if (post.user_id !== req.user.id && !isMod(req.user)) return fail(req, res, 403, 'Bu mesajı düzenleyemezsin.');
  const t = q.threadById.get(post.thread_id);
  const isFirst = q.firstPostId.get(t.id).id === post.id;
  page(req, res, 'edit-post', { title: 'Mesajı düzenle', post, t, isFirst, form: { baslik: t.title, mesaj: post.body }, error: null }, 'Mesaj düzenliyor');
});

app.post('/mesaj/:id/duzenle', requireUser, (req, res) => {
  const post = q.postById.get(toInt(req.params.id));
  if (!post) return notFound(req, res);
  if (post.user_id !== req.user.id && !isMod(req.user)) return fail(req, res, 403, 'Bu mesajı düzenleyemezsin.');
  const t = q.threadById.get(post.thread_id);
  const isFirst = q.firstPostId.get(t.id).id === post.id;
  const form = { baslik: str(req.body.baslik).trim().replace(/\s+/g, ' '), mesaj: str(req.body.mesaj) };
  let error = validatePost(form.mesaj);
  if (!error && isFirst && (form.baslik.length < 5 || form.baslik.length > 120)) error = 'Başlık 5 ile 120 karakter arasında olmalı.';
  if (error) {
    res.status(400);
    return page(req, res, 'edit-post', { title: 'Mesajı düzenle', post, t, isFirst, form, error }, 'Mesaj düzenliyor');
  }
  tx(() => {
    q.updPost.run(form.mesaj.trim(), Date.now(), post.id);
    if (isFirst) q.setTitle.run(form.baslik, t.id);
  });
  res.redirect('/mesaj/' + post.id);
});

app.post('/mesaj/:id/sil', requireUser, (req, res) => {
  const post = q.postById.get(toInt(req.params.id));
  if (!post) return notFound(req, res);
  if (post.user_id !== req.user.id && !isMod(req.user)) return fail(req, res, 403, 'Bu mesajı silemezsin.');
  const t = q.threadById.get(post.thread_id);
  const isFirst = q.firstPostId.get(t.id).id === post.id;
  if (isFirst) {
    if (t.reply_count > 0 && !isMod(req.user)) return fail(req, res, 400, 'Cevap almış bir konunun ilk mesajını silemezsin. Bir yöneticiye bildir.');
    q.delThread.run(t.id);
    return res.redirect('/kategori/' + t.cat_slug);
  }
  tx(() => { q.delPost.run(post.id); q.recompute.run(t.id); });
  res.redirect(h.threadUrl(t));
});

// Moderasyon
app.post('/konu/:id/sabitle', requireUser, requireMod, (req, res) => {
  const t = q.threadById.get(toInt(req.params.id));
  if (!t) return notFound(req, res);
  q.setPinned.run(t.pinned ? 0 : 1, t.id);
  res.redirect(h.threadUrl(t));
});
app.post('/konu/:id/kilitle', requireUser, requireMod, (req, res) => {
  const t = q.threadById.get(toInt(req.params.id));
  if (!t) return notFound(req, res);
  q.setLocked.run(t.locked ? 0 : 1, t.id);
  res.redirect(h.threadUrl(t));
});
app.post('/konu/:id/sil', requireUser, requireMod, (req, res) => {
  const t = q.threadById.get(toInt(req.params.id));
  if (!t) return notFound(req, res);
  q.delThread.run(t.id);
  res.redirect('/kategori/' + t.cat_slug);
});

// ---------- API ----------
app.post('/api/mesaj/:id/begen', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Faydalı vermek için giriş yapmalısın.' });
  const post = q.postById.get(toInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
  if (post.user_id === req.user.id) return res.status(400).json({ error: 'Kendi mesajını faydalı olarak işaretleyemezsin.' });
  const had = !!q.hasLike.get(post.id, req.user.id);
  if (had) q.delLike.run(post.id, req.user.id); else q.insLike.run(post.id, req.user.id);
  res.json({ liked: !had, count: q.likeCount.get(post.id).c });
});

app.post('/api/heartbeat', (req, res) => {
  const now = Date.now();
  const key = req.user ? 'u' + req.user.id : 'g' + req.vid;
  if (!q.touchPresence.run(now, key).changes) track(req, 'Forumda geziniyor', '/');
  else if (req.user) q.userSeen.run(now, req.user.id);
  const o = onlineStats();
  res.set('Cache-Control', 'no-store').json({
    total: o.total, guests: o.guests,
    members: o.members.slice(0, 40).map((m) => ({ u: m.username, r: m.role })),
    memberCount: o.members.length,
  });
});

// ---------- Çevrimiçi / üyeler / arama ----------
app.get('/cevrimici', (req, res) => {
  track(req, 'Çevrimiçi listesine bakıyor', '/cevrimici');
  const guestList = q.onlineGuestList.all(Date.now() - ONLINE_WINDOW);
  page(req, res, 'online', { title: 'Çevrimiçi', guestList }, null);
});

app.get('/uyeler', (req, res) => {
  page(req, res, 'members', { title: 'Üyeler', members: q.members.all() }, 'Üye listesine bakıyor');
});

app.get('/uye/:name', (req, res) => {
  const u = q.profile.get(req.params.name);
  if (!u) return notFound(req, res);
  page(req, res, 'profile', { title: u.username, u, threads: q.userThreads.all(u.id), posts: q.userPosts.all(u.id) }, `Profil: ${u.username}`);
});

app.get('/profil/duzenle', requireUser, (req, res) => {
  const u = q.profile.get(req.user.username);
  page(req, res, 'profile-edit', { title: 'Profili düzenle', form: { bio: u.bio, channel: u.channel }, error: null, saved: req.query.ok === '1' }, 'Profilini düzenliyor');
});
app.post('/profil/duzenle', requireUser, (req, res) => {
  const form = { bio: str(req.body.bio).trim().slice(0, 300), channel: str(req.body.channel).trim() };
  let error = null;
  if (form.channel && !/^https:\/\/(www\.|m\.)?youtube\.com\/[\w@./?=&%-]+$/i.test(form.channel)) error = 'Kanal bağlantısı https://www.youtube.com/@kanaladi biçiminde olmalı.';
  if (error) {
    res.status(400);
    return page(req, res, 'profile-edit', { title: 'Profili düzenle', form, error, saved: false }, 'Profilini düzenliyor');
  }
  q.updProfile.run(form.bio, form.channel, req.user.id);
  res.redirect('/profil/duzenle?ok=1');
});

app.get('/ara', (req, res) => {
  const term = str(req.query.q).trim().slice(0, 80);
  let threads = [], users = [];
  if (term.length >= 2) {
    const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    threads = q.search.all(like, like);
    users = q.searchUsers.all(like);
  }
  res.locals.searchQ = term;
  page(req, res, 'search', { title: term ? `"${term}" araması` : 'Arama', term, threads, users }, 'Arama yapıyor');
});

// ---------- Giriş / kayıt ----------
app.get('/giris', (req, res) => {
  if (req.user) return res.redirect('/');
  page(req, res, 'login', { title: 'Giriş yap', r: safeRedirect(req.query.r), error: null, form: {} }, 'Giriş yapıyor');
});
app.post('/giris', (req, res) => {
  const form = { username: str(req.body.username).trim() };
  const r = safeRedirect(req.body.r);
  if (tooMany('login:' + req.ip, 10, 10 * 60 * 1000)) {
    res.status(429);
    return page(req, res, 'login', { title: 'Giriş yap', r, form, error: 'Çok fazla deneme yaptın. 10 dakika sonra tekrar dene.' }, null);
  }
  const u = q.userByName.get(form.username);
  if (!u || !checkPassword(str(req.body.password), u.pass)) {
    res.status(400);
    return page(req, res, 'login', { title: 'Giriş yap', r, form, error: 'Kullanıcı adı ya da şifre hatalı.' }, null);
  }
  startSession(req, res, u.id);
  res.redirect(r);
});

app.get('/kayit', (req, res) => {
  if (req.user) return res.redirect('/');
  page(req, res, 'register', { title: 'Kayıt ol', error: null, form: {} }, 'Kayıt oluyor');
});
app.post('/kayit', (req, res) => {
  const form = { username: str(req.body.username).trim() };
  const pw = str(req.body.password);
  let error = null;
  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(form.username)) error = 'Kullanıcı adı 3-20 karakter olmalı; harf, rakam, nokta ve alt çizgi kullanabilirsin.';
  else if (pw.length < 6) error = 'Şifre en az 6 karakter olmalı.';
  else if (pw !== str(req.body.password2)) error = 'Şifreler eşleşmiyor.';
  else if (q.userByName.get(form.username)) error = 'Bu kullanıcı adı alınmış.';
  else if (tooMany('reg:' + req.ip, 5, 60 * 60 * 1000)) error = 'Bu bağlantıdan çok fazla kayıt yapıldı. Daha sonra tekrar dene.';
  if (error) {
    res.status(400);
    return page(req, res, 'register', { title: 'Kayıt ol', form, error }, null);
  }
  // İlk kayıt olan gerçek kullanıcı yönetici olur.
  const role = q.realUserCount.get().c === 0 ? 'admin' : 'uye';
  const now = Date.now();
  const id = q.insUser.run(form.username, hashPassword(pw), role, now, now).lastInsertRowid;
  startSession(req, res, id);
  res.redirect('/');
});

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insSession.run(token, userId, Date.now() + SESSION_MS);
  setCookie(res, 'sid', token, SESSION_MS / 1000);
  q.delPresence.run('g' + req.vid);
}

app.post('/cikis', (req, res) => {
  if (req.cookies.sid) q.delSession.run(req.cookies.sid);
  if (req.user) q.delPresence.run('u' + req.user.id);
  setCookie(res, 'sid', '', 0);
  res.redirect('/');
});

// ---------- 404 / hata ----------
app.use((req, res) => notFound(req, res));
app.use((err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  try { fail(req, res, 500, 'Beklenmeyen bir hata oluştu. Lütfen tekrar dene.'); } catch { res.status(500).send('Sunucu hatası'); }
});

// Eski çevrimiçi kayıtlarını ve süresi dolmuş oturumları temizle
setInterval(() => {
  q.cleanPresence.run(Date.now() - ONLINE_WINDOW * 2);
  q.cleanSessions.run(Date.now());
  for (const [k, list] of attempts) if (!list.some((t) => t > Date.now() - 3600 * 1000)) attempts.delete(k);
}, 60 * 1000).unref();

app.listen(PORT, () => console.log(`ytconsole forum çalışıyor: http://localhost:${PORT}`));
