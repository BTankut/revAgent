# revAgent Modül Platformu ve Geliştirme Planı

Durum: Onaylandı (2026-06-10)

Bu plan, repo genelinde yapılan detaylı incelemenin (runtime MCP server,
Revit C# add-in, skill/mühendislik içeriği, installer/operasyon) çıktısına
dayanır ve revAgent'ın çok disiplinli modül platformuna evrim yolunu tanımlar.

Karar verilen çerçeve:

- Modül mimarisi: **tek runtime MCP server + modül paketleri** (disiplin
  başına ayrı MCP server veya ayrı repo modeli reddedildi).
- Schedule/BOQ derinleştirmeleri **kısa vadeli öncelik** (mevcut projede
  hemen lazım).
- Yeni disiplin modüllerinin ilk örneği: **platform tamamlanınca iskelet
  modül** (içerik sonra dolar).
- Bilinçli ertelenenler: dashboard auth (kapalı devre ofis ağı), Revit
  2023-2025 desteği (saha modeli Revit 2022), ayrı repo bölünmesi,
  DLL'lerin git dışına alınması.

---

## Hedef Mimari

VS Code benzetmesi: revAgent base = VS Code; disiplin modülleri =
eklentiler (Cline/Roo benzeri). Bir workstation'da aynı anda yalnız bir
modül aktif olur.

### revAgent Base (disiplinden bağımsız katman)

- C# Revit köprüsü: socket servisi, JSON-RPC, ExternalEvent altyapısı,
  dinamik C# yürütme, status penceresi
- Runtime MCP server çekirdeği: bağlantı/kilit yönetimi, status preflight,
  ortak yanıt zarfı, telemetri, guard çatısı
- Disiplinden bağımsız araçlar: status/context, view/navigasyon, image
  export, `inspect_*`, `set_element_parameter`, schedule araçları,
  `reconcile_schedule_excel`, dinamik kod araçları
- Installer, NAS updater, dashboard, revit-api-docs server
- Çekirdek SKILL katmanı: yürütme kontratı, transaction kuralları,
  tool-routing disiplini (disiplin içeriği olmadan)

### Disiplin Modülleri

Her modül bir paket:

- `modules/<disiplin>/skill/` - disiplin SKILL bölümü + references +
  patterns + evals
- `modules/<disiplin>/tools/` - disipline özel MCP araçları (TS tool pack)
- `modules/<disiplin>/commands/` - gerekiyorsa disipline özel native C#
  komutları
- `module.json` - ad, sürüm, kayıt edilecek araçlar, skill dosyaları,
  kategori/terim çıkarım kuralları

Workstation'da `C:\ProgramData\DPE\RevitMCP\config` altında **aktif modül**
tek bir ayarla seçilir. Runtime açılışta base araçlar + yalnız aktif
modülün araçlarını register eder; installer yalnız aktif modülün skill
içeriğini Codex'e bağlar. "Aynı anda iki modül asla" kuralı bu
tek-aktif-modül konfigürasyonuyla yapısal garantiye dönüşür.

Kritik tespit: bugün MEP bilgisi base'in içine gömülü -
`find_elements`'taki fan coil/vana/kanal kategori çıkarımı, SKILL.md'nin
tamamı, pattern'ler. Modülerleşmenin asıl işi yeni bir şey yazmak değil,
**bu gömülü MEP içeriğini "mekanik modül" olarak dışarı çekmek** ve base'i
nötrleştirmek.

---

## Faz 0 - Stabilite Düzeltmeleri

Modül platformunu çürük temele kurmamak için üç düzeltme; her şeyden önce
gelir.

1. **SocketClient yanıt karışması**
   (`installer/runtime-mcp-server/src/utils/SocketClient.ts:212-238`):
   ID'si eşleşmeyen hata yanıtının bekleyen callback'lere dağıtılması
   kaldırılır; yalnız ID eşleşmesi + uyarı logu. `socket-client.test.mjs`
   suite'ine eşzamanlı istek regresyon testi eklenir.
2. **Preflight/kilit sağlamlaştırma**
   (`installer/runtime-mcp-server/src/utils/ConnectionManager.ts:262-293`):
   kilit sahipliği dosyası atomik yazılır, bayat kilit eşiği
   yapılandırılabilir olur, kilit preflight'tan komut dönüşüne kadar
   tutulur.
3. **Safe-guard iyileştirme - iki adım**
   (`installer/runtime-mcp-server/src/tools/send_code_to_revit_safe_guards.ts`):
   önce hızlı kazanım olarak en agresif regex desenleri daraltılır ve
   bilinen güvenli kalıplar (örn. `FilteredElementCollector`) beyaz listeye
   alınır; kalıcı çözüm olarak yazma tespiti Revit tarafına **Roslyn AST
   analizi** olarak taşınır (kod zaten orada derleniyor - atama,
   transaction, `Document.Delete` çağrıları sözdizimi ağacından kesin
   tespit edilir). Yanlış pozitifler düşer; ajanın raw koda kaçma
   sürtünmesi kapanır.

Çıktı: hotfix sınıfı hataların kökü kapanmış, modülerleşme sırasındaki
davranış değişikliklerini yakalayacak test tabanı güçlenmiş olur.

## Faz 1 - BOQ/Schedule Hızlı Kazanımları

Faz 0 ile paralel başlar; platform beklemeden mevcut yapıda teslim
edilebilir ve mevcut projenin metraj/teslim işlerine doğrudan hizmet eder.

1. **İzolasyon metrajı:** `DuctInsulation`/`PipeInsulation` üzerinden
   kalınlık + yüzey alanı (m²) çıkaran yeni pattern
   (`references/patterns/insulation-takeoff.cs`) ve isteğe bağlı
   `boq_insulation` native akışı. Sistem/seviye/kalınlık kırılımı, Türkçe
   Excel uyumlu `;` ayraçlı çıktı.
2. **BOQ zenginleştirme:** `boq-duct.cs` / `boq-pipe.cs` dosyalarına
   fitting/aksesuvar envanterinin hat ilişkilendirmesi, malzeme/tip
   (yuvarlak-dikdörtgen, çelik-PPR), kanal sac ağırlığı (kg) ve vana/damper
   dökümü eklenir.
3. **Türkçe yerelleştirme referansı:**
   `references/system-classification.md` dosyasına Türkçe şablon
   karşılıkları ("Besleme Havası", "Atık Su" vb.) ve boş/özel
   sınıflandırma fallback kuralları; eval setine Türkçe BOQ/schedule
   senaryoları.
4. **Schedule akışı cilası:** `reconcile_schedule_excel` →
   `set_schedule_cells*` zincirinin uçtan uca Türkçe bir çalışılmış örneği
   `references/` altına eklenir (ofiste en yoğun kullanılan akış).

## Faz 2 - Modül Platformu (mimari temelin ana gövdesi)

Sıralı iş paketleri; her biri bağımsız merge edilebilir.

### 2a. Tek yanıt zarfı + araç fabrikası (ön koşul)

- `runtimeResult` / `broadScanResult` / `responseMode` tek bir zarf
  şemasında birleştirilir: `success/guarded/state/action/reason` + araç
  gövdesi + opsiyonel `partial/scanStoppedReason` bloku. Guard yanıtları
  tek şekle iner.
- `register.ts` içindeki 30 tekrarlı kayıt `createTool(definition)`
  fabrikasına alınır (şema + telemetri + hata yakalama + zarf otomatik).
  Bu fabrika, modül tool-pack'lerinin kayıt API'si olur - modül sistemi
  doğrudan bunun üstüne oturur.
- Araç açıklamaları 1-2 cümleye indirilir; ayrıntı SKILL/references'a
  taşınır (her tool çağrısındaki token maliyeti düşer).

### 2b. Modül manifesti ve yükleyici

- `module.json` şeması + runtime açılışında `loadModule(activeModule)`:
  base araçlar her zaman, modül araçları manifeste göre register edilir.
- `find_elements`'ın MEP terim/kategori çıkarımı, modül manifestinden
  beslenen **çıkarım kuralları** arayüzüne çekilir (base'de genel
  mekanizma, modülde kurallar).
- `get_revit_mcp_status.runtimeIdentity` alanına `activeModule` + modül
  sürümü eklenir; telemetri olaylarına modül boyutu girer (dashboard ve
  usage-intelligence kırılımı hazır olur).

### 2c. Skill katmanlaması

- SKILL.md ikiye bölünür: `skill-core` (yürütme kontratı, transaction,
  tool-routing, status disiplini - ~200 satır) +
  `modules/mechanical/skill` (MEP sınıfları, collectors, patterns, sistem
  sınıflandırma).
- AGENTS.md'deki kopya bloklar core'a referansla değiştirilir;
  "yaz-onayla" çelişkisi tek kurala bağlanır.
- Installer, Codex'e core + aktif modül skill'ini tek `revit-mcp` skill'i
  olarak birleştirip kurar (host tarafında değişiklik gerekmez).

### 2d. C# komut seti modülerleşmesi

- Mevcut `commandRegistry.json`/`command.json` kayıt tabanlı yapısına modül
  alanı eklenir; base komutlar + aktif modül komutları yüklenir.
- 15+ event handler'daki tekrar `ExternalEventHandlerBase<T>` taban
  sınıfına alınır. Bu, gelecekteki mimari/statik/elektrik komutlarının
  geliştirme hızını belirleyen kalemdir.
- Bu sırada `RevitMCPCommandSet.csproj` R25 konfigürasyonundaki eksik
  `REVIT2025_OR_GREATER` define düzeltilir (bedava düzeltme; sürüm desteği
  ayrıca ertelenmiş kalır).

### 2e. Installer/NAS modül farkındalığı

- `install-self-contained.ps1` ve NAS updater'a `-Module` parametresi /
  workstation config'i; release manifestine modül yüzeyi sınıflandırması
  (modül-only değişiklik → hızlı güncelleme yolu; mevcut "changed
  surfaces" mekanizmasının uzantısı).
- Payload-freshness manifesti modül klasörlerini kapsayacak şekilde
  genişletilir; pre-push hook'una freshness kontrolü bağlanır.

### Faz 2 kabul kriteri

Mevcut MEP davranışı, "mekanik modül aktif" konfigürasyonla birebir
korunur: mevcut test suite + canlı `scripts/test-commandset-live.ps1`
yeşil; modül kapalıyken base araçlar nötr çalışır.

## Faz 3 - Mekanik Modül Taşıması + İskelet Modül

1. **MEP içeriği resmen `modules/mechanical` olur:** skill, references,
   patterns, evals, `find_elements` çıkarım kuralları ve MEP'e özel her
   şey taşınır. Ofis workstation'ları bu modülle güncellenir - kullanıcı
   açısından hiçbir değişiklik hissedilmemelidir (platformun gerçek
   doğrulaması budur).
2. **İskelet modül (öneri: mimari):** minimal `module.json` + kısa skill
   (mahal/duvar/kapı-pencere kategorileri, temel collectors) + 1-2 basit
   araç (örn. mahal listesi/alan metrajı) + 1 eval. Amaç içerik değil,
   **ikinci modülün platformda sorunsuz yaşadığını kanıtlamak**: kurulum,
   modül geçişi, telemetri kırılımı, NAS güncelleme yolunun uçtan uca
   testi.
3. Modül geliştirme rehberi `docs/MODULE_DEVELOPMENT.md` yazılır (yeni
   modül = hangi dosyalar, hangi testler, hangi release adımları).

## Faz 4 - MEP Mühendislik Araçları (yeni proje için, mekanik modül içeriği)

Artık modül içine doğan araçlar, öncelik sırasıyla:

1. **`trace_mep_system`** (ConnectorManager topoloji gezintisi):
   kaynak→terminal yollar, açık konnektörler, ölü uçlar, akış yönü
   tutarsızlıkları; bounded-scan kontratıyla (mevcut `inspect_*` kalıbı).
2. **`check_system_integrity`:** sisteme atanmamış elemanlar, boyut
   uyumsuz birleşimler, çift bağlantılar - proje teslim QA listesi.
3. **Fitting dahil basınç kaybı (`calculate_pressure_drop`):**
   ASHRAE/CIBSE yerel kayıp katsayı (K) tablosu modül verisi olarak JSON,
   kritik devre tespiti, Darcy-Weisbach çapraz doğrulama → fan/pompa basma
   yüksekliği (TDH).
4. **Hız/boyutlandırma doğrulaması:** segment bazlı `V = Q/A`, disiplin
   limit tabloları (örn. besleme kanalı 6-8 m/s, kullanım suyu 0,6-1,5
   m/s), ihlal raporu + koordinasyon görseliyle entegrasyon.
5. Sonraki halka: oda bazlı havalandırma doğrulaması (linked space ↔
   menfez debisi), sprinkler hidrolik ön kontrol (K-faktörü + basınçtan
   baş başına debi, en uzak alan tespiti), kullanım suyu fixture-unit
   boyutlandırma.

## Faz 5 - Disiplin Modüllerinin İçeriklendirilmesi

Mimari iskeletin doldurulması, ardından statik ve elektrik modülleri - her
biri Faz 3'teki rehbere göre, ofiste o disiplinde ilk gerçek projeyle
birlikte içerik kazanır. Mekanikte işe yarayan "gerçek ihtiyaçtan araç
türetme + usage-intelligence ile aday tespiti" döngüsünün aynısı uygulanır.

## Bilinçli Ertelenenler

- Dashboard auth ve Cloudflare tüneli sertleştirmesi (kapalı devre
  çalıştığı sürece)
- Revit 2023-2025 desteği (yalnız `REVIT2025_OR_GREATER` define eksiği
  Faz 2d sırasında düzeltilir)
- Ayrı repo'lara bölünme
- Telemetri sampling (modül boyutu eklenirken basit bir eşik konabilir)
- DLL'lerin git dışına alınması

## Sıralama ve Bağımlılık Özeti

| Faz | İçerik | Bağımlılık | Göreli boyut |
| --- | --- | --- | --- |
| 0 | SocketClient, kilit, safe-guard | - | S-M |
| 1 | İzolasyon metrajı, BOQ zenginleştirme, TR yerelleştirme | - (0 ile paralel) | M |
| 2 | Zarf+fabrika, modül yükleyici, skill katmanlama, C# taban sınıf, installer | Faz 0 | L (ana gövde) |
| 3 | Mekanik modül taşıma + iskelet modül + rehber | Faz 2 | M |
| 4 | Topoloji + hesap araçları | Faz 3 | L |
| 5 | Mimari/statik/elektrik içerik | Faz 3 (4 ile paralel olabilir) | sürekli |

En riskli kalem Faz 2'nin "davranış birebir korunur" kabul kriteridir; bu
yüzden Faz 0'daki test güçlendirmesi pazarlık edilemez ön koşuldur.
