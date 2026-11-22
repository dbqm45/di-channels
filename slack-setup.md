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

## Gdy coś nie działa

| Objaw | Przyczyna |
|---|---|
| Slack: „dispatch_failed” albo brak odpowiedzi | tunel nie działa albo zły Request URL; sprawdź `/health` |
| w terminalu: `refused a Slack request: invalid X-Slack-Signature` | zły `SLACK_SIGNING_SECRET` |
| „DI Definition did not answer” | DI Definition nie działa, zły `DI_DEFINITION_URL`, DI Definition bez `CI_CHANNELS_SIGNING_SECRET` (brak w `.env` albo stara wersja; odpowiada wtedy 404) albo różne sekrety w obu aplikacjach (401) |
| „There is no story …” | klucza nie ma w DI Definition (albo jest w innej przestrzeni — `DI_CHANNELS_WORKSPACES`) |
| skrót nie otwiera okna, w terminalu `views.open failed` | zły `SLACK_BOT_TOKEN` albo aplikacja niezainstalowana |
| `waiting …: Slack refused the message: missing_scope` | brak `chat:write`/`im:write` albo aplikacja niezainstalowana ponownie po ich dodaniu |
| na starcie: `… go together` | ustawiony tylko jeden z `PDI_CHANNELS_SIGNING_SECRET`, `DI_CHANNELS_APPROVER` |
| na starcie: `… is not set` | brak zmiennej o tej nazwie w `.env` (albo brak pliku `.env` w katalogu, z którego uruchamiasz `npm start`) |

W terminalu jest linia na każde żądanie (`POST /slack/commands → 200 (12 ms)`) i wynik każdego pytania
(`question on PAY-123 from /di-question: added`). Brak linii po wysłaniu komendy znaczy, że żądanie ze Slacka nie
dotarło do usługi. Usługa nie zapisuje w terminalu treści pytań ani kluczy.
