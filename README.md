# Recep Muhasebe 3

Şêrwan Car Detailing için muhasebe, stok, hızlı satış, servis ve kasa programı. Windows'ta çalışır; aynı ağdaki diğer bilgisayarlar tarayıcıdan bağlanabilir. Telefon uygulaması (Android ve iPhone) dükkânda ve dışarıda aynı programa bağlanır (Adım 9). Bilgisayar kapalıyken de telefondaki kopyayla çalışılabilir (Adım 10).

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
- **İnternetsiz çalışma (3.2):** telefon verilerin bir kopyasını tutar. Dükkândaki bilgisayar kapalıyken bütün kayıtlar görülür; satış, alış, tahsilat, ödeme ve gider yapılır. Bu işlemler bilgisayar açılınca kendiliğinden ona aktarılır.
- **Giriş güvenliği (3.2.1):** telefondan giriş için en az 6 haneli PIN; PIN değişince diğer cihazlardaki oturumlar kapanır; kaybolan bir telefonun oturumu bilgisayardan kapatılır (**Ayarlar → Güvenlik → Açık oturumlar**); telefondan art arda yanlış PIN girilirse bilgisayarda uyarı çıkar.
- **Alış masrafları (3.3):** alış faturasına gümrük, navlun ve diğer masraflar ayrı satırlar olarak girilir. Her masrafın kendi para birimi olur; kasadan ödendi, tedarikçinin hesabına ya da başka bir cariye (nakliyeci, gümrükçü) yazıldı diye seçilir. Masraflar faturadaki ürünlerin maliyetine eklenir: varsayılan olarak her adede eşit, istenirse fiyata göre orantılı. Faturada her ürünün masraf payı ve masraflı birim maliyeti, ürün kartında son alışın masraflı maliyeti görünür; ortalama maliyet, stok değeri ve satış kârı bu maliyetle hesaplanır. Satış fiyatları kendiliğinden değişmez. Tedarikçinin fatura toplamı da değişmez; tedarikçinin hesabına yazılan masraf, cari bakiyesinde ayrı bir satır olarak görünür.
- 4 dil: Türkçe, Kurdî (Badînî), العربية, English.
- Kullanıcılar ve yetkiler, PIN ile giriş, hatalı PIN denemelerinde bekletme.

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
4. Diğer cihazlardan girmek için her kullanıcının en az 6 haneli PIN'i veya şifresi olmalı. 4 haneli PIN ve şifresiz giriş yalnızca ana bilgisayarda çalışır.
5. Ana bilgisayar açık olduğu sürece diğerleri çalışır; bütün veriler ana bilgisayarda durur.

Bağlanamıyorsa: Windows'ta **Ayarlar → Ağ ve İnternet → Wi‑Fi** → bağlı olduğunuz ağ → **Özel ağ** seçili olmalı.

Güvenlik: bir kullanıcı 5 kez yanlış PIN girerse 30 saniye bekletilir; tekrarlanırsa süre uzar (en çok 30 dakika). Yönetici **Kullanıcılar** sayfasında o kişiyi açıp **Kilidi aç** ile hemen açabilir. Telefondan veya başka bir cihazdan art arda yanlış PIN girilirse yöneticinin ekranında uyarı çıkar (zil simgesinde de kalır).

Telefonlar için Adım 9'daki telefon uygulamasını kullanın: kamera ve ana ekrana ekleme yalnızca o güvenli adresle çalışır.

## Adım 9 — Telefon uygulaması (dükkânda ve dışarıda)

Telefon, dükkândaki bilgisayara ücretsiz **Tailscale** ağı üzerinden bağlanır. Yalnızca sizin hesabınızdaki cihazlar girebilir; program internete açılmaz. Telefondan çalışırken dükkândaki bilgisayar açık ve program çalışıyor olmalı.

**Dükkândaki bilgisayarda (bir kez):**
1. **Ayarlar → Telefon uygulaması** sayfasını açın. Sayfa her adımın durumunu gösterir.
2. **Tailscale'i indir** ile Tailscale'i kurun. Saatin yanındaki Tailscale simgesinden **Log in** ile bir Google hesabıyla giriş yapın.
3. **Telefon erişimini aç** düğmesine basın. Tailscale ilk seferde bir onay sayfası açabilir: o sayfada onaylayın (HTTPS / Serve). Onaydan sonra sayfada `https://…ts.net` ile biten adres ve bir QR kod görünür.
4. Telefondan girecek her kullanıcının en az 6 haneli PIN'i (veya en az 6 karakterli şifresi) olmalı; 4 haneli PIN yalnızca dükkândaki bilgisayarda çalışır. Sizin PIN'iniz yoksa ya da kısaysa aynı sayfadaki **Kendime PIN koy** / **PIN'imi değiştir** düğmesini kullanın.

**Telefonda:**
1. Google Play'den (Android) veya App Store'dan (iPhone) **Tailscale**'i kurun. Bilgisayardaki **aynı hesapla** giriş yapın ve bağlantıyı açın.
2. Telefonun kamerasıyla bilgisayardaki QR kodu okutun (veya adresi tarayıcıya yazın) ve PIN'inizle girin.
3. Ana ekrana ekleyin:
   - **Android:** Chrome menüsü (⋮) → **Uygulamayı yükle** (veya programdaki **Menü → Telefona yükle**).
   - **iPhone:** Safari'de **Paylaş** düğmesi → **Ana Ekrana Ekle**.
4. Artık **Recep** simgesiyle uygulama gibi açılır. Program bilgisayarda güncellenince telefon da kendiliğinden güncellenir.

**Telefonda neler var:** bütün ekranlar (satış, fatura, ürün, stok, cari, kasa, rapor, ayar). Alt menüde Panel, Satış, Faturalar, Ürünler ve Menü bulunur. Hızlı satışta ve faturada kamera düğmesiyle barkod okutulur; hızlı satışta her okutulan ürün sepete eklenir. Stok sayımında da kamerayla sayım yapılır. Yazdır düğmesi belgeyi telefonun yazdırma penceresinde açar (yazıcı veya PDF olarak kaydet).

**Güvenlik:** telefondan PIN'siz giriş yapılamaz; PIN en az 6 haneli olmalı. **Ayarlar → Güvenlik → Açık oturumlar** listesinde programa hangi bilgisayar ve telefonlardan girildiği görünür. Bir telefonu kaybederseniz:
1. login.tailscale.com sayfasından o cihazı silin.
2. **Ayarlar → Güvenlik → Açık oturumlar**'da o telefonun yanındaki **Çıkış yaptır**'a basın (internetsiz çalışan telefonu **Telefondaki kopyalar**'dan kaldırmak da çıkışını yaptırır).
3. **Kullanıcılar** ekranından o kullanıcının PIN'ini değiştirin. PIN değişince o kullanıcının diğer cihazlardaki oturumları da kendiliğinden kapanır.

---

## Adım 10 — İnternetsiz çalışma (bilgisayar kapalıyken telefondan)

Telefon, dükkândaki bilgisayarın verilerinin bir kopyasını kendi içinde tutar. Bilgisayar kapalıyken (ör. gece evde) uygulama bu kopyayla açılır.

**Açmak (bir kez, telefonda):**
1. Telefonda uygulamayı açın ve yönetici (admin) kullanıcıyla girin. Telefon dükkândaki bilgisayara ulaşabiliyor olmalı.
2. **Menü → Ayarlar → İnternetsiz çalışma** → **İnternetsiz çalışmayı aç**. Telefon ilk kopyayı alır ve kendi numara serisini öğrenir (ilk telefon `T1`).
3. Uygulamanın ana ekrana eklenmiş olması gerekir (Adım 9). Tarayıcı sekmesinde kalan kopyayı telefon bir süre sonra silebilir.

**Nasıl çalışır:**
- Telefon bilgisayara ulaşabildiği sürece kopya kendiliğinden güncellenir (açılışta ve birkaç dakikada bir, yalnızca bir şey değiştiyse).
- Bilgisayara ulaşılamayınca uygulama kopyayla açılır, PIN'inizi ister ve üstte **"İnternetsiz çalışıyor"** şeridi görünür. Bütün kayıtlar ve raporlar görülür. Satış, alış, iade, tahsilat, ödeme, gider, yeni müşteri ve ürün gibi işlemler yapılabilir.
- Bu işlemler sırayla saklanır. Bilgisayar açılınca (veya şeritteki **Bağlanmayı dene** ile) bilgisayara aktarılır. Ardından telefon güncel kopyayı alır ve normal çalışmaya döner.
- Telefonda internetsiz kesilen faturaların kendi numarası olur: `SF2026-T1-0001` gibi. Bilgisayara aktarılınca da aynı numarayla kalır, bilgisayardaki numaralarla çakışmaz.
- Ayarlar, kullanıcılar, yedekleme, kasa ve depo tanımları gibi yönetim işleri için bilgisayara bağlı olmak gerekir.

**Önemli:**
- Telefondaki kopya, uygulamanın bilgisayara en son ulaştığı andaki kadar yenidir. Dükkândan çıkmadan önce, bilgisayar kapanmadan uygulamayı bir kez açmanız yeterli.
- Bir kayıt hem bilgisayarda hem telefonda değiştirildiyse, telefondaki değişiklik bilgisayardakinin üzerine yazılmaz. Bilgisayarın kabul etmediği işlemler **Ayarlar → İnternetsiz çalışma → Aktarılamayan işlemler** listesinde görünür. Oradan **Yeniden dene**, **Telefondakini uygula** ya da **Yok say** seçilebilir. Aynı liste bilgisayarda **Ayarlar → Telefon uygulaması** sayfasında da görünür.
- Bu özellik yalnızca yönetici kullanıcı için açılır, çünkü telefonda dükkânın bütün verileri durur. Telefonun ekran kilidi mutlaka açık olsun. Telefon kaybolursa bilgisayarda **Ayarlar → Telefon uygulaması → Telefondaki kopyalar** bölümünden o telefonu **Kaldır**ın (oturumu da kapanır) ve PIN'inizi değiştirin.
- Telefondaki kopyayla (bilgisayar kapalıyken) girişte 4 haneli PIN de çalışır; 6 hane kuralı dükkândaki bilgisayara telefondan girerken geçerlidir.

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
- **Telefonda giriş yapılamıyor, "PIN'i yok" yazıyor:** bilgisayarda o kullanıcıya en az 6 haneli bir PIN verin (Kullanıcılar ekranı).
- **Telefonda "PIN veya şifre en az 6 haneli olmalı" yazıyor:** PIN 4 veya 5 hanelidir. Dükkândaki bilgisayarda **Kullanıcılar** ekranından (ya da menüdeki **Şifre / PIN değiştir** ile) en az 6 haneli yeni bir PIN verin. Telefonda hâlâ açık bir oturum varsa PIN orada da menüden değiştirilebilir. **Kullanıcılar** listesinde PIN'i kısa olanlarda **PIN kısa** yazar (PIN'i 3.2.1'den önce konmuş olanlarda bu, PIN bir kez girildikten sonra görünür).
- **Zilde "… kez yanlış PIN girildi" uyarısı var:** siz ya da çalışanınız değilseniz login.tailscale.com'da cihaz listesine bakın, tanımadığınız cihazı silin, **Ayarlar → Güvenlik → Açık oturumlar**'a bakın ve ilgili kullanıcının PIN'ini değiştirin.
- **Telefonda "İnternetsiz çalışıyor" şeridi kaybolmuyor:** bilgisayar açık mı, telefonda Tailscale bağlı mı bakın, sonra şeritteki **Bağlanmayı dene**'ye basın. Şeritte **Giriş yap** görünüyorsa bilgisayardaki oturum süresi dolmuştur: PIN'inizle girin, bekleyen işlemler ardından aktarılır.
- **"Uygulama başka bir pencerede açık":** telefonda uygulamanın açık olan diğer penceresini (veya tarayıcı sekmesini) kapatın. Kopyayı aynı anda yalnızca bir pencere kullanabilir.

---

## Geliştirici notları

- `npm install`, sonra `npm start` (masaüstü), `npm run server` (yalnızca sunucu: http://127.0.0.1:8642) veya `npm test`.
- `main.js` masaüstü kabuğu (Electron); `server/` veritabanı (node:sqlite) ve API; `ui/` ekranlar (Preact + htm, derleme adımı yok); `desktop/olddata.js` eski programın kayıtlarını salt okunur bir kopyadan okur.
- `v` ile başlayan bir etiket gönderildiğinde `.github/workflows/build-release.yml` Windows kurulum dosyasını derleyip Releases'e yükler; depo adı ve sürüm numarası derleme sırasında otomatik ayarlanır.
- Telefon uygulaması aynı arayüzdür (PWA): `ui/manifest.webmanifest`, `ui/sw.js` (programın dosyalarını `/app-files.json` listesine göre saklar; bilgisayar cevap verirken dosyalar ondan gelir), 760 px altı telefon görünümü (`usePhone`), `ui/js/core/scanner.js` (BarcodeDetector, yoksa `ui/vendor/zxing.min.js`), `ui/printview.html` (telefonda yazdırma). Bağlantı: `desktop/tailscale.js` → `tailscale serve --bg --yes http://127.0.0.1:PORT`; sunucu `*.ts.net` adını kabul eder ve 127.0.0.1'den gelen vekil isteklerini (X-Forwarded-For) telefonun adresiyle sayar, PIN'siz girişe izin vermez.
- İnternetsiz çalışma: telefon, sunucu kodunun kendisini (`server/` modülleri, `server/phone/bundle.js` ile tek bir tarayıcı modülüne paketlenir, `/phone/engine.js`) bir Web Worker'da (`ui/js/engine/worker.js`, `core.js`) SQLite WebAssembly (`ui/vendor/sqlite/`) üzerinde çalıştırır; veri OPFS'te (yoksa IndexedDB'de) durur. Kopya `GET /api/phone/snapshot` ile alınır (oturumlar, diğer kullanıcıların PIN'leri ve ürün fotoğrafları çıkarılır). Telefondaki yazma işlemleri (`server/phone/ops.js` listesindekiler) kendi kayıt kimlikleri, belge numaraları ve saatiyle sıraya alınır; `POST /api/phone/sync` bunları bilgisayarda aynı API işleyicileriyle, saat (`util.setClock`), kimlik (`db.setIdSource`) ve numara (`app.replayNos`) sabitlenerek yeniden oynatır. Her iş bir kez uygulanır (`phone_ops`); arada bilgisayarda değişmiş bir kaydı düzenleyen iş uygulanmaz, sorun olarak listelenir. Telefonun çevrimiçi yazmaları da `X-Op-Id` taşır, cevap kaybolursa ikinci kez uygulanmaz.
- Giriş güvenliği (3.2.1, şema v6): bilgisayarın kendisi dışından (`users.fromNetwork`: 127.0.0.1 değil ve telefonun kendi kopyası değil) gelen girişte 6 karakterden kısa PIN/şifre hiç denenmez (`remote_pin_short`, yalnız adres sayacına yazılır). Oturumların açık kimliği (`sessions.id`, belirteç hiç dışarı çıkmaz) ve telefon bağı (`sessions.device_id`: girişte `X-Device-Id`, kayıtta ve `/api/phone/state`'te bağlanır) vardır; `GET /api/auth/sessions`, `POST /api/auth/sessions/:id/end`, `POST /api/auth/sessions/end-others`. PIN/şifre değişince kullanıcının diğer oturumları, telefon kaldırılınca o telefonun oturumları kapanır; kaldırılmış bir telefon oturumla gelirse (`/api/phone/state`, `/sync`, `X-Device-Id` taşıyan yazma) o oturum da kapanır. Oturumu kapanan telefon giriş ekranında `GET /api/phone/removed` ile kaldırıldığını öğrenir ve kopyasını yalnızca gönderilmemiş işi yoksa siler. `users.pin_len` PIN konunca yazılır, eski PIN'lerde ilk doğru girişte öğrenilir. Telefondan gelen yanlış PIN'ler (kullanıcı ya da adres bekletilince) `users.manage` yetkisi olanlara `login_fails` bildirimi olarak çıkar.
- Alış masrafları (3.3, şema v7): `doc_costs` (tür `customs`/`freight`/`other`, açıklama, para birimi, tutar; `account_id` ile kasadan ödenir, `partner_id` ile o cariye, ikisi de yoksa tedarikçiye yazılır) ve `docs.cost_split` (`qty`: her adede eşit, `value`: satır tutarına göre; hiç tutar yoksa adede göre). `docs.extra_cost` belge para birimindeki toplamdır. Dağıtım yalnızca ürün satırlarına (`kind = 'product'`) yapılır; `doc_lines.extra_usd` satırın payı, `unit_cost_usd` masraflı birim maliyettir ve stok girişi bu maliyetle olur. Kasa hareketleri ve cari satırları `purchase_extra` türündedir, açıklamaları dükkânın dilinde masraf adıdır. Eski tek `extra_cost` alanını gönderen istemciler hâlâ çalışır (tek bir "diğer" masraf, fiyata göre); v7 göçü eski ek masrafları aynı şekilde `doc_costs`'a taşır.
