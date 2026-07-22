# Kullanıcı Duyurusu Taslağı — revAgent Geçişi

**Durum:** Taslak; henüz gönderilmemelidir

**Hedef kitle:** revAgent kullanan tüm ofis çalışanları

**Gönderim sahibi/tarihi:** `TBD`

**Geçiş tarihi:** `TBD — DP-12`

**Phase-1 istemcisi:** Mevcut yetkilendirilmiş ChatGPT/Codex Desktop

> Editör notu: Ara dönemde STABLE güncelleyicinin elle çalıştırılmaması için hemen onaylanıp
> gönderilebilecek kısa metin ayrı `GAP13_2_UPDATER_ABSTINENCE_NOTICE.md` dosyasındadır. Bu geçiş
> duyurusu onun yerine geçmez.

## Konu: revAgent bağlantı altyapısı geçişi

Merhaba,

revAgent bağlantısını ofis dışından da güvenli ve izlenebilir çalışacak merkezi yapıya geçiriyoruz. Revit
üretimi mevcut kurulum üzerinden devam edecektir; geçiş tarihi ayrıca duyurulacaktır.

## Geçişte ne değişecek?

- Günlük istemci mevcut yetkilendirilmiş ChatGPT/Codex Desktop olarak kalacaktır.
- Eski yerel revAgent bağlantılarının yerine yeni uzak MCP kaydı kullanılacaktır.
- İstemcinin kurulumu, aboneliği, güncellenmesi ve kullanıcı oturumu kullanıcı sorumluluğundadır. revAgent
  ekibi uzak MCP kaydını ve Revit'e kadar uçtan uca uyumluluğu doğrular.
- Geçişten önce 30 dakikalık uygulamalı eğitim ve tek sayfalık hızlı başlangıç kılavuzu paylaşılacaktır.
- Yalnız revAgent tarafından yönetilen eski yerel bağlantılar değiştirilecektir. Kişisel ChatGPT/Codex
  ayarlarına dokunulmadığı geçiş uygulama kılavuzunda doğrulanacaktır.
- Revit, Revit proje dosyaları ve kişisel proje klasörleri kaldırılmaz. Asistan bağlantısının kesilmesi
  Revit'in çalışmadığı anlamına gelmez; üretime güvenli şekilde devam edip destek ekibine haber verin.
- Excel/Word/PDF, yerel dosya aktarımı ve dışa aktarılan görsel akışlarında istemciye bağlı farklar olabilir.
  Kesin “devam ediyor/değişiyor/erteleniyor” listesi gerçek uyumluluk testlerinden sonra paylaşılacaktır.

## Sizden beklenenler

1. Bu duyuruyu aldığınızı `TBD yöntem/kanal` üzerinden onaylayın.
2. `TBD tarih/saat` eğitimine katılın veya hızlı başlangıç kılavuzunu okuyup onaylayın.
3. Geçiş akşamı Revit'i belirtilen saatte kapatın ve makinenizi açık, ağa bağlı bırakın.
4. Geçiş sonrası ilk açılışta mevcut ChatGPT/Codex Desktop oturumunuzu kontrol edin; teknik ekip eşliğinde
   bir okuma ve açıkça onaylanan tek bir yazma testi gerçekleştirin.
5. Sorunları `TBD destek kanalı / kişi / telefon` üzerinden bildirin; eski güncelleyiciyi çözüm olarak
   çalıştırmayın.

## Pilot makineye özel not

Pilot makine `NET01`'dir. Pilot başlamadan önce NAS güncelleyicinin zamanlanmış görevi teknik ekip tarafından
devre dışı bırakılacak, ancak korumalı geri dönüş başlatıcısı silinmeyecektir. Kullanıcı bu görevi veya
başlatıcıyı kendisi değiştirmemelidir. Tüm bilgisayarlarda geri dönüş kararı verilirse görev yalnız imzalı
uygulama kılavuzuyla yeniden açılır.

## Destek ve çalışma saatleri

- Geçiş sorumlusu: `TBD`
- Teknik destek: `TBD`
- Eğitim: `TBD`
- İki haftalık güvence dönemi ofis saatleri: `TBD`
- Acil durum kanalı: `TBD`

Teşekkürler.

## Gönderim öncesi onay listesi — belge sahibi için

- [ ] DP-10 sorumluluk sınırı ve mevcut ChatGPT/Codex Desktop istemci adı yazıldı.
- [ ] WP9; uzak bağlantı, açık onaylı işlem, uzun işlemlerin sonuç akışı, Türkçe kullanım ve yerel dosya
      akışlarını gerçek istemcide doğruladı.
- [ ] DP-12 geçiş tarihi, pilot kullanıcı, `NET01` ve destek sahipleri yazıldı.
- [ ] Zamanlanmış görevin dondurulmuş kanalda değişiklik yapmadan çıktığı gerçek bir iş istasyonunda
      doğrulandı ve kanıtlandı.
- [ ] Hızlı başlangıç, eğitim ve kullanıcıdan alındı onayı toplama yöntemi hazır.
- [ ] Duyuru operatör ve teknik lider tarafından onaylandı.

Bu maddeler tamamlanmadan geçiş duyurusu gönderilmemelidir. GAP-13.2 ara dönem metni kendi onay satırıyla
ayrı olarak ve geçiş duyurusunu beklemeden gönderilebilir.
