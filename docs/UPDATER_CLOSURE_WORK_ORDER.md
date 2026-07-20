# revAgent Updater Kapanış + Tek-Tık Temiz Kurulum Çalışma Emri (v2)

> **Bu dosya bir kod asistanına verilecek talimat setidir.**
> Kaynak: `11020d1` (#259) üzerinde yapılan ikinci kapsamlı denetim (2026-07-19).
> Öncülü: `docs/UPDATER_STABILIZATION_WORK_ORDER.md` (G1–G14). O emirdeki görevlerin büyük kısmı
> #258 (`42d8141`) ve #259 (`11020d1`) ile uygulandı; bu emir (a) doğrulanmış kalan eksikleri kapatır,
> (b) **ana hedefi** gerçekleştirir: temiz makinede hızlı, fiilen tek-tık, G13 güven şartını koruyan
> kurulum + mevcut makinelerde kendi kendini onaran (self-healing) refresh.
> **Satır numaraları `11020d1` itibarıyladır — düzenlemeden önce her referansı yeniden doğrula.**
> `UPDATER_STABILIZATION_WORK_ORDER.md`'deki ZORUNLU KURALLAR R1–R7 burada da aynen geçerlidir; ek kurallar R8–R9 aşağıdadır.

---

## 0. Denetim sonucu — mevcut durum (asistan özetinin düzeltilmiş hali)

| Görev | Doğrulanmış durum | Not |
|---|---|---|
| G1 | TAMAM (kod+fixture) | Gerçek-makine kanıtı operatörde. Uyuyan yol notu: `Refresh...ps1`'de `Initialize-TrustedPowerShellModules` (:79) hiç çağrılmıyor; E2'de yeniden etkinleştirmede zorunlu (bkz. E2.1-c). |
| G2, G3, G4, G5, G10, G12 | TAMAM | G3'te minör: 10 sn sonrası yaşayan GUI'de stderr pipe'ı sahipsiz kalıyor (K3). |
| G6, G7, **G8**, G9 | UYUYAN (dormant) | **G8 "tamam" değildir** — G6/G7/G9 ile aynı uyuyan küme; exit 79-82 üretimde erişilemez. G7'nin fırsatçı %TEMP% temizliği HEAD'de hiçbir yerden çağrılmıyor (K2). |
| G11 | KISMİ | `--post-refresh` tüketicisi canlı (`Start-revAgent-Update.cmd:9-10,29-39`, exit 83), üreticisi YOK; `test-local-update-bootstrap.ps1:1138` üretilmemesini zorluyor. Risk yalnızca exit 84 kapısı sayesinde maskeleniyor. |
| G13 | **DEVRE DIŞI BIRAKARAK "çözüldü"** | Bağımsız doğrulama katmanı inşa edilmedi; #247 self-servis kurulum tamamen kapatıldı (`Refresh...ps1:1411-1414` koşulsuz exit 84). Kabul kriterleri aynı PR içinde değiştirildi. Bu emrin ana konusu budur (E2). |
| G14 | KISMİ | K1'de kapanacak. Bayat "fail-closed stable publish" metinleri: `installer/nas/README.md:614-615`, `docs/DEVELOPER_RUNBOOK.md:833-835` ve `:1075` (asistanın verdiği README:163 referansı yanlıştı). |
| #259 | G12'ye AİT DEĞİL | Split-privilege kurulumun makine-fazı gizli audit launcher regresyon düzeltmesidir; hiçbir G görevine karşılık gelmez (doğru ve gerekliydi). |

### ⚠️ K0 — KRİTİK OPERASYONEL BULGU: filo mahsur kalma riski (fleet-strand)

Exit 84 kapısı yalnız temiz makineleri değil, **mevcut makinelerin #245 bayat-bootstrap oto-yenilemesini de** kapattı:

- `Start-revAgent-Update.ps1:340-358` yerel bootstrap'ın **8 bileşenini** güncel imzalı release manifest'ine
  bayt-bayt bağlar; herhangi biri değişmiş bir yayın → `bootstrap_refresh_required` (:356) → launcher Refresh'e
  girer → koşulsuz **exit 84** (`revAgent Updater STABLE.cmd:65-75,107,127-130`). Kendi kendini onarma yolu yok.
- #258/#259, 8 bağlı bileşenden **en az 4'ünü değiştirdi** (`Start-revAgent-Update.ps1/.cmd`,
  `Install-revAgent-Updater-GUI.ps1`, `Invoke-revAgent-PrivilegedSnapshotUpdate.ps1`). Yani **bu içerikle
  yapılan ilk yayın, bootstrap'ı kurulu HER makineyi bir sonraki STABLE.cmd çalıştırmasında exit 84'e düşürür**
  ve her biri denetimli manuel prestage ister (makine başına ~2 saatlik mevcut prosedür).
- **D1 CEVAPLANDI — risk KURULU (armed):** NAS'taki güncel stable **`2026.07.20.574-11020d1a`**dır
  (#259/HEAD içeriği yayımlandı). Filo güncellenmedi; yalnızca O1–O4 sırasında kurulan **1 yeni makine**
  574'e bağlı ve sağlıklı. Diğer TÜM mevcut makinelerin bootstrap'ları eski release'e bağlı olduğundan,
  STABLE launcher'ı (veya masaüstü kısayolu → yerel launcher → `:RefreshStableIfBound`) bir dahaki
  çalıştırmalarında doğrulama `bootstrap_refresh_required` verecek → NAS'taki yeni refresh aracı →
  **exit 84 SECURITY STOP**. Etki: kurulu ürün çalışmaya devam eder (zamanlanmış görev audit-only),
  yalnızca güncelleme/GUI akışı bloklanır — makine başına bir IT dokunuşuna kadar.
- **Filo stratejisi (öneri):** Mevcut makinelere ~2 saatlik manuel prestage koşturMA. Acil güncelleme
  gereken tekil makine çıkarsa E1 kitiyle çöz; filo genelini **E2 tamamlandıktan sonra TEK geçişte**
  E2-etkin kit ile ele al (güven çekirdeği + broker + 574+ rebind aynı dokunuşta) — böylece her makineye
  bir daha asla elle dokunulmaz. 574'teki yeni makine de E2 yayını rebind edeceği için aynı tek geçişe dahildir.

### Ek zorunlu kurallar

- **R8 — Uyuyan-kilit testleri:** Dormancy'yi kilitleyen assertion'lar (`test-installer-smoke.ps1:~1462-1467`,
  `test-updater-stabilization-g7-g9.ps1:156-166,509-516`, `test-clean-install-bootstrap.ps1:239-364`,
  `test-local-update-bootstrap.ps1:1138`) davranışı yeniden etkinleştiren değişiklikle **aynı commit'te**
  bilinçli olarak güncellenmelidir; asla "testi geçirmek için" ayrı commit'te gevşetilmez.
  `test-updater-stabilization-g7-g9.ps1:519-520` (EncodedCommand / UNC-`-File` yasağı) G6 sözleşmesini
  kilitler — bunlar KORUNUR.
- **R9 — 8-bileşen rebind farkındalığı:** `Start-revAgent-Update.ps1:340-349`'daki bağlı bileşen listesindeki
  herhangi bir dosyayı değiştiren her PR, açıklamasında "bu yayın filo re-prestage/broker-refresh gerektirir"
  uyarısını taşımalı; CHANGELOG'a aynı uyarı yazılmalıdır (E2 canlıya çıkana kadar).

---

## BÖLÜM A — Kapanış görevleri (küçük, önce bunlar)

### K1 (P1) — G14 kapanışı: dokümantasyon ve kayıt düzeltmeleri

1. Bayat "stable publish fail-closed" metinlerini gerçek durumla değiştir (transactional exact-handle stable
   publish uygulanmış ve etkin): `installer/nas/README.md:614-615`, `docs/DEVELOPER_RUNBOOK.md:833-835`,
   `docs/DEVELOPER_RUNBOOK.md:1075-1076`.
2. `CHANGELOG.md`: (a) #233–#256 serisinin özet girdilerini ekle (temiz-makine desteği → sonradan G13 ile
   devre dışı, launcher auto-refresh, publisher hizalaması); (b) **K0 filo-mahsur uyarısını açıkça yaz**
   ("bu içerikli ilk yayın mevcut bootstrap'ları rebind eder; E2 öncesi yayınlar filo re-prestage gerektirir");
   (c) bir sonraki NAS yayınında `Unreleased` altındakileri gerçek sürüm başlığına taşımayı O3 notu olarak ekle.
3. `docs/UPDATER_STABILIZATION_WORK_ORDER.md`: O3/O4 "Durum: yapılmadı" satırlarını operatörün fiilen
   tamamladığı bilgisiyle güncelle (tarih + "manuel, ~2 saat" notu) ve dosyanın başına bu v2 emrine işaret eden
   bir "superseded-by" notu ekle; yukarıdaki düzeltilmiş durum tablosunu ekle (G8=dormant, G13=disabled-not-built,
   #259 attribution düzeltmesi).
4. `installer/nas/README.md:294-300` civarına K0 sonucunu açıkça yaz: hangi 8 dosya bağlı, rebind'in filo
   etkisi nedir, E2 öncesi yayın disiplini nedir.

### K2 (P1) — G7 artıklarının canlı temizliği

`Remove-StaleRevAgentBootstrapTemporaryItems` (`Refresh...ps1:631-690`) HEAD'de sıfır çağrı: kullanıcının
önceki başarısız denemelerinden kalan `%TEMP%\revagent-bootstrap-*-source-*` dizinlerini bugün hiçbir şey
temizlemiyor. Refresh ana gövdesi artık I/O yapmadığı için doğal ev sahibi GUI'dir: GUI başlangıcının
pencere-sonrası güvenli bir noktasına (form Shown sonrası, best-effort, hatası yutulur) fırsatçı temizlik
çağrısını ekle **veya** temizliği `Start-revAgent-Update.ps1` doğrulama-başarılı yoluna koy. Fonksiyonun
bounded/no-follow/identity-guard sözleşmesini bozma; `test-updater-stabilization-g7-g9.ps1`'deki ilgili
fixture'ları üreticiye bağla (R8).

### K3 (P2) — G3 minör: sahipsiz stderr pipe

`Start-revAgent-Update.ps1:99-100`: GUI 10 sn'den uzun yaşadığında `ReadToEndAsync` pipe'ı sahipsiz kalıyor;
uzun ömürlü GUI büyük stderr yazarsa bloklanabilir. Başarı-yolunda pipe'ı güvenle serbest bırak
(örn. arka planda drain etmeye devam eden dosyaya-yönlendirme, ya da başarı tespitinde stream'i kapatıp
child'ın stderr'ini `%LOCALAPPDATA%` log dosyasına doğrudan yönlendirme). Mevcut test sözleşmesini
(`test-local-update-bootstrap.ps1:67,92-127`) koru/güncelle.

---

## BÖLÜM B — ANA HEDEF: tek-tık temiz kurulum + self-healing refresh

Tasarım değerlendirmesinin sonucu (seçenek analizi denetim kaydındadır): **iki aşamalı plan.**
Karar kaydı: G13'ün belgelenmiş yeniden-etkinleştirme koşulunun ikinci dalı kullanılacaktır —
"IT-prestaged machine verifier + pinned production key" (`docs/BOOTSTRAP_PRESTAGE.md:46-48`).
Authenticode sertifika yolu (E3) yalnızca opsiyoneldir.

### E1 (P0, interim — bu hafta) — Tek-tık ADMIN prestage kiti

**Amaç:** `docs/BOOTSTRAP_PRESTAGE.md`'nin iki-shell manuel törenini (repo checkout + 4 literal'in elle
taşınması + ~385 satırlık blok yapıştırma ≈ 2 saat) admin'in hedef makinede çift tıkladığı tek araca indir
(<5 dk). Üretim exit-84 kapısına, launcher'lara, publisher'a, dormancy kilitlerine **dokunma** — sıfır risk.

**Yapılacaklar:**
1. `scripts/Invoke-RevAgentSupervisedPrestage.ps1` (sürücü): BOOTSTRAP_PRESTAGE.md'deki elevated literal
   bloğun (:108-493) birebir betikleştirilmiş hali + evidence üretici çağrısı + 4 literal'in dosya-içi
   (elle transkripsiyon yok) aktarımı. Legacy `DPE` ACL göçü dahil; taze makine kısa yolu korunur.
2. `scripts/IT-Prestage-revAgent.cmd`: "Run as administrator" sarmalayıcı; LanguageMode guard'ı (exit 78)
   ve net hata mesajları ile.
3. `scripts/New-RevAgentBootstrapPrestageEvidence.ps1:38-40`'taki "elevated çalışmayı reddet" kuralına
   denetlenebilir bir `-SupervisedAdminPrestage` anahtarı ekle (bu akışta üretici ile tüketici aynı admin
   prensipli — doktrinin hedeflediği "standart kullanıcı süreci elevated shell'i beslemesin" ihlali yok);
   anahtar kullanımı evidence çıktısına işlenir.
4. **Kit paketleme:** ~5 dosyalık kit (`IT-Prestage-revAgent.cmd`, sürücü, `New-RevAgentBootstrapPrestageEvidence.ps1`,
   `installer/lib/RevAgent.DistributionIntegrity.psm1`, `release-trusted-keys.json`) — CD'ye artifact olarak
   üretim adımı ekle (`.github/workflows/signed-source-free-cd.yml`), kit SHA-256'sı kaydedilir.
   **Kural:** kit yazılabilir NAS tools paylaşımına KONMAZ (`BOOTSTRAP_PRESTAGE.md:9-12` ihlali olur);
   IT-only kanal (ayrı paylaşım/USB/MDM) — dokümante et.
5. `docs/BOOTSTRAP_PRESTAGE.md`'yi yeniden yaz: manuel tören "acil durum yedeği"ne iner, kit birincil yol olur.
6. Testler: sürücünün AST/regex bütünlük kontrolleri + evidence-üretici anahtar semantiği smoke testi
   (Windows-yalnız kısımlar CI PS 5.1 adımına).

**Kabul:** Temiz fixture'da kit sürücüsü uçtan uca (mock elevation ile) prestage'i tamamlar; belgelenmiş
admin deneyimi: tek çift-tık, <5 dk, elle veri taşıma yok.

### E2 (P0, birincil — sonraki kilometre taşı) — Makine güven çekirdeği + zamanlanmış-görev broker'ı: gerçek tek-tık

**Mimari (karar):** Bir defalık IT prestage'i (E1 kitiyle) makineye **admin-only güven çekirdeği** kurar:
`C:\ProgramData\DPE\revAgent\trust\` altında (a) `release-trusted-keys.json` (pinli
`revagent-prod-rsa-2026q3` / `32F8BD0B...`), (b) **release-BAĞIMSIZ broker betiği** (detached RS256
kanal/release imzalarını + paket hash'ini kendi pinli anahtarıyla yeniden doğrular, imzalı manifest'ten
türetilen evidence/installer hash'lerini kontrol eder, staged installer'ı çalıştırır), (c) önceden
kaydedilmiş SYSTEM zamanlanmış görevi (Action = SABİT broker yolu + SABİT argümanlar; Authenticated Users
başlatabilir). Şablon olarak repo'daki kanıtlanmış kalıbı kullan: `Invoke-revAgent-PrivilegedSnapshotUpdate.ps1`
(admin-owned yerel giriş, imzaları bağımsız yeniden doğrular, hassas argümanlar broker'da).

Akış (hem temiz kurulum hem bayat refresh — K0'ı çözer): standart kullanıcı fazı NAS baytlarını yerel
staging'e alır (`New-CleanInstallBootstrapInput:1140-1230` değişmeden — transport zaten güvensiz kabul),
broker görevini başlatır ve **hazır nonce/marker makinesiyle** bekler (`Write/Read marker:692-754`,
`Wait-RevAgentBootstrapCoordinator:766-869`, mutex/duplicate guard `:1258-1273`). Broker SYSTEM olarak
admin-only yoldan çalışır, YEREL staged kopyaların imzasını kendi anahtarıyla doğrular (NAS'a SYSTEM
erişimi sorunu yok), uygular. **UAC yok — standart kullanıcı için gerçek tek çift-tık, ~2-4 dk.**

**Yapılacaklar:**
1. **Ana dispatch'i yeniden kur** (`Invoke-RevAgentBootstrapRefreshMain`, `Refresh...ps1:1411-1414`):
   a. güven çekirdeği mevcut + broker görevi kayıtlı → staging + görev başlat + marker bekle
      (başarı → `--post-refresh` ile yerel launcher, bkz. adım 5); çekirdek yoksa → mevcut exit 84 mesajı
      (E1 kitine yönlendirme metniyle güncellenmiş).
   b. `-ElevatedApply`/`-CoordinatorRelaunchedFromAdmin` uyuyan UAC-transport dalları: broker-görev
      transportu birincil olduğundan bu dalları YA bilinçli olarak sil (tercih; ölü yüzeyi küçültür)
      YA broker-yok makineler için ikincil yol olarak aktive et — seçimi PR'da gerekçelendir. Aktive
      edilecekse `Invoke-AuthenticatedBootstrapApply:1358-1409` **caller-supplied
      `TrustedKeysSource`/`Expected*` parametrelerini YOK SAYIP** beklentileri güven çekirdeğinden türetecek
      şekilde yeniden bağlanmalıdır (G13'ün özü budur; A-0.6).
   c. `Initialize-TrustedPowerShellModules` (:79) staging'den önce çağrılır (G1 uyuyan-yol boşluğu).
2. **Broker** (`installer/nas/…` yeni dosya; kit + prestage tarafından `trust\`e kurulur): minimal, release-bağımsız,
   tüm girdileri düşman kabul eder (sabit kanonik release kökü — `New-RevAgentBootstrapPrestageEvidence.ps1:34,41-43`
   kalıbı; caller-controlled `-File`/argüman yok; tek-örnek mutex; nonce-bound sonuç). Marker/sonuç dosyaları
   kullanıcı `%TEMP%`'inden **ACL'li ProgramData sonuç dizinine** taşınır (`:1284` mevcut %TEMP% kökü değişir).
3. **E1 kiti genişletmesi:** kit, güven çekirdeğini + broker'ı + SYSTEM görevini de kurar (tek IT dokunuşu her
   makinede her şeyi bitirir; MDM varsa filoya tek push).
4. **Temizlik/UX bağlantıları:** başarı yolunda `Remove-RevAgentBootstrapTemporaryInput` (finally) +
   `Remove-StaleRevAgentBootstrapTemporaryItems` fırsatçı süpürme (K2 ile birleşir); UAC-decline (79),
   coordinator-busy (80/81), LUA (82) kodları hangi transport kalıyorsa ona göre canlanır ya da silinir.
5. **G11 üreticisi:** başarılı apply sonrası yerel launcher `--post-refresh` ile başlatılır;
   `test-local-update-bootstrap.ps1:1138` tersine çevrilir (R8) — exit 83 kesici gerçek anlamda canlanır.
6. **R8 test rewiring:** dormancy kilitleri (smoke `:1462-1467`, g7-g9 `:156-166,509-516`,
   clean-install `:239-364`) yeni sözleşmeye çevrilir; `test-clean-install-bootstrap.ps1`'e broker-yolu
   E2E fixture'ı eklenir (mock SYSTEM görevi + gerçek PS 5.1 çocukları; kalıp `test-local-update-bootstrap.ps1:185-198`).
7. **Readiness + publisher:** `check-signed-stable-readiness.ps1`'e güven çekirdeği/broker/görev sağlık
   kontrolleri (yalnız rapor; NAS'tan kurulum yapılmaz); R3 üçlemesi launcher metin değişiklikleri için korunur.
8. **Anahtar rotasyonu hazırlığı:** `2026q3` id'si çeyreklik rotasyon ima eder; iki-anahtarlı geçiş penceresi
   için "tam-bir-anahtar" assert'leri (`publish-signed-source-free-release-to-nas.ps1:1521-1522`,
   `invoke-signed-source-free-cd.ps1:285-286`) çok-anahtarlı doğrulamaya genişletilir; broker rotasyonda
   çekirdek anahtar dosyasının admin-kanaldan güncellenmesini gerektirir — dokümante et.
9. **Dokümantasyon:** README/BOOTSTRAP_PRESTAGE/RUNBOOK yeni akışı anlatır; CHANGELOG'da K0 uyarısı
   "E2 ile çözüldü" kaydına döner.

**Kabul kriterleri:** (1) fixture'da temiz makine: STABLE.cmd → staging → broker → bootstrap kuruldu →
`--post-refresh` launcher → doğrulama → GUI, tek kullanıcı etkileşimi çift-tık; (2) fixture'da bayat makine
(8-bileşen rebind simülasyonu): aynı zincir kendini onarır — **K0 kapanmıştır**; (3) broker hiçbir
caller-supplied güven verisi kabul etmez (testle kilitli); (4) çekirdeksiz makine bugünkü gibi net exit 84
+ E1 yönlendirmesi alır; (5) `scripts/test-all.ps1` + CI yeşil.

### E3 (opsiyonel, uzun vade) — Authenticode

Yalnızca (a) filoda SAC/WDAC makineleri (exit 78) gerçekten görülürse veya (b) UAC diyaloğunda kurum
yayıncı kimliği istenirse: kod-imza sertifikası + CD imzalama adımı (imzalama → hash sırası publisher
pinning omurgasını değiştirir!) + GPO Trusted Publishers/AllSigned veya WDAC + tercihen imzalı EXE broker
şimi. Bugün başlatma; E2 bunu gerektirmez.

---

## Operatöre (Barış) karar/aksiyon soruları — asistan bunları PR açıklamasında yanıt bekleyen kutu olarak listeler

- **D1 (CEVAPLANDI, 2026-07-20):** Evet — NAS'ta `Stable 2026.07.20.574-11020d1a` yayımlandı; filo
  güncellenmedi, yalnız 1 yeni makine 574 ile kuruldu. K0 kurulu durumda → E1 kiti acil; filo tek geçişi
  E2 sonrasına planlanır (bkz. K0 filo stratejisi).
- **D2:** G13 çıtası: "ürün akışı kullanıcı güveni aklayamaz" (E2, öneri) yeterli mi, yoksa "UAC diyaloğu
  yayıncıyı kanıtlamalı" (E3) mı isteniyor?
- **D3:** DPE'de MDM/GPO erişimi var mı? (Varsa E1/E2 kiti filoya tek push; yoksa makine başına bir IT dokunuşu.)
- **D4:** Anahtar rotasyon takvimi (`2026q3` → `2026q4`) ve iki-anahtar geçiş penceresi onayı.

## Çalışma düzeni

Sıra: K1 → K2 → K3 → E1 → E2 (E3 ayrı karar). **Görev başına ayrı PR** (bu kez tek squash'a izin verme —
K0 gibi mimari sonuçların gözden kaçmasının nedeni tek dev commit'ti); her PR'da R1–R9 kontrol listesi.
E2 bitmeden 8 bağlı dosyaya dokunan hiçbir yayın yapılmaz (R9); E2 sonrası ilk yayın, fixture'daki
bayat-makine self-heal kanıtıyla birlikte gider.
