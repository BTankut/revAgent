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
    install-updater-task.ps1
    update-from-nas.ps1
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

Istemci bilgisayarda bir kez calistirilir. En kolay yol:

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

Script updater'i `C:\Projects\revit-mcp-install` altina kopyalar ve zamanlanmis
gorev kurar.

## 3. Manuel update kontrolu

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Projects\revit-mcp-install\update-from-nas.ps1" `
  -ConfigPath "C:\Projects\revit-mcp-install\updater-config.json"
```

Revit aciksa update ertelenir ve rapora `deferred-revit-running` yazilir.
Revit kapaliyken:

- Paket NAS'tan kopyalanir.
- SHA256 dogrulanir.
- `C:\Projects\revit-mcp-skill` managed paket kopyasi yenilenir.
- `install-self-contained.ps1` calisir.
- Runtime ve docs MCP icin `npm install --omit=dev` calisir.
- Codex MCP kayitlari yenilenir.
- Sonuc hem lokal hem NAS `reports` klasorune yazilir.

## Guvenlik notlari

- Revit acikken plugin DLL degistirilmez.
- Paket hash'i dogrulanmadan kurulum yapilmaz.
- Updater, varsayilan olarak `C:\Projects\revit-mcp-skill` klasorunu yonetir.
- Bu hedef bir git working tree ise, yanlislikla gelistirme reposunu silmemek
  icin update durur. Bilerek izin vermek icin `-AllowReplaceGitPackageTarget`
  kullanilir.
- Installer tarafindaki eski dizin temizligi sadece bilinen Revit MCP
  hedefleriyle sinirlidir; Autodesk Revit veya Windows sistem klasorleri
  silinmez.
