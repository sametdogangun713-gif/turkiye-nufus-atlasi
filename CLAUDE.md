# Türkiye Nüfus Atlası — proje kuralları

## Git
- İş bitince değişiklikleri sormadan doğrudan `main`'e commit et ve `origin main`'e pushla; ayrı dal açma.
- Önce testleri çalıştır (`uv run pytest`). Testler kırılırsa commit/push yapma, sonucu bildir.
- Yalnızca kendi değiştirdiğin dosyaları ekle; kullanıcıya ait yarım ya da izlenmeyen dosyalara dokunma.
- Commit mesajı Türkçe Conventional Commits biçiminde (`feat:`, `fix:`, `chore:` ...).
- `main`'e push Vercel'de otomatik yayın demektir.
