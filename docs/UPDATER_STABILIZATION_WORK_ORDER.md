# revAgent Updater/Installer Stabilizasyon Çalışma Emri

> **Bu dosya bir kod asistanına verilecek talimat setidir.**
> Kaynak: `f7e5c7c` (#256) üzerinde yapılan kapsamlı denetim (2026-07-19).
> Denetim kapsamı: #221 (`2e6d41f`, "Harden updater for unified ChatGPT/Codex desktop") sonrası 35 commit'lik
> düzeltme zinciri + temiz makinede "installer GUI açılır açılmaz terminalde hata verip çöküyor" saha raporu.
> Buradaki her bulgu statik analizle doğrulanmış ve dosya:satır kanıtına bağlanmıştır.
> **Satır numaraları `f7e5c7c` itibarıyladır — düzenlemeye başlamadan önce her referansı yeniden doğrula.**

---

## 0. Bağlam ve ZORUNLU KURALLAR (önce bunu oku)

### Mimari özet

- Kullanıcılar NAS'tan (`\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy`) kurulum/güncelleme yapar.
  Tek desteklenen giriş noktası **`revAgent Updater STABLE.cmd`**'dir: yerel korumalı bootstrap
  (`%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1`) yoksa (temiz makine)
  `%RELEASE_ROOT%\tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd`'yi çağırır; varsa `-VerificationOnly`
  ile doğrular ve bootstrap'ı gizli pencerede başlatır. Bootstrap, GUI'yi
  (`Install-revAgent-Updater-GUI.ps1`) hash doğrulamasından sonra başlatır.
- **Kritik gerçek:** NAS'taki `tools\revAgent Updater STABLE.cmd` repo dosyasının kopyası DEĞİLDİR;
  publisher (`scripts/publish-signed-source-free-release-to-nas.ps1`) onu kendi içindeki gömülü şablondan
  (`Get-RevAgentStableLauncherBytes`, ~satır 887-965) üretir. #246, #255 ve #256 hataları hep
  "repo düzeltildi ama şablon/staged liste güncellenmedi" sınıfındandı.
- Üretim stable yayını NAS `tools\` ağacında **yalnızca 4 dosya** yazar: üretilen
  `revAgent Updater STABLE.cmd`, `Refresh-revAgent-LocalBootstrap-STABLE.cmd`/`.ps1` ve (#256'dan beri)
  `Revit MCP Updater STABLE.cmd` alias'ı. Geri kalan her şey (GUI betikleri, lib modülleri, legacy
  `Install-*.cmd` girişleri) NAS'ta **donmuş** durumdadır ve hiçbir yayınla yenilenmez/silinmez.

### Zorunlu kurallar — her görevde geçerli

- **R1 — PS 5.1 hedefi:** Kullanıcı makineleri Windows PowerShell 5.1 çalıştırır
  (`%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe`). PS7-only sözdizimi **yasak**: ternary
  (`a ? b : c`), `??`, `??=`, `?.`, `?[]`, `clean {}` blokları, pipeline chain `&&`/`||`.
  Bunlar parse hatasıdır → betik açılır açılmaz çöker (sahadaki semptomun ta kendisi).
- **R2 — StringComparison yasağı:** `installer/nas/Refresh-revAgent-LocalBootstrap-STABLE.ps1` içinde
  `[StringComparison]` metot overload'ları yasaktır (#248; `scripts/test-installer-smoke.ps1` bunu regex ile
  zorlar). Bu dosyada mevcut `Test-RevAgentStringEquals` / `Test-RevAgentStringStartsWith` yardımcılarını kullan.
- **R3 — Launcher üçlemesi:** `.cmd` launcher davranışını değiştiren HER değişiklik eşzamanlı olarak
  ÜÇ yerde yapılmalıdır: (1) repo dosyası `installer/nas/*.cmd`, (2) publisher şablonu
  `Get-RevAgentStableLauncherBytes`, (3) publisher'ın staged tool listesi
  (`Set-RevAgentStableBootstrapToolsExact`, ~satır 1079). Ayrıca ilgili regex assertion'ları:
  `scripts/test-installer-smoke.ps1` (~1387-1396) ve `scripts/test-signed-source-free-cd.ps1` (~965-966).
- **R4 — CI lockstep:** CI, self-hosted Windows runner'da GERÇEK PS 5.1 ile koşar
  (`.github/workflows/ci.yml` ~satır 20, 38-46). Bazı testler `$PSHOME` Archive yolunu CI tarafında da
  sabitler — G1'deki kod değişikliği bu testlerle **aynı commit'te** güncellenmezse CI kırılır.
- **R5 — CD testinin ".cmd yok" assertion'ları:** `scripts/test-signed-source-free-cd.ps1:256` ve `:512`
  fixture NAS'ta sıfır `.cmd` olduğunu assert eder; üretim launcher-yayınlama dalı hiçbir testte çalışmaz.
  `.cmd` üreten/yöneten bir değişiklik yapıyorsan bu assertion'ları bilinçli olarak ele al (bkz. G12).
- **R6 — Doğrulama:** Her görevden sonra en az `scripts/test-installer-smoke.ps1`,
  `scripts/test-local-update-bootstrap.ps1`, `scripts/test-signed-source-free-cd.ps1` ve
  `scripts/test-codex-integration-security.ps1`'i; PR'dan önce `scripts/test-all.ps1`'i çalıştır
  (Windows ortamı gerekir; yoksa CI'a bırak ama statik/regex kontrollerini yerelde yap).
- **R7 — Hata mesajları:** Kullanıcıya görünen yeni mesajlar mevcut üsluba uysun (İngilizce teknik metin;
  operatör talimatı gereken yerlerde mevcut örneklerdeki gibi kısa Türkçe yönlendirme eklenebilir).
  Her yeni hata mesajı benzersiz ve grep'lenebilir olsun (saha teşhisi bu metinlerle yapılıyor — bkz. Ek-1).

---

## Görevler (öncelik sırasıyla)

### G1 (P0) — Archive modülünün `$PSHOME` sabitlemesini kaldır (anlık çökme adayı #1)

**Neden:** Beş giriş betiği, başka hiçbir kod çalışmadan önce
`$PSHOME\Modules\Microsoft.PowerShell.Archive\Microsoft.PowerShell.Archive.psd1` yoksa throw eder.
PS 5.1'de `$PSHOME` = `C:\Windows\System32\WindowsPowerShell\v1.0` ve Archive modülünün inbox konumu
birçok imajda `%ProgramFiles%\WindowsPowerShell\Modules\Microsoft.PowerShell.Archive\1.0.1.0`'dır —
yani kontrol **makineye/imaja bağlı** olarak anında patlar. İronik olan: aynı fonksiyonların
`candidateRoots` listesi Program Files köklerini zaten güvenilir kabul ediyor.

**Dosyalar (throw satırları doğrulandı):**
- `installer/nas/Install-revAgent-Updater-GUI.ps1:47-51` (`Initialize-GuiTrustedPowerShellModules`)
- `installer/nas/Refresh-revAgent-LocalBootstrap-STABLE.ps1:22-37` (throw @32 — mesaj: "Required trusted PowerShell module was not found")
- `installer/nas/update-from-nas.ps1:111` (çağrı @~120)
- `installer/nas/install-updater-task.ps1:101` (çağrı @~110)
- `installer/nas/Invoke-revAgent-CodexUserIntegration.ps1:56` (çağrı @~62)
- `installer/install-self-contained.ps1:61`
- Ayrıca `installer/nas/Start-revAgent-Update.ps1` ve `installer/nas/Invoke-revAgent-PrivilegedSnapshotUpdate.ps1`'de
  aynı kalıp var mı diye tara; varsa aynı düzeltmeyi uygula.

**Yapılacak:** `Microsoft.PowerShell.Management/Utility/Security` ve `CimCmdlets` için `$PSHOME` şartı kalsın
(bunlar gerçekten oradadır). **Yalnızca `Microsoft.PowerShell.Archive` için**: manifest'i, fonksiyonun zaten
doğruladığı güvenilir kökler içinde sırayla ara — önce `$PSHOME\Modules\...`, yoksa
`%ProgramFiles%\WindowsPowerShell\Modules\Microsoft.PowerShell.Archive\<sürüm>\Microsoft.PowerShell.Archive.psd1`
(sürüm dizinini deterministik seç: en yüksek `[version]` sıralaması), yoksa x86 karşılığı. Hiçbirinde yoksa
mevcut throw kalsın ama mesaj bulunamayan TÜM aranan yolları listelesin. Güvenlik duruşu korunur: aranan
kökler zaten reparse-point kontrolünden geçmiş admin-owned köklerdir. (Alternatif — `Expand-Archive`
kullanımını `[System.IO.Compression.ZipFile]`'a çevirip Archive şartını tamamen kaldırmak — daha büyük bir
değişikliktir; ancak birincil yaklaşım bir nedenle uygulanamazsa seç.)

**CI lockstep (R4 — aynı commit'te):**
- `scripts/test-codex-integration-security.ps1:50-53` — testin kendi başlangıcı aynı `$PSHOME` yolunu şart koşuyor.
- `scripts/test-codex-integration-security.ps1:~1312, ~1326-1347` — çocuk süreçlerde `Expand-Archive`'ın
  `$PSHOME` manifest'ine bağlandığını assert ediyor (~1333-1334, ~1345). Assertion'ı "çözümlenen manifest,
  güvenilir köklerden biri altında" olacak şekilde güncelle.
- `scripts/test-os-path-security.ps1:169,173,228` — GUI pre-window başlangıcını 5.1 altında çalıştırır; geçmeye devam etmeli.

**Kabul kriterleri:** (1) Archive yalnızca Program Files altında olan bir makinede 5 betik de başlar;
(2) `$PSHOME` altında olan makinede davranış değişmez; (3) CI yeşil; (4) smoke testlerden birine
"Archive çözümleyici Program Files fallback'ini kullanıyor" senaryosu eklendi.

---

### G2 (P0) — ConstrainedLanguage / Smart App Control tespiti + net hata mesajı

**Neden:** Yeni Windows 11 makinelerde Smart App Control varsayılan açık gelir; WDAC/SAC PowerShell'i
ConstrainedLanguage moduna sokar ve bu zincirdeki betikler ilk `[Tip]::Metot()` çağrısında
("method invocation is supported only on core types") anında ölür. "Sadece hiç kurulum görmemiş yeni
makinede, açılır açılmaz terminalden hata" saha raporuyla birebir uyumludur ve #248'in hiç
açıklanamamış iş istasyonu hatasını da açıklayabilir.

**Yapılacak:** G1'deki tüm giriş betiklerinin **en başına** (param bloğundan hemen sonra, herhangi bir
.NET metot çağrısından ÖNCE — ConstrainedLanguage'da `$ExecutionContext.SessionState.LanguageMode`
okuması ve string karşılaştırması güvenlidir) şu koruma eklenecek:

```powershell
if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    Write-Host "revAgent updater cannot run: PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Host "This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine."
    Write-Host "Ask IT to exempt/sign the revAgent deployment scripts or disable Smart App Control, then retry."
    exit 78
}
```

Mesaj metnini tek bir yerde standartlaştır (her dosyada aynı), exit kodu `78` benzersiz olsun.
`.cmd` launcher'lar bu exit kodunu özel mesajla karşılamak zorunda değil (PowerShell zaten yazdırır),
ama `Refresh-revAgent-LocalBootstrap-STABLE.cmd`'nin "did not complete" genel mesajı bunu maskelememeli —
gerekiyorsa launcher'da `if errorlevel 78` dalı ekle (R3'e dikkat: üç yerde birden).

**Kabul kriterleri:** Guard, her giriş betiğinde ilk çalıştırılabilir bloktur; smoke test regex'i ile
tüm giriş betiklerinde varlığı zorlanır.

---

### G3 (P0) — Pencere-öncesi GUI hatalarını görünür ve loglanır yap

**Neden:** `installer/nas/Start-revAgent-Update.ps1` GUI'yi `CreateNoWindow=$true` + `-WindowStyle Hidden`
ile, **stderr yakalamadan ve exit code kontrol etmeden** başlatır (`New-RevAgentBootstrapGuiStartInfo`
~satır 29-36; `[Diagnostics.Process]::Start($psi) | Out-Null` ~satır 340). GUI'nin ~15-706 arası tüm
başlangıcı (modül bootstrap'ı, Authenticode kontrolü, bootstrap-state parse + her dosyanın SHA-256'sı,
`Import-Module`'lar, HKLM ProfileList okuması) ilk log dosyası ve pencere var olmadan,
`$ErrorActionPreference='Stop'` altında koşar. Sonuç: pencere-öncesi HER hata görünmezdir — launcher
"The updater should open now." dedikten sonra hiçbir şey olmaz. Saha teşhisini imkânsızlaştıran bulgu budur.

**Yapılacak (iki taraf):**
1. **GUI tarafı** (`Install-revAgent-Updater-GUI.ps1`): param bloğu sonrasından form oluşturulana kadarki
   başlangıcı try/catch'e al. Catch'te: (a) `%LOCALAPPDATA%\DPE\revAgent\logs\gui-startup-<yyyyMMdd-HHmmss>.log`
   dosyasına (dizini oluşturarak; korumalı dizinlere DEĞİL — kullanıcı-yazılabilir olmalı) hatanın tam
   metni + stack + `$PSVersionTable` + LanguageMode yazılır; (b) WinForms yüklenebiliyorsa
   `[System.Windows.Forms.MessageBox]::Show(...)` ile log yolunu gösteren kısa mesaj (WinForms yüklenemiyorsa
   sessizce atla); (c) `exit 1`. Smoke-test modlarının (`-ModulePathSecuritySmokeTest`, `-SmokeTest`)
   çıktı sözleşmesini bozma.
2. **Bootstrap tarafı** (`Start-revAgent-Update.ps1`): GUI başlatmasında `RedirectStandardError=$true`
   ile stderr'i `%LOCALAPPDATA%\DPE\revAgent\logs\gui-launch-stderr-<ts>.log`'a akıt; ~10 sn
   `WaitForExit` dene — süre içinde süreç sıfır-dışı kodla öldüyse hatayı kendi çıktısına bas ve sıfır-dışı
   dön (böylece `revAgent Updater STABLE.cmd`'nin `-VerificationOnly` sonrası gizli başlatması yerine,
   hatayı launcher penceresinde göstermenin bir yolu olur). 10 sn içinde süreç hayattaysa başarı say ve bekleme.

**Dikkat:** Bootstrap dosyaları hash-doğrulamalıdır (`bootstrap-state.json` + publisher). GUI/bootstrap
içeriği değiştiğinde bunların hash'lerini üreten mekanizma (publisher + `install-revagent-local-bootstrap.ps1`)
zaten yeni sürümle yeniden hesaplar; elle hash güncelleme gerekmez, ama `scripts/test-local-update-bootstrap.ps1`
ve `scripts/test-os-path-security.ps1`'in başlangıç-akışı assertion'larını güncellemen gerekebilir.

**Kabul kriterleri:** GUI başlangıcına kasıtlı hata enjekte eden bir test (fixture bootstrap +
5.1 çocuk süreç; kalıp `scripts/test-local-update-bootstrap.ps1:185-198`'de mevcut) log dosyasının
oluştuğunu ve exit code'un sıfır-dışı yayıldığını doğrular.

---

### G4 (P0) — Publisher: `release-trusted-keys.json` yayını + readiness kontrolleri

**Neden:** Temiz makine zinciri `%RELEASE_ROOT%\tools\config\release-trusted-keys.json`'ı şart koşar
(`Refresh-revAgent-LocalBootstrap-STABLE.ps1:~228-233`, "Trusted release keys were not found" +
paketlenmiş evidence üreticisi tam olarak `revagent-prod-rsa-2026q3` / `32F8BD0B...` anahtarını pinler).
Ama `scripts/publish-signed-source-free-release-to-nas.ps1` bu dosyaya **hiç** referans vermez
(operatör `-TrustedKeysPath`'ini doğrular @~1403 ama NAS kopyasını ne yazar ne karşılaştırır) ve
`scripts/check-signed-stable-readiness.ps1` da ne bu dosyayı ne launcher/alias/refresh araçlarını kontrol eder.
Yani NAS'taki keys dosyası silinir/bayatlarsa: her temiz kurulum ilk saniyede ölür, tüm kontroller yeşil kalır.

**Yapılacak:**
1. Üretim stable dalında `tools\config\release-trusted-keys.json`'ı, doğrulanmış `-TrustedKeysPath`
   içeriğinden, mevcut exact-handle mekanizmasıyla (`Set-RevAgentStableToolFileExact` benzeri, ~1016-1068)
   yaz/güncelle. Pilot dalın "tools immutable" sözleşmesine dokunma.
2. Publisher'ın yayın-sonu doğrulamasına: NAS kopyasının varlığı + SHA-256 + pinli key id/fingerprint eşleşmesi.
3. `scripts/check-signed-stable-readiness.ps1`'e yeni kontroller: `tools\` altında 4 yönetilen launcher/refresh
   dosyasının varlığı + hash'leri ve `tools\config\release-trusted-keys.json` varlığı + pinli fingerprint.
   (Bu, operatörün "kullanıcının tıkladığı yüzeyi" yayın öncesi/sonrası doğrulayabildiği ilk mekanizma olacak.)

**Kabul kriterleri:** `scripts/test-signed-source-free-cd.ps1`'e keys dosyasının yayınlandığını ve
readiness kontrolünün eksik/bozuk keys'te kırmızı verdiğini gösteren senaryolar eklendi.

---

### G5 (P0) — Bayat NAS giriş noktalarını yönet (SECURITY STOP çıkmazı)

**Neden:** `installer/nas/Install-revAgent-Updater-GUI.cmd:8-16` (ve kardeşleri
`Install-Revit-MCP-Updater-GUI.cmd`, `Install-revAgent-Updater.cmd`, `Install-Revit-MCP-Updater.cmd`)
temiz makinede "SECURITY STOP: protected local revAgent bootstrap is not installed" basıp `exit 1` yapar —
#245/#246/#247 temiz-makine serisi bunlara hiç dokunmadı. İsimleri "installer GUI"ye en çok benzeyen
dosyalar bunlar olduğundan, sahadaki "GUI açılır açılmaz terminalden hata" raporunun en güçlü adayı.
Ayrıca publisher bunları NAS'ta asla yenilemez/silmez (bkz. G-bağlam), yani repo'daki hiçbir düzeltme
NAS kopyalarına ulaşmaz.

**Yapılacak:**
1. **Repo tarafı:** Dört legacy `.cmd`'yi, mantık çoğaltmadan STABLE akışına devreden ince stub'lara çevir:
   bootstrap yoksa "This launcher is deprecated; opening revAgent Updater STABLE..." de ve aynı dizindeki
   `revAgent Updater STABLE.cmd`'yi `call` et (yoksa `%RELEASE_ROOT%\tools\` altındakini); bootstrap varsa
   mevcut davranış (bootstrap'ı başlat) korunabilir. STABLE launcher mantığını KOPYALAMA (drift riski — R3).
2. **Publisher tarafı:** Üretim stable dalına "yönetilen legacy giriş noktaları" adımı ekle:
   bu dört dosya adı NAS `tools\` altında ve (varsa) NAS kökünde exact-handle ile stub içeriğe zorlanır
   **veya** silinir (silme, `tools\`'ta tercih; kökte stub). Kararını `installer/nas/README.md`'ye yaz.
3. R5'e dikkat: `test-signed-source-free-cd.ps1`'in sıfır-`.cmd` assertion'larını yönetilen-liste
   assertion'ına çevir (bkz. G12 ile birlikte ele al).

**Kabul kriterleri:** Publish sonrası fixture NAS'ında hiçbir kullanıcı-tıklanabilir `.cmd` çıkmaz sokak
değildir: her biri ya STABLE akışına devreder ya da mevcut değildir; CD testi bunu doğrular.

---

### G6 (P1) — Yükseltilmiş faz betiği yerelden çalıştırsın

**Neden:** `Refresh-revAgent-LocalBootstrap-STABLE.ps1`'de `Start-ElevatedApply` (~178-202) runas
child'ının `-File` argümanına `$PSCommandPath`'i — yani **NAS UNC yolunu** — verir. UAC'yi farklı bir
admin hesabı onaylarsa (over-the-shoulder; yerel admin, NAS erişimi yok), yükseltilmiş powershell betiği
NAS'tan okuyamaz ve anında `exit 1` ("Elevated bootstrap refresh exited with code 1"). Diğer TÜM girdiler
(installer, evidence, trusted keys) #250'de yerel'e kopyalanmıştı — bir tek betiğin kendisi kalmış.

**Yapılacak:** Yükseltme öncesi betiği (`$PSCommandPath`) admin-safe yerel staging alanına
(evidence/installer için kullanılan mevcut mekanizmanın aynısı) kopyala, SHA-256'sını ebeveynde hesapla,
yükseltilmiş komut satırına **yerel yolu** + beklenen hash'i geçir; yükseltilmiş faz çalışmaya başlarken
kendi dosyasının hash'ini doğrulasın (mevcut `-Expected*Sha256` kalıplarını izle). R2'ye dikkat.
`-CoordinatorRelaunchedFromAdmin` scheduled-task relaunch'ı yükseltmesizdir ve kullanıcının NAS erişimi
vardır — ona dokunma.

**Kabul kriterleri:** Yükseltilmiş `ProcessStartInfo`'nun `-File` argümanı hiçbir kod yolunda UNC değildir;
smoke teste regex kontrolü eklendi.

---

### G7 (P1) — UAC reddine dostu mesaj + `%TEMP%` temizliği

**Neden:** UAC iptali `[Diagnostics.Process]::Start` (~198)'ten çıplak `Win32Exception` (1223) fırlatır —
konsolda ham .NET dökümü. Ayrıca `New-CleanInstallBootstrapInput` (~253-296) tüm release'i
`%TEMP%\revagent-bootstrap-install-source-<guid>`'e açar ve **hiçbir yolda** (ret/hata/başarı) temizlik
yoktur; refresh yolundaki `revagent-bootstrap-refresh-source-*` (~476-479) aynı durumda. Her deneme
`%TEMP%`'te tam bir release kopyası biriktirir.

**Yapılacak:** runas `Process.Start`'ı try/catch'e al; `NativeErrorCode 1223` → "Administrator approval
was declined. Run this updater again when an administrator is available." + `exit` (benzersiz kod).
Çıkarma/evidence/keys geçici dizin ve dosyalarını `finally` ile sil (başarıda da); silinemeyenler için
sessiz devam (best-effort), ama en azından bir önceki çalışmalardan kalan `revagent-bootstrap-*-source-*`
dizinlerini de fırsatçı temizle.

**Kabul kriterleri:** UAC-ret simülasyonlu test (mock/duruma göre statik assertion) dostu mesajı doğrular;
başarılı akış sonrası fixture'da geçici dizin kalmadığı assert edilir.

---

### G8 (P1) — Admin'den başlatılan ilk kurulum: asenkron koordinatörle tamamlanma senkronizasyonu

**Neden:** Yükseltilmiş oturumdan başlatılınca #253'ün `Start-LimitedCoordinatorFromAdministrator`'ı
(~300-360) limited scheduled task kaydedip **hemen başarı döner**; koordinatör (çıkarma → evidence →
UAC → kurulum) başka pencerede asenkron sürer. `.cmd`'lerin #254 tamamlanma kontrolü
(`if not exist "%BOOTSTRAP%"`) o anda zorunlu olarak "returned without creating the protected local
bootstrap" + `exit 1` basar — çalışmakta olan kurulum için sahte başarısızlık; kullanıcı tekrar tıklarsa
ikinci koordinatör çakışır.

**Yapılacak:** `Start-LimitedCoordinatorFromAdministrator` koordinatör tamamlanmasını bekle:
scheduled task durumunu + bir tamamlanma işaretini (bootstrap dosyasının oluşması ve/veya koordinatörün
yazacağı marker dosyası) makul timeout'la (örn. 10 dk) yokla; başarıda 0, timeout'ta "coordinator is
still running — finish the coordinator/UAC window, then run this updater again" mesajlı benzersiz exit
kodu döndür. `.cmd`'lerin tamamlanma dalını bu koda göre ayır (R3: repo launcher'lar + publisher şablonu +
`Refresh-...-STABLE.cmd`). Aynı isim kalıbındaki mevcut bir koordinatör task'ı varken ikincisini kaydetme
(mevcut task-adı taramasını kullan) — "a coordinator is already running" mesajı ver.

**Kabul kriterleri:** Statik: launcher üçlemesi senkron (R3 regex'leri güncel); davranışsal: fixture'da
marker-bazlı bekleme yolu test edilir.

---

### G9 (P2) — UAC kapalı / EnableLUA=0 makinelerde net teşhis

**Neden:** LUA kapalıyken `-RunLevel Limited` task yine tam admin token alır; koordinatör
`-CoordinatorRelaunchedFromAdmin` ile yeniden admin bulur ve her denemede "still running as administrator
after a limited relaunch attempt" fırlatır (~300 civarı) — temiz kurulum bu makinelerde imkânsız ve
her deneme anında hata.

**Yapılacak:** Relaunch'a karar vermeden önce ortamın de-elevate edilebilirliğini tespit et
(`HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\EnableLUA` == 0 veya
`TokenElevationTypeDefault`): edilemiyorsa döngüye girmeden özel mesajla dur: "This machine runs with
UAC disabled; the revAgent first install requires a standard (non-elevated) user context. Re-enable UAC
or contact IT for the manual bootstrap prestage (docs/BOOTSTRAP_PRESTAGE.md)." + benzersiz exit kodu.

---

### G10 (P2) — Paylaşılan-ata ACL kontrolünde inherit-only ACE filtresi

**Neden:** Temiz makinede yükseltilmiş faz `C:\ProgramData\DPE`'yi düz `New-Item` ile oluşturur
(korumalı DACL yalnız `DPE\revAgent` ve altına uygulanır — Refresh ps1 ~390). `DPE`, ProgramData'dan
CREATOR OWNER (OI)(CI)(IO) vb. ACE'leri miras alır. `Assert-RevAgentPrestageSharedAncestorSafe`
(`scripts/install-revagent-local-bootstrap.ps1:400-407`) ve `Assert-RevAgentBootstrapSharedAncestorSafe`
(`installer/lib/RevAgent.LocalBootstrap.psm1:388-395`) inherit-only ACE'leri **filtrelemeden** tehlike
maskesine vurur — aynı dosyanın ~270. satırındaki kardeş kontrol filtreler. Bugün şansa geçiyor
(GENERIC_ALL ham maskesi eşleşmiyor); spesifik-haklı bir inherit-only ACE üreten imajda ilk kurulum
UAC onayından SONRA "bootstrap_parent_not_protected" ile ölür.

**2026-07-19 safety refinement (önceki `DPE` kökünü admin-only yapma şartını geçersiz kılar):**
`C:\ProgramData\DPE` revAgent'a ait özel bir kök değil, DPE ürünlerinin ortak atasıdır. revAgent refresh'i
bu ortak atanın DACL'ını `Set-AdminOnlyAcl` ile yeniden yazmamalıdır; böyle bir mutasyon başka DPE
ürünlerinin erişim sözleşmesini fark edilmeden bozabilir. Güven sınırı bunun yerine üç parçalıdır:

1. Her iki shared-ancestor validator, `PropagationFlags`'te `InheritOnly` olan ACE'leri atlar; fakat ortak
   atanın owner'ını, reparse/link durumunu ve child silme/yeniden adlandırma ya da ACL/owner değiştirme
   yetkisi veren **uygulanmış** güvensiz ACE'leri fail-closed doğrulamaya devam eder.
2. Mevcut exact-path/identity guard'lar işlem boyunca beklenen dizin kimliğini ve link-siz yolu bağlar;
   ortak atanın ACL'sini değiştirmeden path-swap/reparse ikamesini engeller.
3. revAgent'a ait exact `DPE\revAgent` ve `DPE\revAgent\prestage` köklerine `Set-AdminOnlyAcl`
   uygulanır. Böylece koruma ürün sınırında kalır ve ortak `DPE` atası mutate edilmez.

**Güncel kabul kriterleri:** `scripts/test-shared-ancestor-acl.ps1`, iki validator'ın inherit-only ACE'yi
kabul edip uygulanmış tehlikeli ACE'yi reddettiğini doğrular; ayrıca production apply fonksiyonunda
`Set-AdminOnlyAcl -Path $dpeRoot` bulunmadığını, `$productRoot` ve `$prestageRoot` hedeflerinin ikisinin de
korunduğunu statik olarak kilitler.

---

### G11 (P2) — Refresh↔verify sonsuz döngü kesici

**Neden:** Kurulum sonu Refresh ps1 (~445/503) yerel launcher'ı başlatır; `Start-revAgent-Update.cmd`
`-VerificationOnly` başarısızsa `:RefreshStableIfBound` ile tam NAS refresh'i tetikler; o da sonunda yine
launcher'ı başlatır. Doğrulama hatası makineye-kalıcıysa (ör. `fsutil hardlink list` kullanıcıya kapalı —
`Start-revAgent-Update.ps1:~109-113`; yedekleme/dedup ajanı hardlink üretiyor) döngü sınırsızdır: sürekli
pencere + UAC.

**Yapılacak:** Refresh'ten launcher'a tek-seferlik işaret geçir (örn. `-PostRefreshLaunch` bayrağı veya
`%ProgramData%\DPE\revAgent\bootstrap\.post-refresh-marker` benzeri): refresh'in HEMEN ardından gelen
doğrulama hatası ikinci bir refresh tetiklemek yerine "verification still fails after a fresh refresh —
this machine needs manual diagnosis: <sebep metni>" ile dursun. R3 geçerli (launcher üçlemesi + yerel
`Start-revAgent-Update.cmd`'yi üreten kod).

---

### G12 (P1) — Test kapsamı: üretim launcher yayını + temiz makine E2E

**Neden:** İki yapısal kör nokta: (a) `test-signed-source-free-cd.ps1:512` fixture NAS `tools`'unda sıfır
`.cmd` assert ettiği için `Set-RevAgentStableLauncherExact`/`Set-RevAgentStableBootstrapToolsExact`
üretim dalı hiçbir testte ÇALIŞMAZ (yalnız kaynak regex'i, ~965-966) — #255/#256 hataları tam bu sınıftı;
(b) temiz-makine zincirinin (`New-CleanInstallBootstrapInput` → elevated apply → GUI başlangıcı) sıfır
çalıştırma kapsamı var — her şey `Get-Content`+regex.

**Yapılacak:**
1. CD testine, launcher-staging fonksiyonlarını fixture NAS'a karşı gerçekten ÇALIŞTIRAN bir mod ekle;
   üretilen `revAgent Updater STABLE.cmd` baytları repo dosyasıyla davranışsal eşdeğerlikte
   karşılaştırılır (tercihen bayt-karşılaştırma; kozmetik metin farkları bilinçliyse şablonu repo ile
   bayta-bayt eşitle — gelecek denetimlerde sahte-drift görünümünü de yok eder). Sıfır-`.cmd`
   assertion'larını "yalnızca yönetilen listedekiler var" assertion'ına dönüştür (G5 ile koordine).
2. Temiz-makine fixture testi iki sözleşmeyi ayrı doğrular: dormant/future signed-broker helper closure'ında
   sahte release + fixture NAS köküyle `New-CleanInstallBootstrapInput` ve mock yükseltilmiş apply zincirini
   çalıştırıp fixture bootstrap GUI'sinin pencere-öncesi bloğunu gerçek `powershell.exe` 5.1 çocuğunda
   doğrular; production self-service çağrısında ise G13 kararına göre acquisition/UAC/apply başlamadan
   benzersiz exit 84 ile fail-closed durduğunu doğrular. 5.1-çocuk kalıbı
   `test-local-update-bootstrap.ps1:185-198`'de hazır.
3. Bu testleri `.github/workflows/ci.yml`'deki PS 5.1 adımına ekle.

---

### G13 (P2, güvenlik — dikkatli tasarım) — Temiz kurulumda bağımsız imza doğrulaması

**Neden:** #247 sonrası temiz-kurulum zincirinde, yükseltilmemiş kullanıcının ürettiği evidence +
kendi hesapladığı hash'ler yükseltilmiş faza komut satırıyla geçiyor ve `bootstrap-state.json`
`independentlyAuthenticated=true` damgalanıyor (`Refresh-...-STABLE.ps1:~362` zinciri). Yükseltilmiş
tarafta bağımsız bir imza/anchor doğrulaması yok — #221'in "NAS scripts cannot bootstrap their own trust"
ilkesinden sessiz geri adım. (Tehdit modeli: makinedeki standart kullanıcı, admin'in onaylayacağı UAC'ye
kendi ürettiği içeriği sokabilir.)

**Yapılacak:** Yükseltilmiş faz (`Invoke-AuthenticatedBootstrapApply` /
`scripts/install-revagent-local-bootstrap.ps1`), caller-supplied hash zincirine güvenmek yerine release
imzasını bağımsız yeniden doğrulasın: pinli anahtar (key id + fingerprint) yükseltilmiş fazın KENDİ
içinde sabitlenir ve evidence/manifest imzası buna karşı yeniden kontrol edilir (veya evidence üreticisi
kanonik ReleaseRoot'a karşı yükseltilmiş bağlamda yeniden koşturulur — G6 ile birleşik düşün: hangi
dosyaların yerel-staged olduğuna dikkat). Mevcut kontrolleri ZAYIFLATMA; yalnız katman ekle. Bu görevi
en sona bırak; tasarımı uygulamadan önce PR açıklamasında gerekçelendir.

**2026-07-19 karar kaydı:** Mevcut dağıtımda yükseltilmiş fazın bağımsız doğrulayabileceği bir Windows
Authenticode imzası veya IT-yönetimli trust anchor yoktur. NAS'tan gelen betik/evidence/hash zinciri kendi
güven kökünü bootstrap edemez. Bu nedenle production sözleşmesi şimdilik fail-closed'dur:

- Eksik bootstrap kurulumu, stale bootstrap refresh'i ve doğrudan `-ElevatedApply` çağrısı; coordinator,
  UAC veya apply başlamadan benzersiz **exit 84** ile durur. UAC penceresinin çıkmaması beklenen güvenlik
  davranışıdır.
- Yalnız zaten kurulu olan, current release'e bağlı ve `-VerificationOnly` doğrulamasını geçen protected
  local bootstrap normal STABLE → GUI yoluna devam edebilir.
- Otomatik missing/stale bootstrap desteği ancak bağımsız imzalı bir broker veya IT-yönetimli trust anchor
  sağlanıp yükseltilmiş faz bunu kendi güven köküyle doğruladığında yeniden etkinleştirilebilir. Dormant
  helper closure bu gelecek yol içindir; bugün production yetkisi değildir.

Bu karar G12 temiz-makine fixture'ındaki production negatif senaryoyu ve O4'ün iki aşamalı saha
protokolünü belirler; O3 yayını veya O4 saha testi bu kayıtla yapılmış sayılmaz.

---

### G14 (P2) — Dokümantasyon ve CHANGELOG

1. `installer/nas/README.md` (~39-70 "NAS Layout"): gerçek yönetilen sözleşmeyi belgele — 4 launcher-zinciri
   dosyası + `tools\config\release-trusted-keys.json` (+ G5 sonrası yönetilen stub listesi). Şu an README,
   donmuş bayat betikleri "belgelenmiş yerleşim" gibi gösteriyor ve keys dosyasından hiç bahsetmiyor —
   README'ye göre NAS'ı "normalize eden" bir operatör her temiz kurulumu kırar.
2. `docs/BOOTSTRAP_PRESTAGE.md`: #247 self-servis STABLE yolunu ekle/çapraz-referansla (şu an yalnız ağır
   manuel admin prestage akışı anlatılıyor).
3. `CHANGELOG.md`: #233-#256 hiç kaydedilmemiş; fail-closed trust-anchor kararı, doğrulanmış-bootstrap
   launcher yolu, publisher hizalaması ve bu çalışma emrindeki değişiklikler için özet girdiler ekle.

---

## Operatör görevleri (kod değil — Barış manuel yapacak; asistan: bunlara PR'da SADECE referans ver)

### O1 — Teşhis (çöken temiz makinede, ~5 dk)
```bat
powershell.exe -NoProfile -Command "$ExecutionContext.SessionState.LanguageMode; Test-Path (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Archive\Microsoft.PowerShell.Archive.psd1')"
dir "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools"
dir "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\config"
```
`ConstrainedLanguage` çıkarsa kök neden Smart App Control/WDAC'tır (G2 mesajı bunu görünür kılacak).
Çalışan bir ofis makinesinde aynı komutu koşup `Test-Path` sonuçlarını karşılaştır (G1 hipotezi).
Hata ekran görüntüsünü Ek-1 tablosuyla eşle.

### O2 — NAS hijyeni (tek seferlik)
Bayat `Install-*.cmd` / `Install-*-GUI.cmd` girişlerini NAS'tan kaldır veya stub'la (G5 kalıcı çözüm
gelene kadar); `tools\config\release-trusted-keys.json` varlığını ve `revagent-prod-rsa-2026q3` /
`32F8BD0B...` parmak izini doğrula.

### O3 — Yeniden yayın
**Durum: yapılmadı; aşağıdaki adım operatör onayı sonrası uygulanacaktır.**

Repo düzeltmeleri kullanıcıya YALNIZCA yeni imzalı CD build (yeni sürüm + daha yüksek `releaseSequence`)
→ NAS publish ile ulaşır. Aynı sürüm üzerine repair publish yapısal olarak engellidir
(`publish-signed-source-free-release-to-nas.ps1:2098-2104`; `-ExpectedSourceChannelSha256` taze workflow
artifact handoff'u ister). "Sadece republish edeyim" deneme — çalışmaz.

### O4 — Temiz makine test protokolü
**Durum: yapılmadı; O3 ile yeni imzalı sürüm yayımlandıktan sonra operatör iki aşamayı da çalıştıracaktır.**

1. **Pristine negatif kanıt:** Makinede protected local bootstrap yokken standart kullanıcı YALNIZCA
   `revAgent Updater STABLE.cmd`'yi çalıştırır. Beklenen sonuç benzersiz exit 84'tür; UAC/coordinator/GUI
   açılmaz ve `%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1` oluşmaz. Bu aşamada UAC
   beklemek veya mevcut olmayan yerel GUI'yi elle çalıştırmak hata giderme adımı değildir; fail-closed
   trust-anchor kararı doğru çalışmaktadır. Konsol metni, exit code ve `BootstrapExists=False` kaydedilir.
2. **Supervised-prestage sonrası pozitif kanıt:** Bir yönetici/IT operatörü
   `docs/BOOTSTRAP_PRESTAGE.md` içindeki supervised manual high-assurance prestage'i ayrı olarak tamamlar.
   Ardından standart kullanıcı aynı STABLE launcher'ı çalıştırır. Mevcut bootstrap `-VerificationOnly`
   kontrolünü geçmeli ve normal STABLE → GUI yolu açılmalıdır; bu launcher çalıştırmasında refresh veya
   UAC beklenmez. `OpenAI.Codex` önceden kurulmuş ve oturum açılmış, güncelleme sırasında kapalı olmalıdır
   (`update-from-nas.ps1:~2005-2142`). Bootstrap doğrulaması, GUI başlangıcı ve sonuç log'u kaydedilir.

---

## Ek-1 — Hata metni → kök neden eşleme tablosu

| Terminaldeki metin | Kök neden | İlgili görev |
|---|---|---|
| `SECURITY STOP: protected local revAgent bootstrap is not installed` | Bayat `Install-*.cmd` girişi tıklanmış | G5 / O2 |
| `... not allowed in this language mode` / method invocation hataları | Smart App Control / WDAC → ConstrainedLanguage | G2 / O1 |
| `Trusted release keys were not found` | NAS `tools\config\release-trusted-keys.json` yok/bayat | G4 / O2 |
| `Signed channel identity mismatch. requested=...` | NAS refresh aracı #249 öncesi vintage | O3 (republish) |
| `Required built-in PowerShell module manifest was not found: ...Microsoft.PowerShell.Archive...` | `$PSHOME` Archive sabitlemesi (GUI/updater betikleri) | G1 |
| `Required trusted PowerShell module was not found: ...` | Aynı sorun, refresh betiği varyantı | G1 |
| `Exception calling "Start" ... canceled by the user` | UAC reddi (ham exception) | G7 |
| `returned without creating the protected local bootstrap` (admin oturumda, hemen) | #253 asenkron koordinatör + #254 kontrolü | G8 |
| `still running as administrator after a limited relaunch attempt` | EnableLUA=0 / de-elevate edilemiyor | G9 |
| `bootstrap_parent_not_protected: shared prestage ancestor grants ...` | Inherit-only ACE sayan ata kontrolü | G10 |
| "The updater should open now." → pencere yok, hata yok | Gizli GUI başlatması hatayı yutuyor | G3 |

---

## Çalışma düzeni ve tamamlanma tanımı

- Görev sırası: G1 → G2 → G3 → G4 → G5 → G12 → G6 → G7 → G8 → G9 → G10 → G11 → G14 → G13.
  Her görev ayrı, odaklı commit(ler); mesajlar mevcut üslupta ("Fix ...", "Harden ...").
- Her commit'te R1-R7 kontrol listesini uygula; launcher'a dokunan her değişiklikte R3 üçlemesini
  PR açıklamasında tek tek işaretle.
- **Tamamlanma tanımı:** Tüm görevler kapandığında (1) `scripts/test-all.ps1` + CI yeşil; (2) fixture
  publish sonrası NAS'ta tıklanabilir hiçbir çıkmaz-sokak `.cmd` yok; (3) temiz-makine E2E fixture testi
  geçiyor; (4) pencere-öncesi her hata ya konsola ya `%LOCALAPPDATA%` log'una düşüyor; (5) README/CHANGELOG
  gerçek davranışı anlatıyor. Ardından O3 (yeni imzalı yayın) ve O4 (saha testi) operatöre kalır.
