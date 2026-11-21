'use strict';

const PALETTE = ['#b4415e', '#8e3a59', '#c0566f', '#7a3b6e', '#a64b3c', '#5b4b8a', '#3d6b8c', '#4f7a5a', '#9a6b2f', '#6a4c93'];

function hash(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

function avatar(name, size = 'md') {
  const n = String(name || '?');
  const bg = PALETTE[hash(n.toLowerCase()) % PALETTE.length];
  return `<span class="av av-${size}" style="background:${bg}" aria-hidden="true">${esc(n.slice(0, 1).toLocaleUpperCase('tr-TR'))}</span>`;
}

function timeAgo(ms) {
  if (!ms) return '-';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 45) return 'az önce';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' dk önce';
  if (s < 86400) return Math.floor(s / 3600) + ' saat önce';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' gün önce';
  return dateShort(ms);
}
// Sunucu (Vercel) UTC'de çalışır; tarihleri Türkiye saatiyle göster
const TZ = 'Europe/Istanbul';
const dateShort = (ms) => new Date(ms).toLocaleDateString('tr-TR', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const dateFull = (ms) => new Date(ms).toLocaleString('tr-TR', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const DT = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function dateTime(ms) {
  const p = {};
  for (const x of DT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.day}-${p.month}-${p.year}, ${p.hour}:${p.minute}:${p.second}`;
}

// "9 Yıl 11 Ay" gibi forum yaşı
function forumAge(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return 'Yeni katıldı';
  if (days < 30) return days + ' Gün';
  const months = Math.floor(days / 30.44);
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? y + ' Yıl' : '', m ? m + ' Ay' : ''].filter(Boolean).join(' ') || '1 Ay';
}

// Mesaj sayısına göre seviye ve bir sonraki seviyeye ilerleme
const LEVELS = [0, 5, 15, 30, 60, 100, 200, 350, 600, 1000];
function level(n) {
  let i = 0;
  while (i < LEVELS.length - 1 && n >= LEVELS[i + 1]) i++;
  const next = LEVELS[i + 1];
  return { level: i + 1, pct: next ? (n - LEVELS[i]) / (next - LEVELS[i]) : 1, next: next || null };
}

const ICONS = {
  check: '<path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" fill="currentColor"/>',
  flag: '<path d="M6 21V4M6 4h11l-2.5 4L17 12H6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>',
  play: '<path d="M9 7v10l8-5z" fill="currentColor"/>',
  chat: '<path d="M4 5h16v10H9l-4 4v-4H4z" fill="currentColor"/>',
  thumb: '<path d="M7 10v10H4V10zm2 10h8l2.5-8.5A1.5 1.5 0 0 0 18 9.5h-5V5.5A1.5 1.5 0 0 0 11.5 4L9 10z" fill="currentColor"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8z" fill="currentColor"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">${ICONS[k]}</svg>`;

// Kullanıcı rozetleri (mesaj başlığında ismin yanında)
function badges(u, isThreadOwner) {
  const out = [];
  if (u.role === 'admin') out.push({ cls: 'b-admin', title: 'Yönetici', html: icon('check') });
  if (u.role === 'mod') out.push({ cls: 'b-mod', title: 'Moderatör', html: icon('shield') });
  if (isThreadOwner) out.push({ cls: 'b-owner', title: 'Konu sahibi', html: icon('flag') });
  if (u.channel) out.push({ cls: 'b-yt', title: 'YouTube kanalı var', html: icon('play') });
  const lv = level(u.post_count || 0);
  out.push({ cls: 'b-level', title: `Seviye ${lv.level}${lv.next ? ` (sonraki seviye ${lv.next} mesajda)` : ''}`, html: String(lv.level), pct: lv.pct });
  if ((u.post_count || 0) >= 50) out.push({ cls: 'b-chat', title: 'Aktif üye (50+ mesaj)', html: icon('chat') });
  if ((u.likes_received || 0) >= 10) out.push({ cls: 'b-like', title: 'Faydalı üye (10+ beğeni aldı)', html: icon('thumb') });
  if (u.joined && Date.now() - u.joined > 365 * 86400000) out.push({ cls: 'b-vet', title: 'Kıdemli üye (1+ yıl)', html: icon('star') });
  return out;
}

function likersText(names, count) {
  if (!count) return '';
  const shown = (names || []).slice(0, 3);
  const rest = count - shown.length;
  return shown.join(', ') + (rest > 0 ? ` ve ${rest} kişi daha` : '') + ' bunu beğendi.';
}
const num = (n) => Number(n || 0).toLocaleString('tr-TR');

const ROLES = { admin: 'Yönetici', mod: 'Moderatör', uye: 'Üye' };
const roleLabel = (r) => ROLES[r] || 'Üye';

function rank(postCount) {
  if (postCount >= 500) return 'Efsane Üye';
  if (postCount >= 200) return 'Usta Üye';
  if (postCount >= 50) return 'Aktif Üye';
  if (postCount >= 10) return 'Üye';
  return 'Yeni Üye';
}

const TR = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
function slugify(s) {
  return String(s).replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => TR[c]).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'konu';
}
const threadUrl = (t) => `/konu/${t.id}-${slugify(t.title)}`;
const userUrl = (name) => `/uye/${encodeURIComponent(name)}`;

// Metin önceden escape edilmiş olarak gelir.
function linkify(t) {
  return t.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) =>
    `<a href="${u}" target="_blank" rel="nofollow noopener noreferrer">${u.length > 70 ? u.slice(0, 67) + '…' : u}</a>`);
}

const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^\s]*&(?:amp;)?)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/g;

// Mesaj gövdesi: düz metin -> güvenli HTML (alıntı, link, YouTube gömme)
function formatBody(raw) {
  const lines = esc(String(raw).replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let quote = null;
  const flush = () => {
    if (quote) { out.push('<blockquote>' + quote.map(linkify).join('<br>') + '</blockquote>'); quote = null; }
  };
  for (const l of lines) {
    if (l.startsWith('&gt;')) { (quote = quote || []).push(l.replace(/^&gt;\s?/, '')); continue; }
    flush();
    out.push(linkify(l));
  }
  flush();
  let html = out.join('<br>').replace(/<br>(<blockquote>)/g, '$1').replace(/(<\/blockquote>)<br>/g, '$1');

  const ids = [];
  for (const m of String(raw).matchAll(YT_RE)) if (!ids.includes(m[1]) && ids.length < 3) ids.push(m[1]);
  for (const id of ids) {
    html += `<div class="yt-embed"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube videosu" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  }
  return html;
}

function excerpt(raw, n = 140) {
  const s = String(raw).replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { esc, avatar, timeAgo, dateShort, dateFull, dateTime, forumAge, level, badges, likersText, num, roleLabel, rank, slugify, threadUrl, userUrl, formatBody, excerpt };
