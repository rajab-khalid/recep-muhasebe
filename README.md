# Recep Muhasebe 3

Şêrwan Car Detailing için muhasebe, stok, hızlı satış, servis ve kasa programı. Windows'ta çalışır; aynı ağdaki diğer bilgisayarlar tarayıcıdan bağlanabilir. Telefon uygulaması (Android ve iPhone) dükkânda ve dışarıda aynı programa bağlanır (Adım 9).

Bu rehber programı GitHub'a yüklemek, kurulum dosyasını almak ve eski kayıtları taşımak için adım adım yazıldı. Toplam süre yaklaşık 30 dakika.

## Bu sürümde neler var

- **Stok defteri:** her giriş ve çıkış kayıtlı, ortalama maliyetle. Satışta o anki maliyet saklanır, kâr doğru çıkar.
- **Cari hesaplar para birimine göre:** USD ve IQD bakiyeleri ayrı tutulur. Ekstre, tahsilat, ödeme ve fatura kapama var.
- **Hiçbir belge silinmez, iptal edilir.** Her değişiklik İşlem Geçmişi'nde: kim, ne zaman, ne yaptı.
- **Kurallar:** kullanıcıya göre indirim sınırı, maliyetin altında satış engeli, müşteri kredi limiti.
- **Döviz bozdurma** kurlu transfer olarak kaydedilir; her belge kendi kurunu saklar.
- Hızlı satış ekranı, teklif, iş emri (servis), iade, alış, sipariş, sayım, depo transferi, gelir-gider ve raporlar.
- Her gün otomatik yedek, güncellemeden önce de yedek.
- **Ağ modu:** dükkândaki diğer bilgisayarlar tarayıcıdan bağlanır.
- **Telefon uygulaması (3.1):** aynı program telefonda; alt menü, kartlı listeler, telefona göre hızlı satış ve fatura ekranları, kamerayla barkod okuma. Dışarıdan da çalışır (Tailscale ile, ücretsiz).
- 4 dil: Türkçe, Kurdî (Badînî), العربية, English.
- Kullanıcılar ve yetkiler, PIN ile giriş, hatalı PIN denemelerinde bekletme.

Bu sürüme dahil olmayan: internetsiz çalışma. Telefon uygulaması dükkândaki bilgisayara bağlanarak çalışır; bilgisayar açık ve program çalışıyor olmalı.

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

GitHub'ın sayfası bir seferde en fazla 100 dosya kabul ediyor, bu proje 100'den fazla dosya. Bu yüzden iki seferde yüklüyoruz.

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

## Adım 8 — Diğer bilgisayarlar (isteğe bağlı)

1. Ana bilgisayarda **Ayarlar → Ağ (diğer cihazlar)** → **Ağdaki diğer cihazların bağlanmasına izin ver** → program yeniden başlar.
2. Windows Güvenlik Duvarı sorarsa **Erişime izin ver** deyin.
3. Aynı sayfada bir adres ve QR kod görünür, ör. `http://192.168.1.20:8642`. Diğer bilgisayarda Chrome'a bu adresi yazın.
4. Her kullanıcının PIN'i veya şifresi olmalı. Şifresiz giriş yalnızca ana bilgisayardan yapılabilir.
5. Ana bilgisayar açık olduğu sürece diğerleri çalışır; bütün veriler ana bilgisayarda durur.

Bağlanamıyorsa: Windows'ta **Ayarlar → Ağ ve İnternet → Wi‑Fi** → bağlı olduğunuz ağ → **Özel ağ** seçili olmalı.

Güvenlik: bir kullanıcı 5 kez yanlış PIN girerse 30 saniye bekletilir; tekrarlanırsa süre uzar (en çok 30 dakika). Yönetici **Kullanıcılar** sayfasında o kişiyi açıp **Kilidi aç** ile hemen açabilir.

Telefonlar için Adım 9'daki telefon uygulamasını kullanın: kamera ve ana ekrana ekleme yalnızca o güvenli adresle çalışır.

## Adım 9 — Telefon uygulaması (dükkânda ve dışarıda)

Telefon, dükkândaki bilgisayara ücretsiz **Tailscale** ağı üzerinden bağlanır. Yalnızca sizin hesabınızdaki cihazlar girebilir; program internete açılmaz. Telefondan çalışırken dükkândaki bilgisayar açık ve program çalışıyor olmalı.

**Dükkândaki bilgisayarda (bir kez):**
1. **Ayarlar → Telefon uygulaması** sayfasını açın. Sayfa her adımın durumunu gösterir.
2. **Tailscale'i indir** ile Tailscale'i kurun. Saatin yanındaki Tailscale simgesinden **Log in** ile bir Google hesabıyla giriş yapın.
3. **Telefon erişimini aç** düğmesine basın. Tailscale ilk seferde bir onay sayfası açabilir: o sayfada onaylayın (HTTPS / Serve). Onaydan sonra sayfada `https://…ts.net` ile biten adres ve bir QR kod görünür.
4. Telefondan girecek her kullanıcının PIN'i olmalı. Sizin PIN'iniz yoksa aynı sayfadaki **Kendime PIN koy** düğmesini kullanın.

**Telefonda:**
1. Google Play'den (Android) veya App Store'dan (iPhone) **Tailscale**'i kurun. Bilgisayardaki **aynı hesapla** giriş yapın ve bağlantıyı açın.
2. Telefonun kamerasıyla bilgisayardaki QR kodu okutun (veya adresi tarayıcıya yazın) ve PIN'inizle girin.
3. Ana ekrana ekleyin:
   - **Android:** Chrome menüsü (⋮) → **Uygulamayı yükle** (veya programdaki **Menü → Telefona yükle**).
   - **iPhone:** Safari'de **Paylaş** düğmesi → **Ana Ekrana Ekle**.
4. Artık **Recep** simgesiyle uygulama gibi açılır. Program bilgisayarda güncellenince telefon da kendiliğinden güncellenir.

**Telefonda neler var:** bütün ekranlar (satış, fatura, ürün, stok, cari, kasa, rapor, ayar). Alt menüde Panel, Satış, Faturalar, Ürünler ve Menü bulunur. Hızlı satışta ve faturada kamera düğmesiyle barkod okutulur; hızlı satışta her okutulan ürün sepete eklenir. Stok sayımında da kamerayla sayım yapılır. Yazdır düğmesi belgeyi telefonun yazdırma penceresinde açar (yazıcı veya PDF olarak kaydet).

**Güvenlik:** bir telefonu kaybederseniz login.tailscale.com sayfasından o cihazı silin ve Kullanıcılar ekranından o kullanıcının PIN'ini değiştirin. Telefondan PIN'siz giriş yapılamaz.

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
- **Telefonda "Dükkândaki bilgisayara ulaşılamıyor":** bilgisayar açık ve program çalışıyor mu, telefonda Tailscale "Connected" mı bakın. Bilgisayar açılınca telefondaki sayfa kendiliğinden programa geçer.
- **Telefonda kamera açılmıyor:** telefonun ayarlarından uygulamaya (Android'de Chrome'a, iPhone'da Safari'ye) kamera izni verin.
- **Telefonda giriş yapılamıyor, "PIN'i yok" yazıyor:** bilgisayarda o kullanıcıya PIN verin (Kullanıcılar ekranı).

---

## Geliştirici notları

- `npm install`, sonra `npm start` (masaüstü), `npm run server` (yalnızca sunucu: http://127.0.0.1:8642) veya `npm test`.
- `main.js` masaüstü kabuğu (Electron); `server/` veritabanı (node:sqlite) ve API; `ui/` ekranlar (Preact + htm, derleme adımı yok); `desktop/olddata.js` eski programın kayıtlarını salt okunur bir kopyadan okur.
- `v` ile başlayan bir etiket gönderildiğinde `.github/workflows/build-release.yml` Windows kurulum dosyasını derleyip Releases'e yükler; depo adı ve sürüm numarası derleme sırasında otomatik ayarlanır.
- Telefon uygulaması aynı arayüzdür (PWA): `ui/manifest.webmanifest`, `ui/sw.js` (yalnızca "ulaşılamıyor" sayfasını saklar, veri saklamaz), 760 px altı telefon görünümü (`usePhone`), `ui/js/core/scanner.js` (BarcodeDetector, yoksa `ui/vendor/zxing.min.js`), `ui/printview.html` (telefonda yazdırma). Bağlantı: `desktop/tailscale.js` → `tailscale serve --bg --yes http://127.0.0.1:PORT`; sunucu `*.ts.net` adını kabul eder ve 127.0.0.1'den gelen vekil isteklerini (X-Forwarded-For) telefonun adresiyle sayar, PIN'siz girişe izin vermez.
