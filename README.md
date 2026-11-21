# DeepCharts Partner – nuova dashboard

Dashboard interna per partner e affiliati DeepCharts. Pagine statiche (HTML, CSS, JavaScript), nessuna build richiesta. I dati arrivano da Supabase (progetto "DeepCharts Dashboard").

## File
- `index.html`, `styles.css`, `app.js`: l'applicazione
- `config.js`: indirizzo Supabase e chiave pubblica (non segreta: i dati sono protetti dalle regole di accesso del database)
- `_headers`: intestazioni di sicurezza per Cloudflare Pages

## Pubblicazione su Cloudflare Pages
1. Crea un repo GitHub nuovo (es. `deepcharts-partner-dashboard`) e carica questi file nella radice.
2. In Cloudflare: Workers & Pages → Create → Pages → Connect to Git → scegli il repo.
3. Impostazioni di build: framework "None", build command vuoto, output directory `/`.
4. Deploy. Ogni push sul branch principale ripubblica il sito.

## Accesso
Login con email e password di Supabase, le stesse della dashboard attuale. Possono entrare solo gli utenti presenti nella tabella `app_users` con `active = true`:
- `admin` e `staff`: vedono tutti i partner e le note interne, possono aggiornare l'onboarding
- `partner` (predisposto, non ancora usato): vede solo la propria scheda e le proprie pubblicazioni confermate

## Da dove arrivano i dati (fase 1)
Il workflow n8n "DeepCharts - sincronizza tabelle nuova dashboard" copia lo Sheet nelle tabelle Supabase ogni 15 minuti. Lo Sheet resta la fonte di verità per dati commerciali, canali e stato di verifica delle pubblicazioni. L'onboarding manuale invece si registra solo dalla dashboard.

## Anteprima in locale
Serve un piccolo server, per esempio da VS Code con l'estensione Live Server, oppure `npx serve .` dalla cartella.
