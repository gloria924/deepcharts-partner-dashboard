# DeepCharts Partner – nuova dashboard

Dashboard interna per partner e affiliati DeepCharts. Pagine statiche (HTML, CSS, JavaScript), nessuna build richiesta. I dati arrivano da Supabase (progetto "DeepCharts Dashboard").

## File
- `public/index.html`, `public/styles.css`, `public/app.js`: l'applicazione
- `public/config.js`: indirizzo Supabase e chiave pubblica (non segreta: i dati sono protetti dalle regole di accesso del database)
- `public/_headers`: intestazioni di sicurezza
- `wrangler.jsonc`: dice a Cloudflare di pubblicare la cartella `public` così com'è

## Pubblicazione su Cloudflare
Progetto Cloudflare Workers collegato a questo repo (gloria924/deepcharts-partner-dashboard).
Build command vuoto, deploy command `npx wrangler deploy`. Ogni push su `main` ripubblica il sito.

## Accesso
Login con email e password di Supabase, le stesse della dashboard attuale. Possono entrare solo gli utenti presenti nella tabella `app_users` con `active = true`:
- `admin` e `staff`: vedono tutti i partner e le note interne, possono aggiornare l'onboarding
- `partner` (predisposto, non ancora usato): vede solo la propria scheda e le proprie pubblicazioni confermate

## Da dove arrivano i dati (fase 1)
Il workflow n8n "DeepCharts - sincronizza tabelle nuova dashboard" copia lo Sheet nelle tabelle Supabase ogni 15 minuti. Lo Sheet resta la fonte di verità per dati commerciali, canali e stato di verifica delle pubblicazioni. L'onboarding manuale invece si registra solo dalla dashboard.

## Anteprima in locale
Serve un piccolo server sulla cartella `public`, per esempio da VS Code con l'estensione Live Server, oppure `npx serve public`.
