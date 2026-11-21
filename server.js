'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const h = require('./helpers');

const PORT = Number(process.env.PORT) || 3000;
const ONLINE_WINDOW = 5 * 60 * 1000;          // son 5 dk içinde aktif olan = çevrimiçi
const SESSION_MS = 30 * 24 * 3600 * 1000;
const THREADS_PER_PAGE = 25;
const POSTS_PER_PAGE = 20;
const FLOOD_MS = 15 * 1000;
// Vercel / Render gibi HTTPS proxy arkasında: gerçek IP'yi al, çerezleri Secure yap
const BEHIND_PROXY = !!(process.env.VERCEL || process.env.RENDER) || process.env.TRUST_PROXY === '1';
const SECURE_COOKIES = BEHIND_PROXY || process.env.NODE_ENV === 'production';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', BEHIND_PROXY ? 1 : 'loopback');
app.disable('x-powered-by');
app.get('/healthz', (req, res) => {
  // Sadece bölge bilgisi (örn. eu-central-1); adres/şifre gösterilmez
  const m = /@aws-\d+-([a-z]+-[a-z]+-\d)\.pooler\.supabase\.com/.exec(process.env.DATABASE_URL || '');
  res.type('text').send(`ok fn=${process.env.VERCEL_REGION || '-'} db=${m ? m[1] : '-'}`);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

const { query: all, one } = db;
const T_COLS = `t.*, u.username AS author, lu.username AS last_user, c.name AS cat_name, c.slug AS cat_slug
  FROM forum.threads t JOIN forum.users u ON u.id = t.user_id LEFT JOIN forum.users lu ON lu.id = t.last_post_user
  JOIN forum.categories c ON c.id = t.category_id`;

// ---------- Sorgular ----------
const q = {
  sessionUser: 'SELECT u.id, u.username, u.role FROM forum.sessions s JOIN forum.users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires > $2',
  insSession: 'INSERT INTO forum.sessions(token, user_id, expires) VALUES($1,$2,$3)',
  delSession: 'DELETE FROM forum.sessions WHERE token = $1',
  userByName: 'SELECT * FROM forum.users WHERE lower(username) = lower($1)',
  realUserCount: 'SELECT COUNT(*)::int AS c FROM forum.users WHERE pass IS NOT NULL',
  insUser: 'INSERT INTO forum.users(username, pass, role, created_at, last_seen) VALUES($1,$2,$3,$4,$4) RETURNING id',
  userSeen: 'UPDATE forum.users SET last_seen = $1 WHERE id = $2',
  updProfile: 'UPDATE forum.users SET bio = $1, channel = $2 WHERE id = $3',

  upsertPresence: `INSERT INTO forum.presence(vkey, user_id, last_seen, location, url) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (vkey) DO UPDATE SET user_id = EXCLUDED.user_id, last_seen = EXCLUDED.last_seen, location = EXCLUDED.location, url = EXCLUDED.url`,
  touchPresence: 'UPDATE forum.presence SET last_seen = $1 WHERE vkey = $2 RETURNING vkey',
  delPresence: 'DELETE FROM forum.presence WHERE vkey = $1',
  onlineMembers: `SELECT u.id, u.username, u.role, p.location, p.url, p.last_seen FROM forum.presence p JOIN forum.users u ON u.id = p.user_id
    WHERE p.last_seen > $1 ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'mod' THEN 1 ELSE 2 END, lower(u.username)`,
  onlineGuests: 'SELECT COUNT(*)::int AS c FROM forum.presence WHERE user_id IS NULL AND last_seen > $1',
  onlineGuestList: 'SELECT location, url, last_seen FROM forum.presence WHERE user_id IS NULL AND last_seen > $1 ORDER BY last_seen DESC LIMIT 100',

  sections: 'SELECT * FROM forum.sections ORDER BY sort',
  allCategories: 'SELECT id, slug, name, icon FROM forum.categories ORDER BY section_id, sort',
  categoriesWithStats: `SELECT c.*,
      (SELECT COUNT(*)::int FROM forum.threads t WHERE t.category_id = c.id) AS thread_count,
      (SELECT COUNT(*)::int FROM forum.posts p JOIN forum.threads t ON t.id = p.thread_id WHERE t.category_id = c.id) AS post_count,
      lt.id AS last_id, lt.title AS last_title, lt.last_post_at AS last_at, lu.username AS last_user
    FROM forum.categories c
    LEFT JOIN forum.threads lt ON lt.id = (SELECT id FROM forum.threads WHERE category_id = c.id ORDER BY last_post_at DESC LIMIT 1)
    LEFT JOIN forum.users lu ON lu.id = lt.last_post_user
    ORDER BY c.section_id, c.sort`,
  categoryBySlug: 'SELECT * FROM forum.categories WHERE slug = $1',

  countThreadsInCat: 'SELECT COUNT(*)::int AS c FROM forum.threads WHERE category_id = $1',
  threadsInCat: `SELECT ${T_COLS} WHERE t.category_id = $1 ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT $2 OFFSET $3`,
  latestThreads: `SELECT ${T_COLS} ORDER BY t.last_post_at DESC LIMIT $1 OFFSET $2`,
  countAllThreads: 'SELECT COUNT(*)::int AS c FROM forum.threads',
  threadById: 'SELECT t.*, c.name AS cat_name, c.slug AS cat_slug, c.icon AS cat_icon FROM forum.threads t JOIN forum.categories c ON c.id = t.category_id WHERE t.id = $1',
  incViews: 'UPDATE forum.threads SET views = views + 1 WHERE id = $1',
  insThread: 'INSERT INTO forum.threads(category_id, user_id, title, created_at, last_post_at, last_post_user) VALUES($1,$2,$3,$4,$4,$2) RETURNING id',
  setPinned: 'UPDATE forum.threads SET pinned = $1 WHERE id = $2',
  setLocked: 'UPDATE forum.threads SET locked = $1 WHERE id = $2',
  setTitle: 'UPDATE forum.threads SET title = $1 WHERE id = $2',
  delThread: 'DELETE FROM forum.threads WHERE id = $1',
  recompute: `UPDATE forum.threads t SET
      reply_count = (SELECT COUNT(*) - 1 FROM forum.posts WHERE thread_id = t.id),
      last_post_at = COALESCE((SELECT MAX(created_at) FROM forum.posts WHERE thread_id = t.id), t.created_at),
      last_post_user = (SELECT user_id FROM forum.posts WHERE thread_id = t.id ORDER BY id DESC LIMIT 1)
    WHERE t.id = $1`,

  countPosts: 'SELECT COUNT(*)::int AS c FROM forum.posts WHERE thread_id = $1',
  postsInThread: `SELECT p.*, u.username, u.role, u.created_at AS joined, u.last_seen AS user_seen, u.channel,
      (SELECT COUNT(*)::int FROM forum.posts x WHERE x.user_id = u.id) AS post_count,
      (SELECT COUNT(*)::int FROM forum.threads x WHERE x.user_id = u.id) AS thread_count,
      (SELECT COUNT(*)::int FROM forum.likes l JOIN forum.posts x ON x.id = l.post_id WHERE x.user_id = u.id AND l.user_id <> u.id) AS likes_received,
      (SELECT COUNT(*)::int FROM forum.likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT array_agg(z.username) FROM (SELECT lu.username FROM forum.likes l JOIN forum.users lu ON lu.id = l.user_id
         WHERE l.post_id = p.id ORDER BY lu.username LIMIT 3) z) AS likers,
      EXISTS(SELECT 1 FROM forum.likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked
    FROM forum.posts p JOIN forum.users u ON u.id = p.user_id WHERE p.thread_id = $2 ORDER BY p.id LIMIT $3 OFFSET $4`,
  postById: 'SELECT * FROM forum.posts WHERE id = $1',
  firstPostId: 'SELECT MIN(id) AS id FROM forum.posts WHERE thread_id = $1',
  postIndex: 'SELECT COUNT(*)::int AS c FROM forum.posts WHERE thread_id = $1 AND id <= $2',
  insPost: 'INSERT INTO forum.posts(thread_id, user_id, body, created_at) VALUES($1,$2,$3,$4) RETURNING id',
  updPost: 'UPDATE forum.posts SET body = $1, edited_at = $2 WHERE id = $3',
  delPost: 'DELETE FROM forum.posts WHERE id = $1',
  lastPostByUser: 'SELECT MAX(created_at) AS t FROM forum.posts WHERE user_id = $1',

  hasLike: 'SELECT 1 AS x FROM forum.likes WHERE post_id = $1 AND user_id = $2',
  insLike: 'INSERT INTO forum.likes(post_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
  delLike: 'DELETE FROM forum.likes WHERE post_id = $1 AND user_id = $2',
  likeCount: 'SELECT COUNT(*)::int AS c FROM forum.likes WHERE post_id = $1',
  likers: 'SELECT u.username FROM forum.likes l JOIN forum.users u ON u.id = l.user_id WHERE l.post_id = $1 ORDER BY u.username LIMIT 3',
  topHelpers: `SELECT u.username, COUNT(*)::int AS likes FROM forum.likes l JOIN forum.posts p ON p.id = l.post_id JOIN forum.users u ON u.id = p.user_id
    WHERE l.user_id <> p.user_id GROUP BY u.id, u.username ORDER BY likes DESC LIMIT 5`,

  stats: `SELECT (SELECT COUNT(*)::int FROM forum.threads) AS threads, (SELECT COUNT(*)::int FROM forum.posts) AS posts,
      (SELECT COUNT(*)::int FROM forum.users WHERE pass IS NOT NULL) AS users,
      (SELECT username FROM forum.users WHERE pass IS NOT NULL ORDER BY id DESC LIMIT 1) AS newest`,

  profile: `SELECT u.*, (SELECT COUNT(*)::int FROM forum.posts WHERE user_id = u.id) AS post_count,
      (SELECT COUNT(*)::int FROM forum.threads WHERE user_id = u.id) AS thread_count,
      (SELECT COUNT(*)::int FROM forum.likes l JOIN forum.posts p ON p.id = l.post_id WHERE p.user_id = u.id AND l.user_id <> u.id) AS like_count
    FROM forum.users u WHERE lower(u.username) = lower($1)`,
  userThreads: `SELECT ${T_COLS} WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 15`,
  userPosts: `SELECT p.id, p.body, p.created_at, t.id AS tid, t.title FROM forum.posts p JOIN forum.threads t ON t.id = p.thread_id
    WHERE p.user_id = $1 ORDER BY p.id DESC LIMIT 10`,
  members: `SELECT u.username, u.role, u.created_at, u.last_seen, (SELECT COUNT(*)::int FROM forum.posts WHERE user_id = u.id) AS post_count
    FROM forum.users u WHERE u.pass IS NOT NULL OR u.role = 'admin' ORDER BY post_count DESC, u.id LIMIT 200`,

  search: `SELECT ${T_COLS}
    WHERE t.title ILIKE $1 OR EXISTS(SELECT 1 FROM forum.posts p WHERE p.thread_id = t.id AND p.body ILIKE $1)
    ORDER BY t.last_post_at DESC LIMIT 50`,
  searchUsers: 'SELECT username, role FROM forum.users WHERE username ILIKE $1 LIMIT 10',

  cleanPresence: 'DELETE FROM forum.presence WHERE last_seen < $1',
  cleanSessions: 'DELETE FROM forum.sessions WHERE expires < $1',
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
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n < 2147483647 ? n : 0; };
const clampPage = (v, pages) => Math.min(Math.max(1, toInt(v) || 1), pages);
const safeRedirect = (r) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : '/');
const str = (v) => (typeof v === 'string' ? v : '');

// ---------- Çevrimiçi takibi ----------
async function track(req, label, url) {
  const now = Date.now();
  if (req.user) {
    await Promise.all([
      all(q.upsertPresence, ['u' + req.user.id, req.user.id, now, label, url]),
      all(q.delPresence, ['g' + req.vid]),
      all(q.userSeen, [now, req.user.id]),
    ]);
  } else {
    await all(q.upsertPresence, ['g' + req.vid, null, now, label, url]);
  }
}

let lastCleanup = 0;
async function onlineStats() {
  const now = Date.now();
  if (now - lastCleanup > 60 * 1000) {
    lastCleanup = now;
    await Promise.all([all(q.cleanPresence, [now - ONLINE_WINDOW * 2]), all(q.cleanSessions, [now])]);
  }
  const since = now - ONLINE_WINDOW;
  const [members, guestRow, recRaw] = await Promise.all([all(q.onlineMembers, [since]), one(q.onlineGuests, [since]), db.getMeta('record_online')]);
  const guests = guestRow.c;
  const total = members.length + guests;
  let record = null;
  try { record = JSON.parse(recRaw); } catch { /* yoksay */ }
  if (!record || total > record.count) {
    record = { count: total, at: now };
    await db.setMeta('record_online', JSON.stringify(record));
  }
  return { members, guests, total, record };
}
const isOnline = (lastSeen) => !!lastSeen && lastSeen > Date.now() - ONLINE_WINDOW;

async function page(req, res, view, data, label) {
  if (label) await track(req, label, req.originalUrl.slice(0, 300));
  res.render(view, { title: null, ...data, online: await onlineStats() });
}
async function sidebarData() {
  const [stats, helpers, latest] = await Promise.all([one(q.stats), all(q.topHelpers), all(q.latestThreads, [6, 0])]);
  return { stats, helpers, latest };
}
function fail(req, res, status, message) {
  res.status(status);
  return page(req, res, 'message', { title: 'Hata', heading: status === 404 ? 'Sayfa bulunamadı' : 'Bir sorun oluştu', message }, null);
}
const notFound = (req, res) => fail(req, res, 404, 'Aradığın sayfa taşınmış ya da silinmiş olabilir.');

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect('/giris?r=' + encodeURIComponent(req.originalUrl));
  return res.redirect('/giris');
}
function requireMod(req, res, next) {
  if (isMod(req.user)) return next();
  return fail(req, res, 403, 'Bu işlem için yetkin yok.');
}

// Basit deneme sınırlayıcı (giriş / kayıt) - sunucu örneği başına
const attempts = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => t > now - windowMs);
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) attempts.clear();
  return list.length > max;
}

// ---------- Ortak ara katman ----------
app.use(async (req, res, next) => {
  await db.init();
  req.cookies = parseCookies(req);
  let vid = req.cookies.vid;
  if (!vid || !/^[a-f0-9]{32}$/.test(vid)) {
    vid = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'vid', vid, 365 * 86400);
  }
  req.vid = vid;
  req.user = null;
  if (req.cookies.sid) req.user = (await one(q.sessionUser, [req.cookies.sid, Date.now()])) || null;

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
  res.locals.siteUrl = `${req.protocol}://${req.get('host')}`;
  next();
});

// ---------- Sayfalar ----------
app.get('/', async (req, res) => {
  const [cats, secs, side] = await Promise.all([all(q.categoriesWithStats), all(q.sections), sidebarData()]);
  const sections = secs.map((s) => ({ ...s, categories: cats.filter((c) => c.section_id === s.id) }));
  await page(req, res, 'index', { sections, ...side }, 'Ana sayfa');
});

app.get('/kategori/:slug', async (req, res) => {
  const cat = await one(q.categoryBySlug, [req.params.slug]);
  if (!cat) return notFound(req, res);
  const total = (await one(q.countThreadsInCat, [cat.id])).c;
  const pages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const p = clampPage(req.query.sayfa, pages);
  const [threads, side] = await Promise.all([all(q.threadsInCat, [cat.id, THREADS_PER_PAGE, (p - 1) * THREADS_PER_PAGE]), sidebarData()]);
  await page(req, res, 'category', { title: cat.name, cat, threads, total, page: p, pages, base: `/kategori/${cat.slug}`, ...side }, `Kategori: ${cat.name}`);
});

app.get('/yeni-mesajlar', async (req, res) => {
  const total = (await one(q.countAllThreads)).c;
  const pages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const p = clampPage(req.query.sayfa, pages);
  const [threads, side] = await Promise.all([all(q.latestThreads, [THREADS_PER_PAGE, (p - 1) * THREADS_PER_PAGE]), sidebarData()]);
  await page(req, res, 'latest', { title: 'Yeni Mesajlar', threads, page: p, pages, base: '/yeni-mesajlar', ...side }, 'Yeni mesajlara bakıyor');
});

app.get('/konu/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const t = id && await one(q.threadById, [id]);
  if (!t) return notFound(req, res);
  const total = (await one(q.countPosts, [t.id])).c;
  const pages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
  const p = clampPage(req.query.sayfa, pages);
  const [posts, first] = await Promise.all([
    all(q.postsInThread, [req.user ? req.user.id : 0, t.id, POSTS_PER_PAGE, (p - 1) * POSTS_PER_PAGE]),
    one(q.firstPostId, [t.id]),
    all(q.incViews, [t.id]),
  ]);
  t.views += 1;
  await page(req, res, 'thread', { title: t.title, t, posts, firstPostId: first.id, page: p, pages, base: h.threadUrl(t), offset: (p - 1) * POSTS_PER_PAGE }, `Konu: ${t.title}`);
});

app.get('/mesaj/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const post = id && await one(q.postById, [id]);
  if (!post) return notFound(req, res);
  const [t, idx] = await Promise.all([one(q.threadById, [post.thread_id]), one(q.postIndex, [post.thread_id, post.id])]);
  const p = Math.ceil(idx.c / POSTS_PER_PAGE);
  res.redirect(`${h.threadUrl(t)}${p > 1 ? '?sayfa=' + p : ''}#m${post.id}`);
});

// ---------- Konu / mesaj yazma ----------
function validatePost(body) {
  const b = str(body).trim();
  if (b.length < 2) return 'Mesaj çok kısa.';
  if (b.length > 10000) return 'Mesaj en fazla 10.000 karakter olabilir.';
  return null;
}
async function floodCheck(user) {
  if (isMod(user)) return null;
  const last = (await one(q.lastPostByUser, [user.id])).t;
  if (last && Date.now() - last < FLOOD_MS) return `Çok hızlı yazıyorsun. ${Math.ceil((FLOOD_MS - (Date.now() - last)) / 1000)} sn sonra tekrar dene.`;
  return null;
}
async function loadPostForEdit(req, res) {
  const id = toInt(req.params.id);
  const post = id && await one(q.postById, [id]);
  if (!post) { await notFound(req, res); return null; }
  if (post.user_id !== req.user.id && !isMod(req.user)) { await fail(req, res, 403, 'Bu mesaj üzerinde işlem yapamazsın.'); return null; }
  const [t, first] = await Promise.all([one(q.threadById, [post.thread_id]), one(q.firstPostId, [post.thread_id])]);
  return { post, t, isFirst: first.id === post.id };
}

app.get('/yeni-konu', requireUser, async (req, res) => {
  await page(req, res, 'new-thread', { title: 'Yeni konu', categories: await all(q.allCategories), form: { kategori: str(req.query.kategori) }, error: null }, 'Yeni konu açıyor');
});

app.post('/yeni-konu', requireUser, async (req, res) => {
  const form = { kategori: str(req.body.kategori), baslik: str(req.body.baslik).trim().replace(/\s+/g, ' '), mesaj: str(req.body.mesaj) };
  const cat = await one(q.categoryBySlug, [form.kategori]);
  let error = null;
  if (!cat) error = 'Bir kategori seç.';
  else if (cat.slug === 'duyurular' && !isMod(req.user)) error = 'Duyurular kategorisine sadece yöneticiler konu açabilir.';
  else if (form.baslik.length < 5 || form.baslik.length > 120) error = 'Başlık 5 ile 120 karakter arasında olmalı.';
  else error = validatePost(form.mesaj) || await floodCheck(req.user);
  if (error) {
    res.status(400);
    return page(req, res, 'new-thread', { title: 'Yeni konu', categories: await all(q.allCategories), form, error }, 'Yeni konu açıyor');
  }
  const now = Date.now();
  const tid = await db.tx(async (c) => {
    const [{ id }] = await c.query(q.insThread, [cat.id, req.user.id, form.baslik, now]);
    await c.query(q.insPost, [id, req.user.id, form.mesaj.trim(), now]);
    return id;
  });
  res.redirect(h.threadUrl({ id: tid, title: form.baslik }));
});

app.post('/konu/:id/cevap', requireUser, async (req, res) => {
  const id = toInt(req.params.id);
  const t = id && await one(q.threadById, [id]);
  if (!t) return notFound(req, res);
  if (t.locked && !isMod(req.user)) return fail(req, res, 403, 'Bu konu kilitli, cevap yazılamaz.');
  const error = validatePost(req.body.mesaj) || await floodCheck(req.user);
  if (error) return fail(req, res, 400, error);
  const pid = await db.tx(async (c) => {
    const [{ id: newId }] = await c.query(q.insPost, [t.id, req.user.id, str(req.body.mesaj).trim(), Date.now()]);
    await c.query(q.recompute, [t.id]);
    return newId;
  });
  res.redirect('/mesaj/' + pid);
});

app.get('/mesaj/:id/duzenle', requireUser, async (req, res) => {
  const x = await loadPostForEdit(req, res);
  if (!x) return;
  await page(req, res, 'edit-post', { title: 'Mesajı düzenle', ...x, form: { baslik: x.t.title, mesaj: x.post.body }, error: null }, 'Mesaj düzenliyor');
});

app.post('/mesaj/:id/duzenle', requireUser, async (req, res) => {
  const x = await loadPostForEdit(req, res);
  if (!x) return;
  const form = { baslik: str(req.body.baslik).trim().replace(/\s+/g, ' '), mesaj: str(req.body.mesaj) };
  let error = validatePost(form.mesaj);
  if (!error && x.isFirst && (form.baslik.length < 5 || form.baslik.length > 120)) error = 'Başlık 5 ile 120 karakter arasında olmalı.';
  if (error) {
    res.status(400);
    return page(req, res, 'edit-post', { title: 'Mesajı düzenle', ...x, form, error }, 'Mesaj düzenliyor');
  }
  await db.tx(async (c) => {
    await c.query(q.updPost, [form.mesaj.trim(), Date.now(), x.post.id]);
    if (x.isFirst) await c.query(q.setTitle, [form.baslik, x.t.id]);
  });
  res.redirect('/mesaj/' + x.post.id);
});

app.post('/mesaj/:id/sil', requireUser, async (req, res) => {
  const x = await loadPostForEdit(req, res);
  if (!x) return;
  if (x.isFirst) {
    if (x.t.reply_count > 0 && !isMod(req.user)) return fail(req, res, 400, 'Cevap almış bir konunun ilk mesajını silemezsin. Bir yöneticiye bildir.');
    await all(q.delThread, [x.t.id]);
    return res.redirect('/kategori/' + x.t.cat_slug);
  }
  await db.tx(async (c) => { await c.query(q.delPost, [x.post.id]); await c.query(q.recompute, [x.t.id]); });
  res.redirect(h.threadUrl(x.t));
});

// Moderasyon
async function modThread(req, res, fn) {
  const id = toInt(req.params.id);
  const t = id && await one(q.threadById, [id]);
  if (!t) return notFound(req, res);
  return fn(t);
}
app.post('/konu/:id/sabitle', requireUser, requireMod, (req, res) => modThread(req, res, async (t) => {
  await all(q.setPinned, [t.pinned ? 0 : 1, t.id]);
  res.redirect(h.threadUrl(t));
}));
app.post('/konu/:id/kilitle', requireUser, requireMod, (req, res) => modThread(req, res, async (t) => {
  await all(q.setLocked, [t.locked ? 0 : 1, t.id]);
  res.redirect(h.threadUrl(t));
}));
app.post('/konu/:id/sil', requireUser, requireMod, (req, res) => modThread(req, res, async (t) => {
  await all(q.delThread, [t.id]);
  res.redirect('/kategori/' + t.cat_slug);
}));

// ---------- API ----------
app.post('/api/mesaj/:id/begen', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Faydalı vermek için giriş yapmalısın.' });
  const id = toInt(req.params.id);
  const post = id && await one(q.postById, [id]);
  if (!post) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
  if (post.user_id === req.user.id) return res.status(400).json({ error: 'Kendi mesajını faydalı olarak işaretleyemezsin.' });
  const had = !!(await one(q.hasLike, [post.id, req.user.id]));
  await all(had ? q.delLike : q.insLike, [post.id, req.user.id]);
  const [cnt, likers] = await Promise.all([one(q.likeCount, [post.id]), all(q.likers, [post.id])]);
  res.json({ liked: !had, count: cnt.c, text: h.likersText(likers.map((x) => x.username), cnt.c) });
});

app.post('/api/heartbeat', async (req, res) => {
  const now = Date.now();
  const key = req.user ? 'u' + req.user.id : 'g' + req.vid;
  const touched = await all(q.touchPresence, [now, key]);
  if (!touched.length) await track(req, 'Forumda geziniyor', '/');
  else if (req.user) await all(q.userSeen, [now, req.user.id]);
  const o = await onlineStats();
  res.set('Cache-Control', 'no-store').json({
    total: o.total, guests: o.guests,
    members: o.members.slice(0, 40).map((m) => ({ u: m.username, r: m.role })),
    memberCount: o.members.length,
  });
});

// ---------- Çevrimiçi / üyeler / arama ----------
app.get('/cevrimici', async (req, res) => {
  await track(req, 'Çevrimiçi listesine bakıyor', '/cevrimici');
  const guestList = await all(q.onlineGuestList, [Date.now() - ONLINE_WINDOW]);
  await page(req, res, 'online', { title: 'Çevrimiçi', guestList }, null);
});

app.get('/uyeler', async (req, res) => {
  await page(req, res, 'members', { title: 'Üyeler', members: await all(q.members) }, 'Üye listesine bakıyor');
});

app.get('/uye/:name', async (req, res) => {
  const u = await one(q.profile, [req.params.name]);
  if (!u) return notFound(req, res);
  const [threads, posts] = await Promise.all([all(q.userThreads, [u.id]), all(q.userPosts, [u.id])]);
  await page(req, res, 'profile', { title: u.username, u, threads, posts }, `Profil: ${u.username}`);
});

app.get('/profil/duzenle', requireUser, async (req, res) => {
  const u = await one(q.profile, [req.user.username]);
  await page(req, res, 'profile-edit', { title: 'Profili düzenle', form: { bio: u.bio, channel: u.channel }, error: null, saved: req.query.ok === '1' }, 'Profilini düzenliyor');
});
app.post('/profil/duzenle', requireUser, async (req, res) => {
  const form = { bio: str(req.body.bio).trim().slice(0, 300), channel: str(req.body.channel).trim() };
  if (form.channel && !/^https:\/\/(www\.|m\.)?youtube\.com\/[\w@./?=&%-]+$/i.test(form.channel)) {
    res.status(400);
    return page(req, res, 'profile-edit', { title: 'Profili düzenle', form, error: 'Kanal bağlantısı https://www.youtube.com/@kanaladi biçiminde olmalı.', saved: false }, 'Profilini düzenliyor');
  }
  await all(q.updProfile, [form.bio, form.channel, req.user.id]);
  res.redirect('/profil/duzenle?ok=1');
});

app.get('/ara', async (req, res) => {
  const term = str(req.query.q).trim().slice(0, 80);
  let threads = [], users = [];
  if (term.length >= 2) {
    const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    [threads, users] = await Promise.all([all(q.search, [like]), all(q.searchUsers, [like])]);
  }
  res.locals.searchQ = term;
  await page(req, res, 'search', { title: term ? `"${term}" araması` : 'Arama', term, threads, users }, 'Arama yapıyor');
});

// ---------- Giriş / kayıt ----------
app.get('/giris', async (req, res) => {
  if (req.user) return res.redirect('/');
  await page(req, res, 'login', { title: 'Giriş yap', r: safeRedirect(req.query.r), error: null, form: {} }, 'Giriş yapıyor');
});
app.post('/giris', async (req, res) => {
  const form = { username: str(req.body.username).trim() };
  const r = safeRedirect(req.body.r);
  if (tooMany('login:' + req.ip, 10, 10 * 60 * 1000)) {
    res.status(429);
    return page(req, res, 'login', { title: 'Giriş yap', r, form, error: 'Çok fazla deneme yaptın. 10 dakika sonra tekrar dene.' }, null);
  }
  const u = await one(q.userByName, [form.username]);
  if (!u || !checkPassword(str(req.body.password), u.pass)) {
    res.status(400);
    return page(req, res, 'login', { title: 'Giriş yap', r, form, error: 'Kullanıcı adı ya da şifre hatalı.' }, null);
  }
  await startSession(req, res, u.id);
  res.redirect(r);
});

app.get('/kayit', async (req, res) => {
  if (req.user) return res.redirect('/');
  await page(req, res, 'register', { title: 'Kayıt ol', error: null, form: {} }, 'Kayıt oluyor');
});
app.post('/kayit', async (req, res) => {
  const form = { username: str(req.body.username).trim() };
  const pw = str(req.body.password);
  let error = null;
  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(form.username)) error = 'Kullanıcı adı 3-20 karakter olmalı; harf, rakam, nokta ve alt çizgi kullanabilirsin.';
  else if (pw.length < 6) error = 'Şifre en az 6 karakter olmalı.';
  else if (pw !== str(req.body.password2)) error = 'Şifreler eşleşmiyor.';
  else if (await one(q.userByName, [form.username])) error = 'Bu kullanıcı adı alınmış.';
  else if (tooMany('reg:' + req.ip, 5, 60 * 60 * 1000)) error = 'Bu bağlantıdan çok fazla kayıt yapıldı. Daha sonra tekrar dene.';
  if (error) {
    res.status(400);
    return page(req, res, 'register', { title: 'Kayıt ol', form, error }, null);
  }
  let id;
  try {
    id = await db.tx(async (c) => {
      // İlk kayıt olan gerçek kullanıcı yönetici olur.
      await c.query('SELECT pg_advisory_xact_lock(712002)');
      const [{ c: n }] = await c.query(q.realUserCount);
      const [row] = await c.query(q.insUser, [form.username, hashPassword(pw), n === 0 ? 'admin' : 'uye', Date.now()]);
      return row.id;
    });
  } catch (e) {
    if (e && e.code === '23505') {
      res.status(400);
      return page(req, res, 'register', { title: 'Kayıt ol', form, error: 'Bu kullanıcı adı alınmış.' }, null);
    }
    throw e;
  }
  await startSession(req, res, id);
  res.redirect('/');
});

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await Promise.all([all(q.insSession, [token, userId, Date.now() + SESSION_MS]), all(q.delPresence, ['g' + req.vid])]);
  setCookie(res, 'sid', token, SESSION_MS / 1000);
}

app.post('/cikis', async (req, res) => {
  if (req.cookies.sid) await all(q.delSession, [req.cookies.sid]);
  if (req.user) await all(q.delPresence, ['u' + req.user.id]);
  setCookie(res, 'sid', '', 0);
  res.redirect('/');
});

// ---------- 404 / hata ----------
app.use((req, res) => notFound(req, res));
app.use(async (err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  try {
    res.locals.user = res.locals.user || null;
    res.locals.h = h;
    res.locals.path = req.path;
    res.locals.searchQ = '';
    await fail(req, res, 500, 'Beklenmeyen bir hata oluştu. Lütfen tekrar dene.');
  } catch {
    res.status(500).type('text').send('Sunucu hatası: ' + dbHint(err));
  }
});

// Veritabanı bağlantı hatalarında şifre/adres göstermeden ipucu ver
function dbHint(err) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || '';
  if (/DATABASE_URL/.test(msg)) return msg;
  const hints = {
    ERR_INVALID_URL: 'DATABASE_URL geçerli bir veritabanı adresi değil. postgresql://postgres.xxxx:SIFRE@aws-...pooler.supabase.com:6543/postgres biçiminde olmalı (https://xxxx.supabase.co proje adresi ya da API anahtarı değil). Supabase > Connect > "Transaction pooler" adresini kopyala.',
    ENOTFOUND: 'Veritabanı sunucusu bulunamadı. Supabase > Connect > "Transaction pooler" adresini (pooler.supabase.com, port 6543) kullan.',
    ENETUNREACH: 'Veritabanına ulaşılamıyor (IPv6). Supabase > Connect > "Transaction pooler" adresini kullan.',
    ECONNREFUSED: 'Veritabanı bağlantıyı reddetti. Port 6543 olan "Transaction pooler" adresini kullan.',
    ETIMEDOUT: 'Veritabanı bağlantısı zaman aşımına uğradı. Supabase projesi duraklatılmış olabilir (Supabase panelinden "Restore").',
    '28P01': 'Veritabanı şifresi hatalı. [YOUR-PASSWORD] yerine doğru şifreyi yazdığından emin ol.',
    XX000: 'Supabase bağlantıyı kabul etmedi (kullanıcı adı postgres.<proje-id> biçiminde olmalı). Adresi Connect ekranından aynen kopyala.',
    '3D000': 'Veritabanı adı hatalı; adresin sonu /postgres olmalı.',
  };
  const hint = hints[code] || (/timeout/i.test(msg) ? hints.ETIMEDOUT : /password authentication/i.test(msg) ? hints['28P01'] : /Tenant or user not found/i.test(msg) ? hints.XX000 : null);
  return (hint || 'lütfen daha sonra tekrar dene.') + (code ? ` [kod: ${code}]` : '');
}

// Vercel bu dosyayı fonksiyon olarak kullanır; doğrudan çalıştırılınca sunucu başlar.
if (require.main === module) {
  app.listen(PORT, () => console.log(`ytconsole forum çalışıyor: http://localhost:${PORT}`));
}
module.exports = app;
