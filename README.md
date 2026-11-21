# ytconsole

YouTube içerik üreticileri için basit, hızlı bir forum. Node.js + Express + Postgres (Supabase). Vercel'de çalışır.

## Yerelde çalıştırma

```
npm install
npm start
```

Tarayıcıda http://localhost:3000 adresini aç. `DATABASE_URL` tanımlı değilse yerel, gömülü bir Postgres (`data/pg` klasörü) kullanılır; ek kurulum gerekmez.

**İlk kayıt olan kullanıcı otomatik olarak Yönetici olur.**

## Vercel + Supabase ile yayına alma

1. **Supabase** > projen > **Connect** > **Transaction pooler** bağlantı adresini kopyala (port `6543`). `[YOUR-PASSWORD]` kısmını veritabanı şifrenle değiştir.
2. **Vercel** > proje > **Settings > Environment Variables**: `DATABASE_URL` adında ekle, değer olarak bu adresi yapıştır (Production + Preview).
3. **Deployments** > son deploy > **Redeploy**. İlk istekte tablolar `forum` şemasında otomatik oluşturulur.
4. Siteyi aç ve ilk kaydı sen yap.

Tablolar `forum` şemasında durur ve RLS açıktır; Supabase'in herkese açık API'si bunlara erişemez.

## Özellikler

- Bölüm/kategori yapısı (Genel, Kanal Büyütme, İçerik Üretimi, Para Kazanma, Pazar Yeri)
- Konu açma, cevap yazma, düzenleme, silme, alıntılama
- **Çevrimiçi sayacı**: son 5 dakikada aktif olan üye + ziyaretçi sayısı, üst menüde ve yan panelde canlı güncellenir; `/cevrimici` sayfasında kimin nerede olduğu ve rekor görünür
- "Faydalı" oyu ve en faydalı üyeler listesi
- YouTube linkleri mesajda otomatik video olarak gömülür
- Üye profilleri (kanal linki, hakkında), üye listesi, arama
- Yönetici/moderatör: konu sabitleme, kilitleme, silme
- Koyu / açık tema, mobil uyumlu

## Moderatör atama

Supabase > **SQL Editor**:

```sql
UPDATE forum.users SET role = 'mod' WHERE lower(username) = lower('kullaniciadi');
```
