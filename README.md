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

Veriler `data/forum.db` dosyasında tutulur. Bir kullanıcıyı moderatör yapmak için (sunucu kapalıyken):

```
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/forum.db').prepare(\"UPDATE users SET role='mod' WHERE username=?\").run('kullaniciadi')"
```
