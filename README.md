# Recep Muhasebe 3

Şêrwan Car Detailing için muhasebe, stok, hızlı satış, servis ve kasa programı. Windows'ta çalışır; aynı ağdaki diğer bilgisayarlar ve telefonlar tarayıcıdan bağlanabilir.

Bu rehber programı GitHub'a yüklemek, kurulum dosyasını almak ve eski kayıtları taşımak için adım adım yazıldı. Toplam süre yaklaşık 30 dakika.

## Bu sürümde neler var

- **Stok defteri:** her giriş ve çıkış kayıtlı, ortalama maliyetle. Satışta o anki maliyet saklanır, kâr doğru çıkar.
- **Cari hesaplar para birimine göre:** USD ve IQD bakiyeleri ayrı tutulur. Ekstre, tahsilat, ödeme ve fatura kapama var.
- **Hiçbir belge silinmez, iptal edilir.** Her değişiklik İşlem Geçmişi'nde: kim, ne zaman, ne yaptı.
- **Kurallar:** kullanıcıya göre indirim sınırı, maliyetin altında satış engeli, müşteri kredi limiti.
- **Döviz bozdurma** kurlu transfer olarak kaydedilir; her belge kendi kurunu saklar.
- Hızlı satış ekranı, teklif, iş emri (servis), iade, alış, sipariş, sayım, depo transferi, gelir-gider ve raporlar.
- Her gün otomatik yedek, güncellemeden önce de yedek.
- **Ağ modu:** dükkândaki diğer bilgisayarlar ve telefonlar tarayıcıdan bağlanır.
- 4 dil: Türkçe, Kurdî (Badînî), العربية, English.
- Kullanıcılar ve yetkiler, PIN ile giriş, hatalı PIN denemelerinde bekletme.

Bu sürüme dahil olmayanlar: ayrı telefon uygulaması ve internetsiz eşitleme. Telefonlar dükkânın Wi‑Fi'sinde tarayıcıdan kullanılabilir (Adım 8).

---

## Adım 0 — Eski kayıtlarınızın yedeğini alın (2 dakika)

Yeni program eski kayıtları kendisi bulur ve eski dosyalara dokunmaz. Yine de önce bir yedek alın:

1. Eski Recep Muhasebe'yi açın.
2. Sol alttaki **Yedek Al / Yükle** düğmesine basın, sonra **JSON Olarak Dışa Aktar**.
3. İnen `finora-yedek-….json` dosyasını Masaüstüne veya bir USB belleğe kopyalayın.
4. Eski programı kapatın. Eski program klasörünü silmeyin; birkaç hafta yedek olarak dursun.

## Adım 1 — GitHub deposu

Önceki rehberle `recep-muhasebe` adında bir depo açtıysanız onu kullanın. Açmadıysanız:
GitHub'da sağ üstte **+** → **New repository** → isim `recep-muhasebe` → **Public** → **Create repository**.

**Depo neden Public (herkese açık) olmalı?** Kurulu programlar güncellemeyi GitHub'dan indirir ve GitHub bunu şifresiz olarak yalnızca açık depolarda yapar. Depoda sadece programın kodu var. Müşteri, satış ve kasa bilgileriniz ya da şifreleriniz depoda yok; onlar yalnızca dükkândaki bilgisayarda durur.

Deponuz şu an Private ise: deponun **Settings** sekmesi → en altta **Danger Zone** → **Change visibility** → **Change to public**.
Private kalmasını isterseniz program yine kurulur ve çalışır; yalnızca otomatik güncelleme çalışmaz. O durumda yeni sürümleri Releases sayfasından elle indirip kurarsınız.

## Adım 2 — Eski dosyayı silin (yalnızca eski depoyu kullanıyorsanız)

Depo sayfasında eski `index.html` dosyasına tıklayın → sağ üstteki **⋯** → **Delete file** → **Commit changes**.

`main.js`, `package.json`, `.gitignore` ve `.github/workflows/build-release.yml` dosyalarını silmeyin; yenileri aynı adla yüklenince eskilerin üzerine yazılır.

## Adım 3 — Yeni dosyaları yükleyin (iki seferde)

GitHub'ın sayfası bir seferde en fazla 100 dosya kabul ediyor, bu proje 109 dosya. Bu yüzden iki seferde yüklüyoruz.

1. `recep-muhasebe-3.0.0.zip` dosyasına sağ tıklayın → **Tümünü ayıkla**. İçinden `recep-muhasebe` klasörü çıkar.
2. **Birinci yükleme:** depo sayfasında **Add file** → **Upload files** (yeni ve boş bir depoda bunun yerine **uploading an existing file** bağlantısı görünür). Bilgisayarda `recep-muhasebe` klasörünü açın, yalnızca **ui** klasörünü sürükleyip sayfaya bırakın. Yükleme bitince alttaki **Commit changes** düğmesine basın.
3. **İkinci yükleme:** yine **Add file** → **Upload files**. Bu sefer `ui` dışındaki her şeyi seçip sürükleyin:
   - klasörler: `.github`, `build`, `desktop`, `server`, `test`
   - dosyalar: `.gitignore`, `main.js`, `package.json`, `package-lock.json`, `preload.js`, `README.md`

   Sonra **Commit changes**.
4. Kontrol: depo ana sayfasında `.github`, `build`, `desktop`, `server`, `test` ve `ui` klasörleriyle dosyalar görünmeli.

İpuçları:
- Klasörleri sürükle-bırak ile yükleyin; "choose your files" penceresinden klasör seçilemiyor.
- `.github` klasörünü göremezseniz Dosya Gezgini'nde **Görünüm → Göster → Gizli öğeler**'i açın.
- `package.json` içine kullanıcı adınızı yazmanıza artık gerek yok; GitHub derlerken bunu kendisi dolduruyor.

## Adım 4 — İlk sürümü yayınlayın (v3.0.0)

1. Depo sayfasında sağdaki **Releases** → **Draft a new release** (veya **Create a new release**).
2. **Choose a tag** kutusuna küçük harfle `v3.0.0` yazın → **Create new tag: v3.0.0 on publish**.
3. Başlık: `Recep Muhasebe 3.0.0` → **Publish release**.
4. Üstteki **Actions** sekmesinde "Windows Kurulum Dosyası Derle ve Yayınla" çalışmaya başlar (sarı daire). 5–10 dakika sonra yeşil tik olur.

## Adım 5 — Kurulum dosyasını indirip kurun

1. **Releases** → **v3.0.0** → **Assets** altında `.exe` ile biten dosyayı indirin (`Recep-Muhasebe-Setup-3.0.0.exe`). Yanındaki `latest.yml` ve `.blockmap` dosyaları otomatik güncelleme içindir, onları indirmeyin.
2. Dosyaya çift tıklayın. Windows "Bilgisayarınız korundu" derse **Ek bilgi** → **Yine de çalıştır**. Program dijital imzalı olmadığı için bu uyarı normaldir.
3. Kurulum bitince masaüstündeki **Recep Muhasebe** simgesiyle açın.

Eski sürümün otomatik güncellemesi çalışmıyordu, bu yüzden bu ilk kurulumu elle yapıyorsunuz. Bundan sonraki güncellemeler kendiliğinden gelir.

## Adım 6 — İlk açılış: 5 adımlı kurulum

1. **Dil** seçin.
2. **Eski kayıtlar:** program eski Recep Muhasebe (veya Finora) kayıtlarını kendisi bulur ve "… kayıtları bulundu — 146 ürün, 18 fatura" gibi gösterir. Seçip devam edin.
   Bulamazsa **Yedek dosyasından al (.json)** ile Adım 0'daki dosyayı seçin.
3. Kuru kontrol edin ve **Kayıtları taşı**'ya basın. Ardından çıkan rapor, programın neleri düzelttiğini gösterir. Sizin kayıtlarınızda şunlar çıkacak:
   - USD olarak girilmiş ama aslında dinar olan iki ödeme (55.000 ve 40.000) dinar olarak alındı.
   - Para birimi yanlışlıkla "TRY" olan iki ürün (kod 47 ve 48) dinara çevrildi.
   - Bir müşterinin fazla ödediği 11.000 IQD, müşterinin alacağı olarak duruyor.
   - Bazı ürün kodları birden fazla üründe kullanılmış; listesi raporda.
   - USD kasası eksi görünüyor (−4.312,71). Eski programda açılış bakiyesi girilmemişti ve yanlış girilen ödemeler düzeltildi. Kasayı sayıp **Kasa sayımı** ile gerçek tutarı girin (Adım 7).
4. **Firma bilgileri**.
5. **Yönetici kullanıcı:** adınız ve bir **PIN** (4–8 rakam). Sonra **Kurulumu bitir**.

Eski dosyalarınız hiç değiştirilmez; yeni program kendi veritabanını kullanır.

## Adım 7 — İlk gün yapılacaklar

- **Kasa & Banka** → **Kasa sayımı** → USD kasasını seçip kasadaki gerçek parayı girin.
- **Ürünler:** rapordaki aynı kodu kullanan ürünleri düzeltin.
- **Kullanıcılar → Yeni kullanıcı:** çalışanları ekleyin; her birine rol (ör. Satış Personeli), PIN ve indirim sınırı verin.
- **Ayarlar → Yedekleme → Ek yedek klasörü:** bir USB bellek veya OneDrive klasörü seçin; günlük yedeğin bir kopyası oraya da gider.

## Adım 8 — Diğer bilgisayarlar ve telefonlar (isteğe bağlı)

1. Ana bilgisayarda **Ayarlar → Ağ (diğer cihazlar)** → **Ağdaki diğer cihazların bağlanmasına izin ver** → program yeniden başlar.
2. Windows Güvenlik Duvarı sorarsa **Erişime izin ver** deyin.
3. Aynı sayfada bir adres ve QR kod görünür, ör. `http://192.168.1.20:8642`. Diğer bilgisayarda Chrome'a bu adresi yazın; telefonda QR kodu okutun.
4. Her kullanıcının PIN'i veya şifresi olmalı. Şifresiz giriş yalnızca ana bilgisayardan yapılabilir.
5. Ana bilgisayar açık olduğu sürece diğerleri çalışır; bütün veriler ana bilgisayarda durur.

Bağlanamıyorsa: Windows'ta **Ayarlar → Ağ ve İnternet → Wi‑Fi** → bağlı olduğunuz ağ → **Özel ağ** seçili olmalı.

Güvenlik: bir kullanıcı 5 kez yanlış PIN girerse 30 saniye bekletilir; tekrarlanırsa süre uzar (en çok 30 dakika). Yönetici **Kullanıcılar** sayfasında o kişiyi açıp **Kilidi aç** ile hemen açabilir.

---

## Sonraki güncellemeler

Size yeni dosyalar verdiğimde:

1. Değişen dosya ve klasörleri aynı depoya yükleyin (Adım 3'teki gibi; eskilerin üzerine yazılır).
2. **Releases → Draft a new release** → bir üst numarayla yeni etiket: `v3.0.1`, `v3.1.0` … → **Publish release**.
3. `package.json` içindeki sürüm numarasını değiştirmenize gerek yok; numara etiketten alınır. Numara her zaman üç parçalı olmalı (`v3.0.1` gibi).

Kurulu programlar açılışta ve her 4 saatte bir kontrol eder, yeni sürümü indirir ve "Program şimdi yeniden başlatılıp güncellensin mi?" diye sorar. "Sonra" derseniz program kapanırken güncellenir. Güncellemeden önce verilerin yedeği otomatik alınır.
Elle kontrol için: **Ayarlar → Hakkında → Güncellemeleri denetle**.

## Verileriniz ve yedekler

- Veriler `%APPDATA%\Recep Muhasebe\data` klasöründe durur (**Ayarlar → Hakkında → Veri klasörünü aç**).
- Her gün otomatik yedek alınır (`data\backups`, son 30 yedek saklanır); güncellemeden önce de.
- **Ayarlar → Yedekleme → Şimdi yedek al** ile elle yedek alınır; geri yükleme de aynı sayfadadır.
- Programı kaldırmak verileri silmez.

## Sorun giderme

- **Eski kayıtlar bulunamadı:** kurulumun 2. adımında **Yedek dosyasından al (.json)** ile Adım 0'daki dosyayı seçin.
- **Actions'ta kırmızı çarpı:** çoğunlukla bir dosya eksik yüklenmiştir. Depo ana sayfasında `package.json`, `package-lock.json`, `main.js` ve `.github/workflows/build-release.yml` var mı bakın, eksik olanı yükleyin. Sonra yeni bir numarayla (ör. `v3.0.1`) tekrar yayınlayın.
- **Yeşil tik var ama .exe yok:** Releases sayfasını yenileyin (F5). Hâlâ yoksa yeni bir numarayla tekrar yayınlayın.
- **Yönetici PIN'i unutuldu:** programı kapatın. Windows'ta **Win + R** tuşlarına basın, `%APPDATA%\Recep Muhasebe\data` yazıp Enter'a basın. Açılan klasörde sağ tık → **Yeni → Metin Belgesi**, adını `SIFRE-SIFIRLA` yapın. Programı açın: yönetici bu bilgisayardan PIN'siz girer, sonra **Kullanıcılar** sayfasından kendine yeni PIN verir. Çalışanların PIN'ini yönetici her zaman Kullanıcılar sayfasından değiştirebilir.
- **Program açılmıyor:** bilgisayarı yeniden başlatın. Yine açılmazsa çıkan hata penceresinin fotoğrafını gönderin.

---

## Geliştirici notları

- `npm install`, sonra `npm start` (masaüstü), `npm run server` (yalnızca sunucu: http://127.0.0.1:8642) veya `npm test`.
- `main.js` masaüstü kabuğu (Electron); `server/` veritabanı (node:sqlite) ve API; `ui/` ekranlar (Preact + htm, derleme adımı yok); `desktop/olddata.js` eski programın kayıtlarını salt okunur bir kopyadan okur.
- `v` ile başlayan bir etiket gönderildiğinde `.github/workflows/build-release.yml` Windows kurulum dosyasını derleyip Releases'e yükler; depo adı ve sürüm numarası derleme sırasında otomatik ayarlanır.
