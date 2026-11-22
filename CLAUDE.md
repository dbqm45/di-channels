# CLAUDE.md

DI Channels — usługa Delivery Intelligence Suite w komunikatorach (Slack na start). Opis w `README.md` (po polsku).

- Kod po angielsku, TypeScript `strict`, uruchamiany przez Node bez kompilacji (type stripping): tylko składnia
  wymazywalna (`erasableSyntaxOnly`), importy względne z rozszerzeniem `.ts`.
- Bez zależności w czasie działania; nowa zależność tylko z uzasadnieniem w treści commita.
- Każde żądanie od Slacka: najpierw podpis (`slackSignatureProblem`); każde do DI Definition: podpis `X-DI-Signature`.
  Nie wysyłaj żądań pod adres z treści żądania poza `hooks.slack.com`.
- Nie loguj treści pytań, tokenów ani sekretów.
- Przed commitem: `npm run typecheck && npm test`; CI robi to samo.
- Commity i tytuły PR: Conventional Commits po angielsku, tryb rozkazujący, bez kropki, ≤ 72 znaki. Praca na
  gałęzi, PR do `main`.
