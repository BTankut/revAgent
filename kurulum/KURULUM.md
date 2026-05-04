# Revit MCP - Self-Contained Codex Kurulumu

Bu repo, kurulum icin gereken ana payload'lari repo icinde tasir.
Harici release ZIP indirme veya `npx -y mcp-server-for-revit` akisina ihtiyac yoktur.

## Kapsam

Bu paket sunlari bundled olarak saglar:

1. Revit 2022 icin add-in payload
2. Yerel calisacak prebuilt runtime Node.js MCP server build'i (`revit-mcp`)
3. Revit API DLL + XML dokumantasyonunu indeksleyen required companion MCP server (`revit-api-docs`)
4. Dynamic command execution icin `RevitMCPCommandSet.dll` payload'u

## Hizli yol

Komutlari repo root'tan calistir. Kuruluma baslamadan once Revit'i kapat.

```powershell
$RepoRoot = (Resolve-Path .).Path

powershell -ExecutionPolicy Bypass -File "$RepoRoot\kurulum\install-self-contained.ps1" -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp

cd C:\Projects\revit-mcp
npm install --omit=dev
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"

cd "$RepoRoot\kurulum\revit-api-docs-mcp"
npm install --omit=dev
npm run build-index
codex mcp add revit-api-docs -- node "$RepoRoot\kurulum\revit-api-docs-mcp\build\index.js"
```

Iki MCP server da zorunludur:

- `revit-mcp`: Revit ile canli execution/inspection yapar.
- `revit-api-docs`: lokal Revit DLL + XML dokumantasyonundan class/member imzalarini dogrular.

Skill, iki server'in da bagli oldugunu varsayar.

## Manuel kurulum

Kuruluma baslamadan once Revit kapali olmali.

### 1. Revit plugin payload'unu kopyala

Asagidaki bundled icerigi `%APPDATA%\Autodesk\Revit\Addins\2022\` altina kopyala:

```text
kurulum\revit-plugin\mcp-servers-for-revit.addin
kurulum\revit-plugin\revit_mcp_plugin\...
```

Eger ayni klasorde eski `revit-mcp.addin` varsa, cakismayi onlemek icin adini degistir:

```text
revit-mcp.addin -> revit-mcp.addin.disabled
```

### 2. Gerekirse command set'i elle onar

Repo icindeki `kurulum\Custom_DLL\` klasoru command set yedegidir.
Normal kurulumda buna gerek yoktur. Ama command registry veya command DLL bozulursa su dosyalari referans al:

```text
kurulum\Custom_DLL\RevitMCPCommandSet.dll
kurulum\Custom_DLL\command.json
```

Bu dosyalar, bundled plugin icindeki `RevitMCPCommandSet` payload'unun aynisidir.

### Roslyn bagimliligi nasil calisir?

`send_code_to_revit`, bundled `RevitMCPCommandSet.dll` icinden dinamik C# derler.

Bu repo ile kurulum yapan son kullanicinin ayri bir NuGet paketi kurmasi gerekmez.

Gerekli runtime assembly'leri sunlardir:

- `Microsoft.CodeAnalysis.dll`
- `Microsoft.CodeAnalysis.CSharp.dll`
- `System.Collections.Immutable.dll`
- `System.Memory.dll`
- `System.Reflection.Metadata.dll`
- `System.Runtime.CompilerServices.Unsafe.dll`
- `System.Threading.Tasks.Extensions.dll`
- `System.Text.Encoding.CodePages.dll`
- `System.Buffers.dll`
- `System.Numerics.Vectors.dll`

Bu dosyalar repo icinde exact runtime payload olarak tutulur:

```text
kurulum\Custom_DLL\runtime\2022\...
```

`install-self-contained.ps1` bu dosyalari `RevitMCPCommandSet.dll` yanina mirror eder ve assembly version'larini exact kontrol eder. Ornek olarak yeni command DLL `Microsoft.CodeAnalysis, Version=4.8.0.0` istiyorsa installer `2.8.0.0` gibi eski Autodesk/Revit kopyalarini kabul etmez.

Eger installer exact runtime payload'u bulamazsa veya surumler uyusmazsa kurulum basarili sayilmaz. Bu durumda repo paketini duzelt:

1. `RevitMCPCommandSet.dll` hangi Roslyn surumlerine referans veriyor kontrol et
2. uyumlu DLL'leri `kurulum\Custom_DLL\runtime\2022` altina vendor et
3. `install-self-contained.ps1` icindeki surum manifestini ayni surumlerle guncelle
4. installer'i tekrar calistir

NuGet ancak `RevitMCPCommandSet.dll` kaynaktan yeniden derleniyorsa build-time bagimliliktir; son kullanici kurulumunda runtime payload repo icinden gelmelidir.

### 3. Yerel runtime MCP server'i kopyala

```powershell
xcopy /E /I /Y kurulum\mcp-server C:\Projects\revit-mcp
cd C:\Projects\revit-mcp
npm install --omit=dev
```

### 4. Codex CLI'a runtime MCP server ekle

```powershell
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

### 5. Required companion docs MCP server'i kur ve Codex CLI'a ekle

Repo root'tan:

```powershell
$RepoRoot = (Resolve-Path .).Path
cd "$RepoRoot\kurulum\revit-api-docs-mcp"
npm install --omit=dev
npm run build-index
codex mcp add revit-api-docs -- node "$RepoRoot\kurulum\revit-api-docs-mcp\build\index.js"
```

`revit-api-docs` opsiyonel degildir. Skill non-trivial Revit API yuzeylerinde class/member imzalarini bu server uzerinden dogrular. Server bagli degilse bu bir setup problemidir.

Dogrulama:

```powershell
codex mcp list
```

Listede iki satiri da gormelisin:

- `revit-mcp`
- `revit-api-docs`

### 6. Skill'i Codex'e yukle

```powershell
xcopy /E /I /Y . "%USERPROFILE%\.codex\skills\revit-mcp"
```

Ardindan Codex icinde:

```text
/skills reload
```

### 7. Revit'te komutlari ac

1. Revit'i ac
2. `mcp-servers-for-revit` sekmesine git
3. `Settings` dugmesine tikla
4. Revit plugin payload tarafinda low-level komutlari enable et:
   - `get_selected_elements`
   - `get_current_view_info`
   - `get_current_view_elements`
   - `send_code_to_revit`
   Public MCP yuzeyi Node server tarafinda context tool'lariyla acilir;
   bunlar Revit Settings ekraninda gorunmez.
5. `Save` de

## Beklenen MCP tool yuzeyi

Runtime server (`revit-mcp`):

- `send_code_to_revit`
- `send_code_to_revit_safe`
- `get_revit_session_context`
- `get_active_view_context`
- `inspect_elements`
- `inspect_parameter_schema`

Docs server (`revit-api-docs`):

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

## Test sirasi

1. `codex mcp list` ile iki server'in da kayitli oldugunu dogrula
2. aktif gorunum bilgisi testi
3. secili eleman testi
4. aktif gorunum elemanlari testi
5. `send_code_to_revit` ile kucuk okuma snippet'i
6. non-trivial API gerektiren bir is icin once `revit-api-docs` lookup testi
7. gercek model sorgusu veya rapor testi

## Bu pakette ne guncellendi?

- repo tekrar self-contained dagitim modeline dondu
- plugin payload'u calisan upstream kurulumdan vendor edildi
- local MCP wrapper `transactionMode` parametresini gecirir hale getirildi;
  test edilen plugin build'inde yazma islemleri yine wrapper tarafindan
  yonetilir, snippet icinde manuel `Transaction.Start()` acilmaz
- `SKILL.md` upstream `document / parameters` sozlesmesiyle senkron tutuldu
- runtime public yuzeyi raw `send_code_to_revit` + read-only context
  primitive'leri + safe wrapper olarak ayarlandi
- `revit-api-docs` required companion MCP server olarak cercevelendi
- Roslyn runtime dosyalari installer tarafinda acik sekilde dogrulanip kopyalaniyor

## Sinir

Bu bundled plugin payload su an Revit 2022 icindir.
2023+ surumler icin ayni modelle ayri payload vendor etmek gerekir.
