# NAS Deployment for Revit MCP

Bu klasor, Revit MCP paketini tek merkezden ofis bilgisayarlarina dagitmak
icin kullanilir.

## Temel fikir

GitHub kaynak kod ve gecmis icindir. NAS ise ofis bilgisayarlarinin okudugu
yerel dagitim noktasi olur.

`git commit` veya `git push` tek basina dagitim yapmaz. Dagitim sadece
`publish-nas-release.ps1` calistirildiginda olur.

```text
Kod degisikligi
-> commit / push
-> test
-> publish-nas-release.ps1
-> NAS channels\stable.json guncellenir
-> istemci bilgisayarlar update-from-nas.ps1 ile guncellenir
```

## NAS klasor yapisi

Ornek:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\
  channels\
    stable.json
    beta.json
  releases\
    2026.05.08.1500-a1b2c3d4\
      revit-mcp-skill-2026.05.08.1500-a1b2c3d4.zip
      manifest.json
  reports\
    PC-01_USER22.json
  tools\
    Install-Revit-MCP-Updater.cmd
    Install-Revit-MCP-Updater-GUI.cmd
    Install-Revit-MCP-Updater-GUI.ps1
    install-updater-task.ps1
    update-from-nas.ps1
    show-installed-version.ps1
```

## 1. Release yayinlama

Bu komutu gelistirme bilgisayarinda, repo root temizken calistir:

```powershell
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
powershell -ExecutionPolicy Bypass -File ".\kurulum\deploy\publish-nas-release.ps1" `
  -ReleaseRoot $ReleaseRoot `
  -Channel beta
```

`beta` once test bilgisayarlari icindir. Her sey dogruysa ayni paketi yeniden
paketlemeden stable kanalina terfi ettir:

```powershell
powershell -ExecutionPolicy Bypass -File ".\kurulum\deploy\promote-nas-release.ps1" `
  -ReleaseRoot $ReleaseRoot `
  -Version 2026.05.08.1500-a1b2c3d4 `
  -Channel stable
```

Not: `publish-nas-release.ps1` ayni version zaten varsa `-Force` vermeden
ustune yazmaz. Normal akista beta testi gecen paket `promote-nas-release.ps1`
ile stable'a alinir.

## 2. Bir bilgisayara updater kurma

Istemci bilgisayarda bir kez calistirilir. Normal kullanici icin en kolay yol
GUI'dir:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater-GUI.cmd
```

GUI kurulum/update logunu canli gosterir. Hata olursa ekranda log dosyasi
yolunu soyler ve `Log klasoru` dugmesiyle klasoru acabilir.

Komut pencereli klasik yol:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater.cmd
```

Bu dosyaya cift tikla. Updater'i kurar, zamanlanmis gorevi ekler ve ilk update
kontrolunu hemen calistirir. Revit aciksa update ertelenir.

Terminalden calistirmak istersen:

```powershell
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
powershell -ExecutionPolicy Bypass -File "$ReleaseRoot\tools\install-updater-task.ps1" `
  -ChannelManifestPath "$ReleaseRoot\channels\stable.json" `
  -RunNow
```

Script updater'i varsayilan olarak `C:\ProgramData\DPE\RevitMCP\updater`
altina kopyalar ve zamanlanmis gorev kurar. Ana paket, runtime, cache, log ve
durum dosyalari ayni standart kok altinda tutulur:

```text
C:\ProgramData\DPE\RevitMCP\
  package\
  runtime\
  updater\
  state\
  revit-plugin\
  codex\
```

Kurulum ve update loglari:

```text
C:\ProgramData\DPE\RevitMCP\updater\logs\
```

Tipik log dosyalari:

```text
install-YYYYMMDD-HHMMSS.log
update-YYYYMMDD-HHMMSS.log
gui-install-YYYYMMDD-HHMMSS.log
```

## 3. Surum kontrolu

Bilgisayardaki yuklu surumun ana kaydi:

```text
C:\ProgramData\DPE\RevitMCP\updater\installed.json
```

Son update kontrol sonucu:

```text
C:\ProgramData\DPE\RevitMCP\updater\last-update-report.json
```

Kullanici icin en kolay kontrol dosyasi:

```text
C:\ProgramData\DPE\RevitMCP\updater\Show-Revit-MCP-Version.cmd
```

NAS tarafinda her bilgisayarin son raporu da burada gorulur:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports\
```

Raporlarda `previousVersion`, `targetVersion`, `installedVersion` ve
`versionTransition` alanlari bulunur. Boylece update akisi `eski -> yeni`
seklinde izlenebilir.

## 4. Manuel update kontrolu

```powershell
powershell -ExecutionPolicy Bypass -File "C:\ProgramData\DPE\RevitMCP\updater\update-from-nas.ps1" `
  -ConfigPath "C:\ProgramData\DPE\RevitMCP\updater\updater-config.json"
```

Revit aciksa update ertelenir ve rapora `deferred-revit-running` yazilir.
Revit kapaliyken:

- Eski yuklu surum `installed.json` icinden okunur.
- Hedef surum NAS `channels\stable.json` icinden okunur.
- Konsolda ve raporda `eski -> yeni` gecisi gosterilir.
- Paket NAS'tan kopyalanir.
- SHA256 dogrulanir.
- `C:\ProgramData\DPE\RevitMCP\package` managed paket kopyasi yenilenir.
- `install-self-contained.ps1` calisir.
- Runtime ve docs MCP icin `npm install --omit=dev` calisir.
- Codex MCP kayitlari yenilenir.
- Sonuc hem lokal hem NAS `reports` klasorune yazilir.

Bu bir dosya bazli delta update degildir. Update, surumlu zip paketini butun
olarak indirir ve Revit MCP'nin yonettigi hedefleri guvenli sekilde yeniden
kurar. Official Revit veya Windows klasorleri silinmez; temizlik sadece bilinen
Revit MCP add-in, runtime, command set, Codex skill ve eski kurulum hedefleriyle
sinirlidir.

## Guvenlik notlari

- Revit acikken plugin DLL degistirilmez.
- Paket hash'i dogrulanmadan kurulum yapilmaz.
- Updater, varsayilan olarak `C:\ProgramData\DPE\RevitMCP` kokunu yonetir.
- Bu hedef bir git working tree ise, yanlislikla gelistirme reposunu silmemek
  icin update durur. Bilerek izin vermek icin `-AllowReplaceGitPackageTarget`
  kullanilir.
- Kurulum Revit 2022 kokunu otomatik arar: once kullanici/ortam degiskeni,
  sonra standart `C:\Program Files\Autodesk\Revit 2022` ve registry adaylari
  denenir. Bulunamazsa kurulum acik hata ile durur.
- Installer tarafindaki eski dizin temizligi sadece bilinen Revit MCP
  hedefleriyle sinirlidir; Autodesk Revit veya Windows sistem klasorleri
  silinmez.
