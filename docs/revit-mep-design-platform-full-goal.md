# Codex `/goal` Talimatnamesi: Revit MCP MEP Design Platform Full Implementation

## Rolün

Sen kıdemli bir yazılım mimarı, Revit API uzmanı, MCP runtime mühendisi ve mekanik tesisat tasarım otomasyonu uzmanı gibi çalışacaksın.

Hedefin demo yapmak değil; ofisin üretimde kullandığı Revit 2022 ortamında doğal dil ile HVAC, boru tesisatı, yangın, sprinkler, hidrolik hesap, clash analizi, routing, sizing, preview/commit/verify ve raporlama yapabilen tam teşekküllü bir Revit MCP MEP tasarım platformu geliştirmek.

Bu işi uzun soluklu Codex `/goal` işi olarak ele al. Gerekirse saatlerce veya günlerce çalış. Subagent'lar kullan. Takıldığında web search yap. Revit API dokümantasyonunu, lokal `revit-api-docs` MCP server'ını ve canlı Revit modelini kullanarak doğrulama yap. Tahmin etme; araştır, test et, doğrula.

## Ana Kural: Demo Değil, Tam Platform

Bu talimatname bir MVP veya demo talimatı değildir.

Amaç tüm hedef mimariyi kurmak, uçtan uca çalışan platform çekirdeğini oluşturmak, domain motorlarını başlatmak ve Revit üretim iş akışına gerçek altyapı sağlamaktır. Çalışmayı küçük parçalara bölmen serbesttir; ancak zihinsel modelin "ilk demo" değil, "tam platformun profesyonel uygulaması" olacak.

Uygulama sırasında gerçekçi bir sıra kullan:

1. Önce güvenli branch ve repo hazırlığı.
2. Sonra mimari dokümantasyon ve sözleşmeler.
3. Sonra runtime MCP write-plan altyapısı.
4. Sonra native Revit executor.
5. Sonra workflow identity/eId state.
6. Sonra MEP graph ve engineering engines.
7. Sonra live Revit testleri, verification ve raporlama.

Her aşama tamamlandığında test et, commit et ve ilerle.

## Kritik İlkeler

- `main` branch'e doğrudan zarar verme.
- Tüm büyük işleri temiz feature branch'lerde yap.
- Kullanıcının mevcut değişikliklerini asla ezme.
- `git reset --hard`, destructive checkout veya dosya silme kullanma.
- Üretim modelinde yazma yapmadan önce mutlaka preview ve açık kullanıcı commit onayı gerektir.
- Revit 2022 bu ofisin aktif üretim hedefidir; multi-version destek şu an öncelik değildir.
- Public MCP tool yüzeyini şişirme.
- Domain karmaşıklığını 50 ayrı public MCP tool olarak değil, typed write-plan ve domain engine altyapısı içinde çöz.
- LLM karar verir, ama Revit'e yazan sistem deterministik, typed, doğrulanabilir ve audit edilebilir olmalı.
- Raw `send_code_to_revit` expert fallback olarak kalsın; üretim yazmaları typed write-plan akışına taşınsın.
- Her mühendislik hesabı varsayım, yöntem, birim, kaynak veri, eksik veri ve risk seviyesini açıkça döndürsün.
- Fire/sprinkler/hydraulic kararlarında belirsizlik varsa kesin hüküm verme; varsayımları açıkça raporla.
- Clash resolution otomatik commit yapmasın; reroute preview ve doğrulama zorunlu olsun.

## Repo ve Branch Stratejisi

Ana skill/runtime repo:

```text
C:\Users\BT\Projects\revit-mcp-skill-review
```

Plugin source repo:

```text
C:\Users\BT\Projects\revit-mcp-plugin
```

Çalışmaya başlamadan önce her iki repo'da şunları çalıştır:

```powershell
git status --short --branch
git branch --show-current
git log --oneline --decorate --max-count=10
git remote -v
```

Skill/runtime repo branch:

```text
feature/full-mep-design-platform-goal
```

Plugin repo branch:

```text
feature/native-write-plan-executor
```

Plugin repo şu anda dirty olabilir. Mevcut değişiklikleri incele ve koru. Dirty state varsa, branch'i mevcut state üzerinden açabilir veya ayrı clean worktree/clone kullanabilirsin. Kullanıcının değişikliklerini ezme.

İlk commit yalnızca bu talimatname ve mimari dokümantasyon olabilir. Sonraki commit'ler mantıksal implementation parçalarına ayrılmalı.

## Mevcut Baseline

Runtime MCP public tools:

- `send_code_to_revit`
- `send_code_to_revit_safe`
- `get_revit_session_context`
- `get_active_view_context`
- `inspect_elements`
- `inspect_parameter_schema`

Docs MCP tools:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

Skill version şu anda `0.4.2`.

Mevcut sistemde:

- `send_code_to_revit_safe` write-looking kodları reddeder.
- `send_code_to_revit_safe` her zaman `transactionMode: "none"` ile çalışır.
- Docs server required companion olarak kabul edilir.
- Revit 2022 canlı üretim hedefidir.
- Revit API lookup için lokal docs server kullanılmalıdır.
- Raw dynamic execution mevcuttur, ancak production write için nihai yol typed write-plan olmalıdır.

Bu mimari korunacak ama büyütülecek.

## Hedef Mimari

Kurulacak uçtan uca akış:

```text
Natural language request
  -> skill workflow and intent interpretation
  -> Revit context read
  -> Revit API docs validation
  -> engineering domain analysis
  -> typed write-plan
  -> preview and risk report
  -> explicit commit approval
  -> native Revit executor
  -> verify
  -> audit/report
```

Platform katmanları:

- Skill Layer: domain davranışı, güvenlik kuralları, Türkçe/İngilizce görev yorumu, workflow disiplini.
- Runtime MCP Layer: LLM'e açılan küçük ve güçlü public tool yüzeyi.
- Docs MCP Layer: Revit API symbol validation ve lokal Revit API reference lookup.
- Native Revit Executor Layer: deterministik Revit write operations.
- Write-Plan Layer: typed JSON planları, validate/preview/commit/verify lifecycle.
- Workflow Identity Layer: `planId`, `stepId`, `eId`, `ElementId`, `UniqueId` mapping.
- Engineering Engines: HVAC, hydronic, domestic water, sanitary/storm, fire/sprinkler, clash, equipment selection.
- Verification Layer: commit sonrası model re-read, delta check, warnings, audit trail.
- Reporting Layer: Excel, CSV, schedule, technical report, issue list, design log.

## Public MCP Tool Hedefi

Runtime tool yüzeyini kontrollü büyüt.

Mevcut tool'lar korunacak:

- `send_code_to_revit`
- `send_code_to_revit_safe`
- `get_revit_session_context`
- `get_active_view_context`
- `inspect_elements`
- `inspect_parameter_schema`

Yeni hedef tool'lar:

- `analyze_mep_system`
- `prepare_write_plan`
- `preview_write_plan`
- `commit_write_plan`
- `verify_write_plan`
- `get_workflow_state`
- `clear_workflow_state`

Domain-specific işleri public MCP tool yapma. Örneğin `create_duct`, `resize_pipe`, `place_sprinkler` public MCP tool olarak açılmayacak; bunlar write-plan operation olarak yaşayacak.

## Typed Write-Plan Protokolü

Tüm model-changing request'ler Revit'e gitmeden önce typed write-plan olarak temsil edilmeli.

Top-level plan shape:

```json
{
  "schemaVersion": "1.0",
  "planId": "uuid",
  "title": "string",
  "discipline": "hvac|hydronic|sanitary|domestic_water|fire|sprinkler|clash|general",
  "riskLevel": "low|medium|high|critical",
  "source": {
    "userRequest": "string",
    "createdBy": "llm|system",
    "revitVersion": "2022"
  },
  "context": {
    "documentTitle": "string",
    "activeViewId": 0,
    "activeViewType": "string"
  },
  "steps": [],
  "verification": {},
  "audit": {}
}
```

Step shape:

```json
{
  "stepId": "step-001",
  "eId": "optional-symbolic-id",
  "operation": "operation_name",
  "dependsOn": [],
  "targets": {},
  "arguments": {},
  "preconditions": [],
  "riskLevel": "low|medium|high|critical"
}
```

Her plan şu mode'ları desteklemeli:

- `validate`: schema ve precondition doğrular, yazmaz.
- `preview`: hedefleri, eski/yeni değerleri, riskleri gösterir, yazmaz.
- `commit`: sadece açık commit onayıyla yazar.
- `verify`: Revit'i tekrar okur ve sonucu doğrular.

## Workflow Identity ve eId

Çok adımlı tasarım için sembolik kimlik altyapısı kur.

Kullanılacak kimlikler:

- `planId`: tasarım/değişiklik işlemi
- `stepId`: plan içindeki adım
- `eId`: workflow içinde kullanılan sembolik eleman kimliği
- `elementId`: Revit runtime integer id
- `uniqueId`: Revit persistent id
- `createdByPlan`: boolean

Mapping shape:

```json
{
  "planId": "uuid",
  "mappings": [
    {
      "eId": "supply-main-l05-001",
      "stepId": "step-001",
      "elementId": 1845021,
      "uniqueId": "...",
      "category": "OST_DuctCurves",
      "createdByPlan": true
    }
  ]
}
```

İlk sürümde workflow state memory + JSON file-backed olabilir. Sonraki aşamada ExtensibleStorage değerlendirilebilir.

Primary identity olarak `Mark` kullanma. `Mark` sadece optional visible trace olabilir.

## Native Plugin Executor

Plugin source repo'da native executor ekle.

Yeni Revit command:

```text
execute_write_plan
```

Params:

```json
{
  "mode": "validate|preview|commit|verify",
  "plan": {},
  "commitToken": "optional"
}
```

Return:

```json
{
  "success": true,
  "mode": "preview",
  "planId": "...",
  "riskLevel": "medium",
  "warnings": [],
  "errors": [],
  "previewRows": [],
  "mappings": [],
  "audit": {}
}
```

Executor Revit `ExternalEvent` ve transaction içinde çalışmalı.

Kurallar:

- `validate` ve `preview` model mutate etmemeli.
- `commit` transaction içinde çalışmalı.
- Commit hata verirse transaction rollback olmalı.
- Commit sonrası mapping ve audit dönmeli.
- `verify` modelden tekrar okuyarak sonucu doğrulamalı.

Başlangıç native operations:

- `set_parameter`
- `clear_parameter`
- `copy_parameter_value`
- `change_type`
- `view_hide_elements`
- `view_unhide_elements`
- `view_apply_overrides`
- `place_family_instance`
- `move_elements`
- `create_duct_run`
- `resize_duct`
- `create_pipe_run`
- `resize_pipe`

## Write Operation Catalog

Uzun vadeli operation katalogu aşağıdaki kapsamı desteklemeli.

### General

- `set_parameter`
- `clear_parameter`
- `copy_parameter_value`
- `change_type`
- `pin_elements`
- `unpin_elements`
- `view_hide_elements`
- `view_unhide_elements`
- `view_apply_overrides`
- `tag_elements`
- `create_schedule_or_update_schedule`
- `export_boq_report`

### Geometry and Placement

- `place_family_instance`
- `move_elements`
- `rotate_elements`
- `align_elements`
- `delete_elements`
- `copy_elements`
- `create_opening_or_sleeve`
- `place_support_or_hanger`

### HVAC Airside

- `create_duct_run`
- `resize_duct`
- `create_duct_branch`
- `place_air_terminal`
- `place_damper`
- `place_vav_or_air_device`
- `connect_air_terminal_to_duct`
- `connect_ducts`
- `replace_duct_fitting`
- `apply_duct_insulation`
- `assign_air_system`
- `balance_airflows`
- `size_ducts_equal_friction`
- `calculate_duct_critical_path`
- `select_fan_by_flow_pressure`

### Hydronic Pipe

- `create_pipe_run`
- `resize_pipe`
- `create_pipe_branch`
- `place_valve`
- `place_pump`
- `place_coil_connection`
- `connect_pipes`
- `apply_pipe_insulation`
- `assign_hydronic_system`
- `calculate_pipe_pressure_loss`
- `size_pipes_by_velocity_or_friction`
- `calculate_pump_head`
- `select_pump_by_flow_head`

### Domestic Water

- `create_domestic_water_run`
- `place_fixture_connection`
- `size_domestic_water_pipe`
- `calculate_fixture_units`
- `calculate_domestic_water_pressure_loss`
- `verify_hot_water_recirculation`

### Sanitary and Storm

- `create_sanitary_pipe_run`
- `create_vent_pipe_run`
- `create_storm_pipe_run`
- `apply_pipe_slope`
- `size_sanitary_pipe`
- `size_storm_pipe`
- `verify_gravity_flow`
- `verify_venting`
- `route_to_stack`

### Fire Protection

- `place_sprinklers`
- `create_sprinkler_branch`
- `create_sprinkler_main`
- `size_sprinkler_pipe`
- `verify_sprinkler_coverage`
- `place_fire_cabinet`
- `route_fire_cabinet_pipe`
- `calculate_fire_flow_pressure`
- `select_fire_pump_basis`

### Clash and Coordination

- `detect_clashes`
- `classify_clash`
- `propose_reroute`
- `preview_reroute`
- `commit_reroute`
- `create_coordination_issue`
- `mark_clash_resolved`
- `export_clash_report`

## Engineering Domain Engines

Tüm domain motorları önce read/analyze/propose yapmalı, sonra write-plan üretmeli.

### HVAC Airside Engine

Kur:

- Duct, duct fitting, duct accessory, air terminal, mechanical equipment collectors.
- Connector graph.
- Open connector detection.
- Flow aggregation.
- Equal friction duct sizing.
- Segment friction loss.
- Critical path.
- Fan flow/pressure basis.
- Duct resizing write-plan.
- Air terminal placement write-plan.
- Damper placement write-plan.
- Duct routing/write-plan.

### Hydronic Pipe Engine

Kur:

- Pipe, fitting, accessory, equipment graph.
- Supply/return network detection.
- Flow aggregation.
- Velocity/friction sizing.
- Critical circuit.
- Pump head basis.
- Pipe resizing write-plan.
- Valve, pump, coil connection placement write-plan.

### Domestic Water Engine

Kur:

- Cold/hot/recirculation network classification.
- Fixture demand basis.
- Pipe sizing.
- Pressure loss.
- Recirculation continuity checks.
- Write-plan proposals.

### Sanitary and Storm Engine

Kur:

- Gravity pipe network.
- Slope validation.
- Reverse slope detection.
- Stack/branch relationship.
- Vent continuity.
- Pipe sizing proposal.
- Unsafe edits as issues, not automatic commits.

### Fire Protection / Sprinkler / Fire Cabinet Engine

Kur:

- Sprinkler collector and coverage analysis.
- Spacing/coverage checks against office rules.
- Branch/main graph.
- Pipe sizing basis.
- Fire cabinet placement and pipe routing.
- Fire pump flow/pressure basis.
- Explicit assumptions and user approval for fire decisions.

### Clash and Coordination Engine

Kur:

- Clash detection/import.
- Hard clash, clearance clash, insulation clash, maintenance clearance classification.
- Reroute proposal.
- Preview reroute geometry.
- Commit selected resolution only.
- Verify clash removed and no new clash introduced.
- Export coordination issue report.

### Equipment Selection Engine

Kur:

- Fan selection from airflow + critical path pressure.
- Pump selection from flow + head.
- Candidate type/family comparison.
- Equipment schedule/report update proposal.
- No silent equipment replacement.

## Office Standards Config

Office standards config-driven olmalı, hardcoded olmamalı.

Config alanları:

- duct equal friction target
- duct velocity limits
- pipe velocity limits
- pipe friction limits
- sanitary slope rules
- domestic water sizing assumptions
- sprinkler spacing/coverage assumptions
- fire cabinet pressure/flow assumptions
- report format preferences
- naming conventions
- allowed parameter names
- exact schema mappings

Standart eksikse engine şu alanları döndürmeli:

```json
{
  "requiresOfficeStandard": true,
  "missingStandards": [],
  "assumptions": [],
  "canCommit": false
}
```

Eksik standardı olan mühendislik sonucu final design olarak sunulmasın; proposal veya issue olarak dönsün.

## Runtime MCP Implementation Structure

Runtime server içinde şu yapıyı kur:

```text
kurulum/mcp-server/build/
  tools/
    analyze_mep_system.js
    prepare_write_plan.js
    preview_write_plan.js
    commit_write_plan.js
    verify_write_plan.js
    get_workflow_state.js
    clear_workflow_state.js
  write-plan/
    schemas.js
    validators.js
    risk.js
    workflowStore.js
    previewFormatter.js
    nativeExecutorClient.js
  domains/
    hvac/
    hydronic/
    domestic-water/
    sanitary-storm/
    fire/
    clash/
    equipment/
  office-standards/
    defaults.js
```

Tool registration güncellenecek ama public yüzey kontrollü kalacak.

## Plugin Implementation Structure

Plugin repo içinde şu yapıyı kur:

```text
SampleCommandSet/
  Commands/
    WritePlan/
      ExecuteWritePlanCommand.cs
      ExecuteWritePlanEventHandler.cs
      Models/
      Operations/
      Validators/
      Preview/
      Verification/
```

`command.json` içine `execute_write_plan` eklenecek.

Revit 2022 build/test hedefi önceliklidir.

## Skill Updates

`SKILL.md` güncellenecek:

- version artır.
- Default write workflow artık write-plan olacak.
- Raw `send_code_to_revit` expert fallback olarak tanımlanacak.
- Her design/sizing sonucu proposal olarak dönecek.
- Fire/sprinkler/hydraulic kararlarında açık varsayım zorunlu.
- Clash resolution auto-commit yasak.
- `inspect_parameter_schema` with `parameterNameMatchMode: "exact"` write-preflight için zorunlu kalacak.
- Revit docs server non-trivial API için zorunlu kalacak.

## Safety Model

Risk seviyeleri:

- `low`: text parameter write, report, view override
- `medium`: type change, duct/pipe resize, tag/place family
- `high`: new duct/pipe routing, equipment placement, reroute
- `critical`: delete, batch reroute, fire/sprinkler sizing commit, pump/fan replacement

Kurallar:

- Preview olmadan commit yok.
- High/critical işlemlerde açık kullanıcı onayı şart.
- Critical işlemler verification ve rollback guidance döndürmeli.
- Production modelde ilk defa denenen operation önce disposable/test modelde denenmeli.
- `send_code_to_revit_safe` asla yazma yapmamalı.
- `commit_write_plan` commit token veya açık onay olmadan çalışmamalı.

## Testing Requirements

Her aşamada test yaz ve çalıştır.

### Static

- Node syntax check
- MCP handshake test
- Tool list test
- safe guard tests
- write-plan schema tests
- workflow state tests
- risk classifier tests

### Plugin

- Revit 2022 build test
- native executor validate/preview tests
- transaction rollback test
- error payload test

### Live Revit Read-Only

- `get_revit_session_context`
- `get_active_view_context`
- `inspect_elements`
- `inspect_parameter_schema`
- `analyze_mep_system`

### Live Revit Write

Canlı write testleri sadece test modelde yapılacak.

Test senaryoları:

- one parameter set
- one type change
- one view override
- one simple duct run
- one duct resize
- one verification failure case
- rollback behavior

### Engineering Validation

- duct sizing against known hand calculation
- pipe pressure loss against known hand calculation
- critical path against manually checked path
- sprinkler coverage sample
- clash reroute controlled geometry

## Web Search ve Revit API Kontrolü

Takıldığında web search yapabilirsin.

Öncelik sırası:

1. Local `revit-api-docs` MCP server.
2. Local Revit API DLL/XML docs.
3. Autodesk/Revit API resmi dokümantasyonu.
4. Güvenilir Revit API blogları/forumları sadece yardımcı kaynak olarak.

Her non-trivial API kullanımı için Revit 2022 API'de doğrulama yap. API yüzeyi belirsizse kod yazmadan önce docs lookup yap.

## Subagent Stratejisi

Subagent kullan. Rolleri böl:

- Runtime MCP engineer: Node MCP tools, schemas, workflow state.
- Revit plugin engineer: native executor, ExternalEvent, transaction, command.json.
- MEP HVAC engineer: duct graph, equal friction, pressure loss, fan basis.
- MEP hydronic engineer: pipe graph, pump head, pressure loss.
- Fire/sprinkler engineer: fire domain assumptions and safety.
- Clash/coordination engineer: clash/reroute workflows.
- QA engineer: tests, live Revit test matrix, regression checks.
- Documentation engineer: skill, README, architecture docs.

Subagent'lar aynı dosyalarda çakışmasın. Her subagent finalinde değiştirdiği dosyaları ve test sonuçlarını raporlasın.

## Deliverables

Bu `/goal` sonunda beklenenler:

- Master architecture docs
- Runtime MCP write-plan tools
- Native plugin write-plan executor
- eId workflow state
- Safety model
- Office standards config
- Initial engineering domain engines
- HVAC duct engine working path
- Hydronic pipe engine foundation
- Domestic water foundation
- Sanitary/storm foundation
- Fire/sprinkler foundation
- Clash workflow foundation
- Equipment selection foundation
- Skill and README updates
- Tests and live validation notes
- Branch pushed but `main` untouched
- Clear PR summary

## Acceptance Criteria

Başarılı sayılması için:

- `main` korunmuş olmalı.
- Runtime MCP server initialize olmalı.
- Docs MCP server initialize olmalı.
- Revit live connection çalışmalı.
- Existing six tools regress olmamalı.
- New write-plan tools listelenmeli.
- `prepare_write_plan` invalid planı reddetmeli.
- `preview_write_plan` model mutate etmemeli.
- `commit_write_plan` açık onay/commit token olmadan reddetmeli.
- Native executor en az temel operasyonlarda çalışmalı.
- Workflow eId mapping dönmeli.
- HVAC duct analysis gerçek modelde read-only çalışmalı.
- En az bir test modelde parameter write preview/commit/verify uçtan uca çalışmalı.
- Tüm yapılanlar dokümante edilmeli.

## Çalışma Disiplini

- Küçük, mantıksal commit'ler yap.
- Her büyük değişiklikten sonra test çalıştır.
- Üretim modelinde yazma yapma; canlı write test için açıkça test model kullan.
- Kullanıcı değişikliklerini ezme.
- Gereksiz public MCP tool sayısı ekleme.
- Belirsiz mühendislik standardında kesin hüküm verme.
- Kodda geçici hack bırakma; eğer bırakırsan TODO ve risk olarak raporla.
- Final raporda neyin tamamlandığını, neyin eksik kaldığını, hangi testlerin geçtiğini, hangi risklerin kaldığını açıkça yaz.

## İlk Çalışma Sırası

1. Skill/runtime repo'da branch durumunu kontrol et.
2. Plugin repo'da dirty state'i oku ve koru.
3. Skill/runtime repo'da runtime tool altyapısını eklemeye başla.
4. Plugin repo'da native `execute_write_plan` command altyapısını ekle.
5. MCP runtime üzerinden native command client wrapper oluştur.
6. `prepare/preview/commit/verify` uçtan uca akışını kur.
7. eId workflow store'u ekle.
8. HVAC duct graph ve analysis engine'i başlat.
9. Hydronic, domestic, sanitary/storm, fire, clash ve equipment foundation'ları ekle.
10. Skill ve README'yi yeni platform davranışına göre güncelle.
11. Revit live read-only testleri çalıştır.
12. Test modelde write-plan commit/verify testlerini çalıştır.
13. Branch'leri pushla ve final PR/handoff raporu hazırla.
