# DI Channels

Usługa Delivery Intelligence Suite w komunikatorach. Na start (krok 16 planu suity, decyzja D-P9): **Slack** i jedna
akcja — **„dodaj pytanie do historyjki”** dla DI Definition (ci_for_sdlc, R1c z `docs/REFINEMENT-PLAN.md`).

- **Skrót wiadomości** „Add question to a story”: otwiera okno z kluczem historyjki (wyciągniętym z wiadomości)
  i treścią do poprawienia; po wysłaniu pokazuje wynik i link do historyjki. Link do wiadomości w Slacku trafia
  przy pytaniu.
- **Komenda** `/di-question PAY-123 treść pytania`: odpowiedź widzi tylko pytający.

Pytanie trafia do DI Definition przez podpisany `POST /api/webhooks/channels` (opis: ci_for_sdlc
`docs/CHANNELS.md`). Do czasu usługi tożsamości suity (krok 14) autorem jest nazwa ze Slacka; identyfikator
użytkownika Slacka idzie razem z pytaniem, żeby później powiązać go z kontem suity. Ponowne wysłanie tego samego
zdarzenia nie dodaje pytania drugi raz.

Bez przypomnień, głosowania, odpowiedzi w wątku i Teams — to R8 i kolejne kroki.

## Uruchomienie

Node ≥ 22.18 (TypeScript uruchamiany bezpośrednio), bez zależności w czasie działania.

```bash
npm ci
npm test && npm run typecheck
SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… CI_CHANNELS_SIGNING_SECRET=… DI_DEFINITION_URL=https://… npm start
```

| Zmienna | Znaczenie |
|---|---|
| `SLACK_SIGNING_SECRET` | Basic Information → Signing Secret aplikacji Slack |
| `SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`); jedyne uprawnienie: `commands` |
| `SLACK_TEAM_ID` | opcjonalnie: tylko ta przestrzeń Slacka (`T…`) |
| `DI_DEFINITION_URL` | adres DI Definition (https; http tylko dla localhost) |
| `CI_CHANNELS_SIGNING_SECRET` | ten sam sekret co w DI Definition |
| `DI_CHANNELS_WORKSPACES` | opcjonalnie: `KANAŁ=przestrzeń,…` (np. `C0123ABCD=mobile`); reszta kanałów → przestrzeń domyślna |
| `PORT` | domyślnie 3100 |

## Aplikacja w Slacku

1. Testowa przestrzeń Slacka (slack.com/get-started → „Create a new workspace”).
2. api.slack.com/apps → **Create New App** → **From a manifest** → ta przestrzeń → wklej
   [`slack/manifest.yaml`](slack/manifest.yaml) z `PUBLIC_URL` zamienionym na adres usługi.
3. **Install to Workspace**; potem Signing Secret i Bot User OAuth Token do zmiennych powyżej.

Slack wymaga publicznego adresu https; do testów wystarczy tunel do `localhost:3100`. Hosting docelowy — razem
z decyzją DA4.
