(function () {
  'use strict';

  // Tema
  var toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) toggle.addEventListener('click', function () {
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* yoksay */ }
  });

  // Kullanıcı menüsü: dışarı tıklayınca kapat
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.usermenu[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // Onay isteyen formlar
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!confirm(f.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Çift gönderimi engelle
  document.querySelectorAll('form[method="post"]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      var b = f.querySelector('button[type="submit"], button:not([type])');
      if (b) setTimeout(function () { b.disabled = true; }, 0);
    });
  });

  // Faydalı (beğeni)
  document.querySelectorAll('[data-like]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      btn.disabled = true;
      fetch('/api/mesaj/' + btn.getAttribute('data-like') + '/begen', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
        .then(function (res) {
          if (res.status === 401) { location.href = '/giris?r=' + encodeURIComponent(location.pathname + location.search); return; }
          if (!res.ok) { alert(res.j.error || 'Bir hata oluştu.'); return; }
          btn.classList.toggle('on', res.j.liked);
          var label = btn.querySelector('[data-like-label]');
          if (label) label.textContent = res.j.liked ? 'Beğendin' : 'Beğen';
          var post = btn.closest('.post');
          var likers = post && post.querySelector('[data-likers]');
          if (likers) likers.textContent = res.j.text || '';
        })
        .catch(function () { alert('Bağlantı hatası.'); })
        .finally(function () { btn.disabled = false; });
    });
  });

  // Alıntıla
  var reply = document.getElementById('reply-body');
  document.querySelectorAll('[data-quote]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!reply) return;
      var who = btn.getAttribute('data-quote');
      var text = btn.getAttribute('data-quote-text') || '';
      var block = '> @' + who + ' yazdı:\n> ' + text + '\n\n';
      reply.value = (reply.value ? reply.value.replace(/\s*$/, '') + '\n\n' : '') + block;
      reply.focus();
      reply.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  // Hızlı cevap: cevap kutusuna git
  document.querySelectorAll('[data-quick-reply]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!reply) return;
      reply.focus();
      reply.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  // Kullanıcı bilgi paneli: 1/2 sayfa geçişi
  document.querySelectorAll('[data-panel]').forEach(function (panel) {
    var pages = panel.querySelectorAll('[data-page]');
    var label = panel.querySelector('[data-pp-label]');
    var cur = 0;
    panel.querySelectorAll('[data-pp]').forEach(function (b) {
      b.addEventListener('click', function () {
        cur = (cur + Number(b.getAttribute('data-pp')) + pages.length) % pages.length;
        pages.forEach(function (pg, i) { pg.hidden = i !== cur; });
        if (label) label.textContent = (cur + 1) + '/' + pages.length;
      });
    });
  });

  // Çevrimiçi sayacı: her 60 sn'de bir kalp atışı gönder ve sayıları güncelle
  function setAll(sel, val) {
    document.querySelectorAll(sel).forEach(function (el) { el.textContent = val; });
  }
  function renderList(data) {
    document.querySelectorAll('[data-online-list]').forEach(function (box) {
      box.textContent = '';
      if (!data.members.length) {
        var s = document.createElement('span');
        s.className = 'muted';
        s.textContent = 'Şu an çevrimiçi üye yok.';
        box.appendChild(s);
        return;
      }
      data.members.forEach(function (m, i) {
        var a = document.createElement('a');
        a.href = '/uye/' + encodeURIComponent(m.u);
        a.className = 'role-' + m.r;
        a.textContent = m.u;
        box.appendChild(a);
        if (i < data.members.length - 1) box.appendChild(document.createTextNode(', '));
      });
    });
  }
  function beat() {
    if (document.visibilityState !== 'visible') return;
    fetch('/api/heartbeat', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        setAll('[data-online-total]', d.total);
        setAll('[data-online-members]', d.memberCount);
        setAll('[data-online-guests]', d.guests);
        renderList(d);
      })
      .catch(function () { /* yoksay */ });
  }
  setInterval(beat, 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') beat(); });
})();
