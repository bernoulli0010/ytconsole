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
const dateShort = (ms) => new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
const dateFull = (ms) => new Date(ms).toLocaleString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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

module.exports = { esc, avatar, timeAgo, dateShort, dateFull, num, roleLabel, rank, slugify, threadUrl, userUrl, formatBody, excerpt };
