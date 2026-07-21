# Kullanıcı Duyurusu Taslağı — revAgent Geçişi ve Güncelleme Dondurması

**Durum:** Taslak; henüz gönderilmemelidir

**Hedef kitle:** revAgent kullanan tüm ofis çalışanları

**Gönderim sahibi/tarihi:** `TBD`

**Kesim tarihi:** `TBD — DP-12`

**Yeni istemci:** `TBD — DP-10 / WP9`

## Konu: revAgent geçiş hazırlığı sırasında STABLE güncelleyiciyi çalıştırmayın

Merhaba,

revAgent altyapısını yeni merkezi Gateway/Bridge mimarisine taşıyoruz. Tasarım ve Revit üretimi mevcut revAgent kurulumu üzerinden devam edecek; kesim tarihi ayrıca duyurulacaktır.

Bugünden yeni duyuruya kadar aşağıdaki kurallar geçerlidir:

- `Start-revAgent-Update.cmd`, STABLE güncelleyici arayüzü veya `Install-revAgent-Updater-GUI.cmd` dosyasını elle çalıştırmayın.
- Bilgisayarınızdaki revAgent/Codex ayarlarını, görevlerini veya `C:\ProgramData\DPE\revAgent` içeriğini kendiniz silmeyin ya da taşımayın.
- Güncelleme ister gibi görünen bir uyarı alırsanız ekran görüntüsünü destek kişisine iletin; kendiniz onarım/rollback denemeyin.
- Acil güvenlik düzeltmeleri yalnız kayıtlı operatör onayı ve doğrulanmış yayın süreciyle yapılacaktır. Kullanıcıdan NAS yayını veya manuel kurulum yapması istenmeyecektir.

STABLE kanal şu anda dondurulmuştur. Zamanlanmış güncelleme görevlerinin bu durumda değişiklik yapmadan çıkması teknik ekip tarafından ayrıca doğrulanacaktır; bu doğrulama tamamlanmış varsayılmamalıdır.

## Kesimde ne değişecek?

- Günlük sohbet/komut istemcisi, WP9 değerlendirmesiyle seçilen ve pilotta gerçek iş üzerinde doğrulanan istemci olacaktır: **`TBD`**.
- Kesimden önce 30 dakikalık uygulamalı eğitim ve tek sayfalık hızlı başlangıç kılavuzu paylaşılacaktır.
- Yalnız revAgent tarafından yönetilen eski Codex MCP bağlantıları kaldırılacaktır. Kişisel Codex ayarlarına dokunulmayacağı, kesim runbook’unda ayrıca doğrulanacaktır.
- Revit proje dosyaları ve Revit’in kendisi kaldırılmaz. Asistan bağlantısının kesilmesi Revit’in çalışmadığı anlamına gelmez; üretime güvenli şekilde devam edip destek ekibine haber verin.
- Excel/Word/PDF, yerel dosya aktarımı ve dışa aktarılan görsel akışlarında istemciye bağlı farklar olabilir. Kesin “devam ediyor/değişiyor/erteleniyor” listesi WP9 matrisi tamamlanınca bu duyuruya eklenecektir.

## Sizden beklenenler

1. Bu duyuruyu aldığınızı `TBD yöntem/kanal` üzerinden onaylayın.
2. `TBD tarih/saat` eğitimine katılın veya hızlı başlangıç kılavuzunu okuyup onaylayın.
3. Kesim akşamı Revit’i belirtilen saatte kapatın ve makinenizi açık/ağa bağlı bırakın.
4. Kesim sonrası ilk açılışta yeni istemciye giriş yapın; teknik ekip eşliğinde bir okuma ve onaylı yazma testi gerçekleştirin.
5. Sorunları `TBD destek kanalı / kişi / telefon` üzerinden bildirin; eski güncelleyiciyi çözüm olarak çalıştırmayın.

## Pilot makineye özel not

Pilot makinede NAS güncelleyici zamanlanmış görevi pilot başlamadan önce teknik ekip tarafından **devre dışı bırakılacak**, ancak rollback için korunan bootstrap silinmeyecektir. Kullanıcı bu görevi kendisi açıp kapatmamalıdır. Fleet rollback kararı verilirse görevin geri açılması yalnız imzalı rollback runbook’uyla yapılacaktır.

## Destek ve çalışma saatleri

- Kesim sorumlusu: `TBD`
- Teknik destek: `TBD`
- Eğitim: `TBD`
- İki haftalık sigorta dönemi ofis saatleri: `TBD`
- Acil durum kanalı: `TBD`

Teşekkürler.

## Gönderim öncesi onay listesi — belge sahibi için

- [ ] DP-10 istemci adı, lisans/koltuk koşulları ve kurulum adımları kesinleşti.
- [ ] WP9 confirm round-trip, streaming, Türkçe UX ve yerel dosya akışlarını gerçek istemcide doğruladı.
- [ ] DP-12 kesim tarihi, pilot kullanıcı/makine ve destek sahipleri yazıldı.
- [ ] Scheduled-task no-op davranışı frozen kanalda gerçek bir iş istasyonunda doğrulandı ve kanıtlandı.
- [ ] Hızlı başlangıç, eğitim ve kullanıcı acknowledgement yöntemi hazır.
- [ ] Duyuru operatör ve teknik lider tarafından onaylandı.

Bu maddeler tamamlanmadan taslak kesim duyurusu olarak gönderilmemelidir. Ancak “STABLE güncelleyiciyi elle çalıştırmayın” ara dönem mesajı GAP-13.2 kapsamında ayrı ve derhal onaylanıp tüm kullanıcılara iletilmelidir.
