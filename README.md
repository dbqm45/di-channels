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

**„Czeka na Ciebie” z DI Decision** (krok 17): pdi wysyła nową pozycję skrzynki (bramka, PR, triaż, ocena skutku) na
podpisany `POST /pdi/waiting`; zatwierdzający dostaje prywatną wiadomość z terminem z operating modelu (OM1). W godzinach
ciszy (18:00–8:00 i weekendy, `DI_CHANNELS_TIMEZONE`) Slack sam wstrzymuje wiadomość do 8:00 najbliższego dnia
roboczego (`chat.scheduleMessage`).
Kolejne etapy terminu (N3) przychodzą jako osobne wiadomości: przypomnienie, „termin dziś”, „po terminie”, „zmiana
wstrzymana” (2 × termin) i „lista do przeglądu” (4 × termin).

**„Ask team” i dzienny skrót z DI Decision** (DI Team T6, plan: dbqm45/pdi `docs/plan-t6-skroty-slack.md`):
- `POST /pdi/asked`: gdy decydent w pdi pyta zespół, każda zapytana osoba dostaje prywatną wiadomość: kto pyta, o
  co, do kiedy i link „Answer in DI Decision”. pdi zna osoby tylko po `sub` z suity. Ta usługa pyta di-identity o
  zweryfikowany e-mail osoby (`GET /api/people/<sub>`, tylko dla klientów z `email: true`) i szuka jej w Slacku
  (`users.lookupByEmail`). E-mail nie wraca do pdi i nie trafia do logów. Odpowiedź mówi pdi, do kogo wiadomość
  doszła (`now`, `scheduled`, `not_in_slack`, `failed`, `duplicate`).
- `POST /pdi/digest`: raz w dzień roboczy jedna wiadomość dla zatwierdzającego (`to: { approver: true }`) albo dla
  osoby (`to: { person: <sub> }`): co czeka na decyzję (do 10 najpilniejszych), o co ją zapytano, co jest u zespołu,
  ile spraw jest na agendzie i kogo nie znaleziono w Slacku. Treść liczy pdi; pusty skrót nie wysyła niczego, a ten sam
  `id` drugi raz to `duplicate`.

Obie wiadomości mają ten sam podpis co `gate.waiting` i te same godziny ciszy. Wiadomości do osób (nie do
zatwierdzającego) działają tylko z połączeniem z suitą (sekcja 7 `slack-setup.md`).

Bez głosowania, odpowiedzi w wątku i Teams — to kolejne kroki.

## Uruchomienie

Node ≥ 22.18 (TypeScript uruchamiany bezpośrednio), bez zależności w czasie działania.

```bash
npm ci
npm test && npm run typecheck
cp .env.example .env   # uzupełnij klucze; npm start czyta .env, gdy istnieje
npm start
```

| Zmienna | Znaczenie |
|---|---|
| `SLACK_SIGNING_SECRET` | Basic Information → Signing Secret aplikacji Slack |
| `SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`); uprawnienia: `commands`, a dla „czeka na Ciebie” `chat:write` i `im:write` |
| `SLACK_TEAM_ID` | opcjonalnie: tylko ta przestrzeń Slacka (`T…`) |
| `DI_DEFINITION_URL` | adres DI Definition (https; http tylko dla localhost) |
| `CI_CHANNELS_SIGNING_SECRET` | ten sam sekret co w DI Definition |
| `DI_CHANNELS_WORKSPACES` | opcjonalnie: `KANAŁ=przestrzeń,…` (np. `C0123ABCD=mobile`); reszta kanałów → przestrzeń domyślna |
| `PDI_CHANNELS_SIGNING_SECRET` | „czeka na Ciebie”: ten sam sekret co w pdi; razem z `DI_CHANNELS_APPROVER` |
| `DI_CHANNELS_APPROVER` | identyfikator zatwierdzającego w Slacku (`U…`; profil → ⋮ → Copy member ID) |
| `DI_CHANNELS_TIMEZONE` | strefa godzin ciszy; domyślnie `Europe/Warsaw` |
| `PORT` | domyślnie 3100 |

## Aplikacja w Slacku

Krok po kroku z tunelem, kluczami i rozwiązywaniem problemów: [`slack-setup.md`](slack-setup.md).

1. Testowa przestrzeń Slacka (slack.com/get-started → „Create a new workspace”).
2. api.slack.com/apps → **Create New App** → **From a manifest** → ta przestrzeń → wklej
   [`slack/manifest.yaml`](slack/manifest.yaml) z `PUBLIC_URL` zamienionym na adres usługi.
3. **Install to Workspace**; potem Signing Secret i Bot User OAuth Token do zmiennych powyżej.

Slack wymaga publicznego adresu https; do testów wystarczy tunel do `localhost:3100`. Hosting docelowy — razem
z decyzją DA4.
