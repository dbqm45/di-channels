# Slack: uruchomienie do testów

Instrukcja dla testu na żywo kroku 16 (akcja „dodaj pytanie do historyjki”). Wszystko działa na Twoim komputerze;
klucze zostają u Ciebie i nie trzeba ich nikomu podawać.

Potrzebne: workspace Slacka, w którym możesz instalować aplikacje; Node ≥ 22.18; działające lokalnie DI Definition
(`ci_for_sdlc`); `cloudflared` (tunel).

## 0. Workspace testowy

https://slack.com/get-started → **Create a new workspace** → potwierdź e-mail → nazwa, np. „DI Suite Test” → dodaj
kanał, np. `#refinement-test`. Plan darmowy wystarczy.

## 1. Aplikacja w Slacku (z manifestu)

1. https://api.slack.com/apps (zaloguj się tym samym kontem). Pusta lista aplikacji jest w porządku.
2. **Create New App** → **From a manifest** → wybierz workspace testowy → **Next**.
3. Zakładka **YAML** → wklej całą treść [`slack/manifest.yaml`](slack/manifest.yaml). Zamiast `PUBLIC_URL` wpisz
   na razie `example.com` (poprawisz w kroku 3; Slack nie sprawdza adresu przy tworzeniu).
4. **Next** → **Create**.
5. **Install to Workspace** → **Allow**.

## 2. Klucze

| Zmienna | Skąd |
|---|---|
| `SLACK_SIGNING_SECRET` | strona aplikacji → **Basic Information** → App Credentials → Signing Secret → **Show** |
| `SLACK_BOT_TOKEN` | **OAuth & Permissions** → Bot User OAuth Token (`xoxb-…`), widoczny po instalacji |
| `CI_CHANNELS_SIGNING_SECRET` | wymyślasz sam: długi losowy ciąg, np. `openssl rand -hex 32`; **ten sam** w obu aplikacjach |

Nie commituj kluczy i nie wklejaj ich do czatu.

## 3. Uruchomienie

**DI Definition** (`ci_for_sdlc`, wersja z `.env`, od ci_for_sdlc#146): w katalogu głównym `ci_for_sdlc` dopisz do
`.env` (utwórz go z `.env.example`, jeśli go nie ma)

```
CI_CHANNELS_SIGNING_SECRET=<ciąg z kroku 2>
```

i uruchom ponownie (`npm start` albo `npm run dev`). Na starcie zobaczysz `Settings read from …/.env`. Działa na
`http://127.0.0.1:4317`; sprawdzenie: `http://127.0.0.1:4317/api/health`. Starsza wersja DI Definition (bez tej
linii na starcie) nie czyta `.env` — wtedy `git pull` albo `CI_CHANNELS_SIGNING_SECRET=<ciąg> npm start`.

**DI Channels** (to repo):

```
git clone https://github.com/dbqm45/di-channels
cd di-channels
npm ci
cp .env.example .env
```

Uzupełnij `.env` kluczami z kroku 2 (`DI_DEFINITION_URL` jest już ustawiony na `http://127.0.0.1:4317`) i uruchom:

```
npm start
```

`npm start` czyta `.env`, gdy plik istnieje (plik jest w `.gitignore`). Zmienne podane w poleceniu wygrywają z plikiem.
Po starcie w terminalu: `di-channels on :3100`.

Usługa słucha na porcie 3100. Opcjonalnie: `SLACK_TEAM_ID=T…` (tylko ten workspace), `DI_CHANNELS_WORKSPACES=C…=mobile`
(kanał → przestrzeń w DI Definition).

**Tunel** (w drugim terminalu; macOS: `brew install cloudflared`):

```
cloudflared tunnel --url http://localhost:3100
```

Wypisze adres `https://<coś>.trycloudflare.com` — to Twój `PUBLIC_URL`. Wpisz go w aplikacji Slacka:

- **Slash Commands** → `/di-question` → Request URL: `https://<adres>/slack/commands`
- **Interactivity & Shortcuts** → Request URL: `https://<adres>/slack/interactions`

Darmowy tunel ma nowy adres przy każdym uruchomieniu — wtedy popraw oba pola. Sprawdzenie, że tunel działa:
`https://<adres>/health` zwraca `{"ok":true}`.

- Request URL to pełny adres ze ścieżką. Sam adres tunelu daje w terminalu `POST / → 404`, a w Slacku „did not
  respond”.
- `Tunnel not found` na starcie cloudflared: polecenie uruchamia stary nazwany tunel (z `~/.cloudflared/config.yml`).
  Do testów wystarczy `cloudflared tunnel --url …` powyżej; gdy odmawia przez plik konfiguracyjny, przenieś go na chwilę.
- `Failed to dial a quic connection` w oknie tunelu: sieć gubi ruch UDP, a w tym czasie Slack nie dociera do usługi.
  Pomaga `cloudflared tunnel --protocol http2 --url http://localhost:3100` (nowy adres, więc znowu oba pola).
- Stały adres daje dopiero nazwany tunel z domeną w Cloudflare albo wdrożenie (Hetzner, `docs/17` w pdi).

## 4. Test

- W kanale: `/di-question PAY-123 Czy to działa offline?` (klucz historyjki, która istnieje w DI Definition).
- Albo: najedź na wiadomość → **⋮** (More actions) → **Add question to a story** → popraw klucz i treść → **Add question**.

Pytanie pojawia się na stronie historyjki w DI Definition z autorem „<nazwa> (Slack)” i oznaczeniem
„Not accepted yet”. Gotowość obniża dopiero po przyjęciu przez PO.

## 5. „Czeka na Ciebie” z DI Decision (krok 17)

1. **Nowe uprawnienia:** w aplikacji Slacka **OAuth & Permissions** → Bot Token Scopes → dodaj `chat:write` i
   `im:write` (albo wklej nowy [`slack/manifest.yaml`](slack/manifest.yaml) w **App Manifest**) → **Reinstall to
   Workspace**. Token `xoxb-…` zwykle zostaje ten sam.
2. **Twój identyfikator w Slacku:** kliknij swoje zdjęcie → **Profile** → **⋮** → **Copy member ID** (`U…`).
3. **Wspólny sekret pdi ↔ DI Channels:** nowy losowy ciąg (`openssl rand -hex 32`).
4. **di-channels `.env`:**
   ```
   PDI_CHANNELS_SIGNING_SECRET=<ciąg z punktu 3>
   DI_CHANNELS_APPROVER=U…
   ```
   i ponownie `npm start`.
5. **pdi:** w środowisku `pdi-receiver` (i konsoli, i serwera MCP):
   ```
   PDI_CHANNELS_URL=http://localhost:3100
   PDI_CHANNELS_SIGNING_SECRET=<ten sam ciąg>
   ```
   (pdi i di-channels na tym samym komputerze: tunel nie jest potrzebny). Potem `sdlc down && sdlc up`.

Test: każda nowa pozycja w skrzynce DI Decision (np. prośba o bramkę z fabryki) daje wiadomość od **DI Suite** w
zakładce aplikacji w Slacku: co, przy jakiej zmianie, termin i gdzie zdecydować. Wieczorem i w weekend Slack pokaże
ją o 8:00. W terminalu di-channels: `waiting <pozycja>: sent` albo `scheduled for …`.

## 6. Przypomnienia o terminach (N3): cron

Przypomnienia, „po terminie”, „wstrzymana” i „do przeglądu” wysyła pdi, gdy ktoś sprawdzi terminy. Żeby działo się
to samo, dodaj cron po stronie pdi (szczegóły: README pdi, sekcja „Czeka na Ciebie” → Cron):

1. Do `~/.sdlc/env` dopisz `PDI_CHANNELS_URL=http://localhost:3100` i `PDI_CHANNELS_SIGNING_SECRET=<ten sam sekret
   co w di-channels/.env>`.
2. `crontab -e`, linia (pełne ścieżki: `which uv`, katalog klonu pdi):
   ```
   0 * * * * /opt/homebrew/bin/uv run --directory /Users/<ty>/<ścieżka>/pdi sdlc deadlines >> ~/.sdlc/deadlines.log 2>&1
   ```
3. di-channels musi wtedy działać (`npm start`), inaczej pdi zapisze wysyłkę jako nieudaną. Wieczorem i w weekend
   Slack sam wstrzyma wiadomość do 8:00.

Sprawdzenie od ręki: `uv run sdlc deadlines` w katalogu pdi; w terminalu di-channels pojawi się
`waiting <pozycja> (<etap>): sent`, jeśli jakiś etap minął.

## 7. Autor z suity (tożsamość suity, ADR 17)

Pytanie ze Slacka ma wtedy autora z suity (imię i nazwisko z `di-identity`), a nie „nazwa (Slack)”. Działa to, gdy
osoba zalogowała się już do suity (np. przez Google) tym samym adresem e-mail, którego używa w Slacku.

1. **Nowe uprawnienia aplikacji Slack.** Na api.slack.com/apps → aplikacja → **OAuth & Permissions → Bot Token
   Scopes** dodaj `users:read` i `users:read.email` (są już w `slack/manifest.yaml`), potem **Reinstall to
   Workspace**. Bez tego `users.info` odpowiada `missing_scope` i pytania idą z nazwą ze Slacka.
2. **Sekret klienta `di-channels`** w Keycloak suity: konsola administracyjna → realm `suite` → **Clients →
   di-channels → Credentials → Client secret**.
3. **`di-identity` z włączonym API wyszukiwania** (`DI_IDENTITY_CLIENT_SECRET`, README `di-identity`, sekcja „API”);
   `npm run identity -- configure` daje kontu `di-channels` rolę `di-identity:people-reader`.
4. W `.env` di-channels:
   ```
   SUITE_ISSUER=http://localhost:8180/realms/suite
   SUITE_CLIENT_SECRET=<sekret z kroku 2>
   DI_IDENTITY_URL=http://127.0.0.1:3200
   ```
   i ponowne uruchomienie `npm start`. Na starcie w terminalu: `suite person as author: on (di-identity …)`.
   `di-identity` lokalnie słucha na 3200 (3000 to API Flags, 3100 ta usługa). Adres `127.0.0.1`, nie `localhost`:
   na macOS `localhost:3100` trafia przez IPv6 w di-channels, więc zły port wygląda jak „brak osoby”.
5. **DI Definition z wersją, która przyjmuje autora z suity** (ci_for_sdlc, „take the suite person as author of chat
   questions”). Starsza wersja przyjmuje pytanie, ale pomija `suite_id` i dopisuje „(Slack)” do imienia z suity.
6. Test: `/di-question PAY-123 …` w Slacku. Na stronie historyjki w DI Definition autorem jest osoba z suity.

Gdy osoby nie ma w suicie, `di-identity` nie odpowiada albo minie limit czasu (w oknie skrótu 0,8 s), pytanie idzie
jak dotąd, z nazwą ze Slacka. Adres e-mail nie trafia do logów.

## 8. „Ask team” i dzienny skrót (DI Team T6)

Wymaga sekcji 5 i 7.

1. **Uprawnienia aplikacji Slack:** `users:read.email` z sekcji 7 wystarcza do `users.lookupByEmail`. Nic nowego.
2. **di-identity z `GET /api/people/<sub>`** (wersja z tym API). Odpowiada tylko klientom z `email: true`, czyli
   `di-channels`.
3. **pdi:** te same `PDI_CHANNELS_URL` i `PDI_CHANNELS_SIGNING_SECRET` co w sekcji 5. Pytanie zespołu wysyła się
   samo; dzienny skrót wysyła `sdlc digest`. Cron w dni robocze tuż przed 8:00 (szczegóły: README pdi):
   ```
   55 7 * * 1-5 /opt/homebrew/bin/uv run --directory /Users/<ty>/<ścieżka>/pdi sdlc digest >> ~/.sdlc/digest.log 2>&1
   ```
4. Test: w konsoli pdi zapytaj zespół („Ask team”) o osobę, która loguje się do suity tym samym e-mailem co do
   Slacka. W terminalu di-channels: `asked <pozycja>: now`. Osoba bez konta Slack z tym adresem: `not_in_slack`, a
   pdi pokazuje to przy pytaniu.

## Gdy coś nie działa

| Objaw | Przyczyna |
|---|---|
| Slack: „dispatch_failed” albo brak odpowiedzi | tunel nie działa albo zły Request URL; sprawdź `/health` |
| w terminalu: `refused a Slack request: invalid X-Slack-Signature` | zły `SLACK_SIGNING_SECRET` |
| „DI Definition did not answer” | DI Definition nie działa, zły `DI_DEFINITION_URL`, DI Definition bez `CI_CHANNELS_SIGNING_SECRET` (brak w `.env` albo stara wersja; odpowiada wtedy 404) albo różne sekrety w obu aplikacjach (401) |
| „There is no story …” | klucza nie ma w DI Definition (albo jest w innej przestrzeni — `DI_CHANNELS_WORKSPACES`) |
| skrót nie otwiera okna, w terminalu `views.open failed` | zły `SLACK_BOT_TOKEN` albo aplikacja niezainstalowana |
| na starcie: `suite person as author: off` | brak `SUITE_ISSUER`, `SUITE_CLIENT_SECRET`, `DI_IDENTITY_URL` w `.env` (albo zakomentowane) |
| `… not found: Slack gave no e-mail` | brak `users:read.email` w tokenie: ponowna instalacja aplikacji, nowy `SLACK_BOT_TOKEN` |
| `… not found: no single suite person with the Slack e-mail` | adres w Slacku inny niż konto w suicie albo osoba jeszcze się nie logowała |
| `… not found: DI_IDENTITY_URL answered 404 without a di-identity answer` | `DI_IDENTITY_URL` wskazuje inną usługę (np. port 3100 tej usługi) |
| `suite person for a Slack user not found: users.info: missing_scope` | brak `users:read`/`users:read.email` albo aplikacja niezainstalowana ponownie po ich dodaniu (punkt 7) |
| `waiting …: Slack refused the message: missing_scope` | brak `chat:write`/`im:write` albo aplikacja niezainstalowana ponownie po ich dodaniu |
| `Slack user for a suite person not found: di-identity refused: this client may not read e-mails` | di-identity bez `email: true` dla `di-channels` albo stara wersja bez `GET /api/people/<sub>` (punkt 8) |
| `Slack user for a suite person not found: no Slack user with the suite e-mail` | osoba ma w Slacku inny adres niż w suicie; pdi pokaże ją jako „not reachable in Slack” |
| na starcie: `… go together` | ustawiony tylko jeden z `PDI_CHANNELS_SIGNING_SECRET`, `DI_CHANNELS_APPROVER` |
| na starcie: `… is not set` | brak zmiennej o tej nazwie w `.env` (albo brak pliku `.env` w katalogu, z którego uruchamiasz `npm start`) |
| autor „<imię z Google> (Slack)” | DI Definition w starszej wersji (punkt 7.5): `git pull` w ci_for_sdlc i restart |

W terminalu jest linia na każde żądanie (`POST /slack/commands → 200 (12 ms)`) i wynik każdego pytania
(`question on PAY-123 from /di-question: added`). Brak linii po wysłaniu komendy znaczy, że żądanie ze Slacka nie
dotarło do usługi. Usługa nie zapisuje w terminalu treści pytań ani kluczy.
