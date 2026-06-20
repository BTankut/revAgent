# revAgent — Önerilen Mimari (Workflow Görselleri)

Aşağıdaki diyagramlar, IP'yi (taç-mücevher mantığı) sunucuya taşıyıp client'ı
"ince relay"e indiren önerilen mimariyi adım adım gösterir.

---

## 1) Genel Topoloji — ŞİMDİ vs ÖNERİLEN

```mermaid
flowchart TB
    subgraph NOW["ŞİMDİ — her şey client'ta (IP sızıyor)"]
        direction TB
        H1["MCP Host<br/>(Codex / Claude)"]
        N1["Node MCP Sunucusu<br/>RECONCILE MOTORU + MEP ÇIKARIMI<br/>(taç mücevher BURADA, okunabilir JS)"]
        C1["C# Revit Add-in<br/>(in-process köprü)"]
        H1 -- "stdio MCP" --> N1
        N1 -- "yerel socket" --> C1
    end

    subgraph NEW["ÖNERİLEN — IP sunucuda, client ince"]
        direction TB
        H2["MCP Host<br/>(Codex / Claude)"]
        N2["İNCE Node MCP Proxy<br/>(sadece relay + auth,<br/>IP YOK)"]
        C2["C# Revit Add-in<br/>(in-process köprü, obfuscate)"]
        B2["BACKEND API<br/>(senin kontrolünde)<br/>Reconcile motoru + MEP çıkarımı<br/>+ Auth/Lisans + Telemetri"]
        H2 -- "stdio MCP" --> N2
        N2 -- "yerel socket<br/>(değişmez framing)" --> C2
        N2 -- "HTTPS + cert pinning<br/>+ HMAC imza (opak)" --> B2
    end

    NOW -.->|"yeniden mimari"| NEW
```

---

## 2) Saf-IP Akışı — `reconcile` (skorlama sunucuda)

Burada Revit API'sine dokunulmaz; veri toplanır, sunucuya gider, sonuç döner.

```mermaid
sequenceDiagram
    participant H as MCP Host (Codex)
    participant N as İnce Node Proxy (client)
    participant R as C# Revit Add-in
    participant B as Backend API (sen)

    H->>N: reconcile aracını çağır (generic ad)
    N->>R: inspect_schedules (yerel socket)
    R-->>N: schedule JSON
    N->>N: yerel .xlsx/.csv byte'larını oku
    N->>B: POST /v1/invoke {op, excelBytes, scheduleJSON}<br/>(TLS + imza, opak envelope)
    B->>B: ingestion → adapter → matching<br/>(Dice, skor, eşik kovaları) — IP BURADA
    B-->>N: şekillendirilmiş sonuç (review kovaları)
    N-->>H: sonucu aynen ilet
    Note over N: Client skorlama mantığını ASLA görmez
```

---

## 3) Revit'e Dokunan Akış — `find_elements` ("bridge plan" modeli)

Karar (hangi kategori/eşik) sunucuda; client sadece komutu çalıştıran el.

```mermaid
sequenceDiagram
    participant H as MCP Host (Codex)
    participant N as İnce Node Proxy (client)
    participant B as Backend API (sen)
    participant R as C# Revit Add-in

    H->>N: find_elements (generic ad, ham args)
    N->>B: POST /v1/invoke {op, args} (opak)
    B->>B: searchPolicy çalıştır<br/>(MEP taksonomisi + risk) — IP BURADA
    B-->>N: BRIDGE PLAN<br/>{bridgeCommands:[...], shaping}
    loop her bridge komutu
        N->>R: komutu yerel socket'te çalıştır
        R-->>N: ham Revit sonucu
    end
    N->>B: POST /v1/shape {ham sonuç}
    B-->>N: kompakt/şekillendirilmiş sonuç
    N-->>H: sonucu ilet
    Note over N,R: Client "nasıl"ı bilir, "neden"i bilmez
```

---

## 4) Auth / Lisans / Kill-Switch Kapısı

Her çağrı backend'de doğrulanır; iptal/expired/offline-grace burada yönetilir.

```mermaid
flowchart TD
    A["İstek gelir<br/>(apiKey + imzalı lisans)"] --> B{"İmza & expiry<br/>geçerli mi?"}
    B -- "Hayır" --> X["403 — nötr hata"]
    B -- "Evet" --> C{"Cihaz/seat<br/>bağlama OK?"}
    C -- "Hayır" --> X
    C -- "Evet" --> D{"Kill-switch<br/>enabled?"}
    D -- "Hayır (iptal)" --> X
    D -- "Evet" --> E{"Rate limit<br/>içinde mi?"}
    E -- "Hayır" --> Y["429 Retry-After"]
    E -- "Evet" --> F["op'u çalıştır<br/>(reconcile / searchPolicy / ...)"]
    F --> G["şekillendir + telemetri"]
    G --> H["sonucu dön"]

    subgraph OFFLINE["Offline durumu"]
        O1["Son imzalı doğrulamayı<br/>cache'le (good-through)"]
        O2{"grace penceresi<br/>(örn 72h) içinde mi?"}
        O2 -- "Evet" --> O3["sınırlı offline çalışmaya izin"]
        O2 -- "Hayır" --> O4["fail-closed"]
    end
```

---

## 5) Göç Fazları (Yol Haritası)

```mermaid
flowchart LR
    P1["FAZ 1 — Hızlı Kazanım<br/>(~1-2 hafta)<br/>• sızıntı temizliği (GitHub/IP/NAS/marka)<br/>• src göndermeyi durdur<br/>• Node→tek binary (SEA/Bun)<br/>• C# DLL→ConfuserEx<br/>• araç adlarını nötrle"]
    P2["FAZ 2 — Backend Çıkarımı<br/>(~4-8 hafta)<br/>• backend + auth/lisans/rate-limit<br/>• reconcile_* + searchPolicy taşı<br/>• mevcut testleri backend süiti yap<br/>• client→/v1/invoke çağrıları"]
    P3["FAZ 3 — Tam İnce İstemci<br/>(~3-5 hafta)<br/>• şekillendirme+telemetri sunucuya<br/>• better-sqlite3 düş<br/>• tüm araçlar bridge-plan<br/>• opak/şifreli protokol + pinning"]
    P1 --> P2 --> P3
    P3 --> DONE["IP hiçbir gönderilen<br/>artefaktta yok ✔"]
```

---

## 6) IP Bölümleme — Tek Bakışta

```mermaid
flowchart LR
    subgraph SRV["SUNUCUYA TAŞINIR (yüksek IP, Revit'ten bağımsız)"]
        S1["reconcile_matching.ts<br/>(skorlama/kovalar)"]
        S2["reconcile_normalization.ts"]
        S3["reconcile_excel_ingestion.ts"]
        S4["reconcile_schedule_adapter.ts"]
        S5["searchPolicy.ts<br/>(MEP taksonomisi/risk)"]
        S6["sonuç şekillendirme<br/>broadScanResult / responseMode"]
        S7["telemetri toplama"]
    end
    subgraph CLI["CLIENT'TA KALIR (plumbing, obfuscate)"]
        K1["C# Revit add-in<br/>(in-process zorunlu)"]
        K2["Roslyn send_code_to_revit"]
        K3["element/view/schedule C# komutları"]
        K4["İnce Node proxy<br/>(SocketClient + sendRevitCommand)"]
    end
    CLI -. "HTTPS opak çağrı" .-> SRV
```
