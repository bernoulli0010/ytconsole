# ytconsole

YouTube içerik üreticileri için basit, hızlı bir forum. Node.js + Express + SQLite (Node'un dahili `node:sqlite` modülü, ek veritabanı kurulumu gerekmez).

## Çalıştırma

```
npm install
npm start
```

Tarayıcıda http://localhost:3000 adresini aç. Port değiştirmek için: `$env:PORT=8080; npm start`

**İlk kayıt olan kullanıcı otomatik olarak Yönetici olur.**

## Özellikler

- Bölüm/kategori yapısı (Genel, Kanal Büyütme, İçerik Üretimi, Para Kazanma, Pazar Yeri)
- Konu açma, cevap yazma, düzenleme, silme, alıntılama
- **Çevrimiçi sayacı**: son 5 dakikada aktif olan üye + ziyaretçi sayısı, üst menüde ve yan panelde canlı güncellenir; `/cevrimici` sayfasında kimin nerede olduğu ve rekor görünür
- "Faydalı" oyu ve en faydalı üyeler listesi
- YouTube linkleri mesajda otomatik video olarak gömülür
- Üye profilleri (kanal linki, hakkında), üye listesi, arama
- Yönetici/moderatör: konu sabitleme, kilitleme, silme
- Koyu / açık tema, mobil uyumlu

## Render'a yükleme

1. render.com'da GitHub ile giriş yap.
2. **New > Blueprint** seç, `ytconsole` reposunu bağla. `render.yaml` her şeyi otomatik ayarlar (Node 24, 1 GB kalıcı disk `/var/data`, sağlık kontrolü `/healthz`).
3. **Apply** de, kurulum bitince verilen `https://ytconsole-xxxx.onrender.com` adresini aç ve ilk kaydı sen yap (yönetici olursun).

Not: Kalıcı disk sadece ücretli planlarda var. Ücretsiz planda sunucu her yeniden başladığında tüm konular/üyeler silinir.
Kendi alan adın için: Render panelinde servis > **Settings > Custom Domains**.

Veriler `data/forum.db` dosyasında tutulur (Render'da `DATA_DIR=/var/data`). Bir kullanıcıyı moderatör yapmak için (sunucu kapalıyken):

```
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/forum.db').prepare(\"UPDATE users SET role='mod' WHERE username=?\").run('kullaniciadi')"
```
