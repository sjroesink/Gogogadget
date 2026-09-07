# Gogogadget

Een kleine, toetsenbordgerichte AI-launcher voor Windows. Gebouwd met Tauri 2, Rust en TypeScript, met de systeem-WebView en zonder gebundelde Node- of Chromium-runtime. Node is alleen nodig tijdens ontwikkeling en eventueel voor een zelfgekozen agent.

## Starten

De gebouwde executable staat in `src-tauri/target/release/gogogadget.exe`. De NSIS-installer staat na `npm run desktop:build` in `src-tauri/target/release/bundle/nsis/`.

Open de app en gebruik **Ctrl+Alt+Space** om het venster te tonen of verbergen. Het systeemvakmenu biedt Openen en Afsluiten. Sluiten met het kruisje laat de launcher actief. Er wordt geen automatisch opstartitem aangemaakt.

| Toets | Actie |
|---|---|
| Ctrl+Alt+Space | Launcher tonen/verbergen, ook buiten de app |
| Ctrl+Alt+T | Geselecteerde tekst ophalen en tekstacties openen |
| ↑ / ↓, Enter | Resultaat kiezen en openen |
| Ctrl+J | AI-gesprek |
| Ctrl+, | Instellingen |
| Enter / Shift+Enter | Vraag versturen / nieuwe regel |
| Esc | Antwoord stoppen, terug, zoekveld wissen of verbergen |

De app indexeert Windows Start-apps eenmaal op de achtergrond. Zoekopdrachten blijven lokaal. Je kunt de index handmatig vernieuwen. AI wordt alleen aangeroepen als je een vraag verstuurt; een webzoekactie opent je standaardbrowser.

## Tekstacties

Selecteer tekst of code in een andere app en druk op **Ctrl+Alt+T**. Controleer de selectie en kies **Translate with AI** of **Rewrite with AI**. Het resultaat verschijnt als een nieuw gesprek, met Markdown. **Replace selection** zet het antwoord na jouw klik terug in het oorspronkelijke tekstveld; **Copy response** blijft beschikbaar om zelf te plakken. Vervangen is beschikbaar voor één via de sneltoets opgehaalde selectie, zolang je die invoer niet handmatig hebt aangepast. De vertaalactie vertaalt standaard naar het Engels; wijzig de instructies om een andere doeltaal te kiezen.

**Replace selection** controleert het oorspronkelijke veld, de tekst, beide selectiegrenzen en bewerkbaarheid voordat Windows tekstinvoer ontvangt. Een gewijzigde, verlopen of niet-bewerkbare selectie wordt geweigerd. Iedere poging verbruikt het doel, zodat je bij een fout opnieuw moet selecteren. Het antwoord wordt als tekst ingevoerd, met behoud van eventuele Markdown-markeringen, zonder het klembord te veranderen. Ondersteuning van Unicode-invoer, tabs en nieuwe regels hangt af van de bronapp.

Via **Manage actions** kun je acties toevoegen, bewerken, uitschakelen en verwijderen. Een actie bestaat uit een unieke ID, titel, instructies en een enabled-vlag. De geselecteerde tekst wordt automatisch als invoer toegevoegd. Acties gebruiken de gekozen provider en het gekozen model; ze zijn geen uitvoerbare scripts. Ze worden lokaal in het `actions`-veld van `settings.json` opgeslagen. Bestaande installaties krijgen de twee beginacties; een bewust leeggemaakte lijst blijft leeg.

Je kunt ook in **Ask AI** zeggen: “Voeg een actie toe waarmee ik geselecteerde tekst kan laten uitleggen met AI”, of in **Manage actions** beschrijven wat je wilt toevoegen, wijzigen of verwijderen. AI maakt een voorstel dat je kunt aanpassen en opslaan. Voor een verzoek dat niet automatisch herkend wordt, begin je met `/action`. Alleen direct ingevoerde beheeropdrachten openen deze route; geselecteerde tekst en AI-antwoorden kunnen zelf geen acties wijzigen.

Windows-selecties worden op aanvraag gelezen via UI Automation TextPattern, vóór de launcher focus krijgt. Er is geen polling en het klembord wordt niet gelezen of overschreven. Wachtwoordvelden worden overgeslagen. Sommige apps en code-editors publiceren hun selectie niet via toegankelijkheid; kopieer en plak de tekst dan in het selectieveld. Vastlopende providers krijgen maximaal 1,5 seconde voordat het plakveld verschijnt; er kan hoogstens één uitleesworker tegelijk actief zijn. De selectie is begrensd tot 100.000 tekens en blijft alleen in geheugen, totdat een actie haar als chatinvoer gebruikt. macOS/Linux hebben voor deze functie nog een native adapter nodig.

## Providers instellen

Open **Instellingen**, kies een provider, vul het model in of gebruik **Ophalen**, en klik **Opslaan**. Nieuwe installaties gebruiken standaard Codex met `gpt-5.6-terra`. **Gebruik als mijn AI-provider** bepaalt de actieve provider. Providers kunnen afzonderlijk aan en uit bij **Plugins**.

### Ollama

Start een bestaande Ollama-installatie. Het standaardadres is `http://127.0.0.1:11434`. Download zelf een model met de Ollama CLI, haal de modellijst op en selecteer een model. Er is geen ingebouwd standaardmodel of automatische modeldownload. De plugin gebruikt `/api/tags` en streaming `/api/chat`. Lokale HTTP en HTTPS-endpoints worden ondersteund; remote HTTP en redirects worden geweigerd. Cloud-API-key-authenticatie is nog niet ingebouwd.

### Codex

Installeer de Codex CLI en log in met `codex login`. Instellingen: programma `codex`, argumenten `["app-server"]`. Op Windows wordt de officiële npm-shim rechtstreeks naar zijn Node-entrypoint vertaald; prompttekst wordt nooit als shellcommando uitgevoerd. Je kunt ook een volledig pad naar `codex.exe` instellen.

De plugin gebruikt `initialize`, `initialized`, `model/list`, `thread/start`, `turn/start` en streaming notifications. Een leeg modelveld gebruikt de standaard van de agent. Taken krijgen een `read-only` sandbox, `approvalPolicy: never` en een tijdelijke thread. De standaardwerkmap is een aparte Gogogadget-map; een eigen werkmap is optioneel.

### ACP — Agent Client Protocol

Installeer en authenticeer eerst een ACP-compatibele agent. Vul het native programma in en de argumenten als JSON-array. Voor een JavaScript-agent: programma `node` en argumenten zoals `["C:/pad/naar/agent.js", "--acp"]`, aangepast aan die agent. `.cmd` en `.bat` worden niet via een shell uitgevoerd. De werkmap moet bestaan als je er zelf een invult.

ACP v1 over newline-delimited JSON-RPC/stdio wordt ondersteund: initialisatie, nieuwe sessies, prompt-streams en modelkeuze via `configOptions` met categorie `model`, met fallback naar de oudere `models`-interface. Niet iedere ACP-agent publiceert modellen; laat in dat geval het modelveld leeg. Authenticatie, filesystem- en terminalcallbacks worden niet door deze client aangeboden. Toestemmingsverzoeken worden met annulering beantwoord. Een ACP-agent is een lokaal programma met zijn eigen mogelijkheden en is geen sandbox van Gogogadget.

Agentprocessen starten per modelopvraag of vraag en sluiten daarna. Op Windows houdt een Job Object de procesboom bij. Annuleren sluit de verbinding en beëindigt de beheerde procesboom. Ollama's externe server blijft draaien; het model krijgt een keep-alive van 60 seconden.

## Ontwikkeling

Vereisten: Windows 10/11, WebView2 Runtime, Node.js 22.12+, Rust stable en Visual Studio Build Tools met Desktop development with C++. De lockfiles zijn onderdeel van het project.

```powershell
npm ci
npm run desktop
```

Alleen de interface bekijken: `npm run dev`, open `http://127.0.0.1:1420`. De browserpreview toont geen verzonnen apps of AI-antwoorden; native mogelijkheden werken uitsluitend in de desktop-app. Preview-instellingen en desktop-instellingen staan los van elkaar.

```powershell
npm test
npm run bench
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run desktop:build
```

De gewone tests gebruiken protocolfixtures en lokale transports. De optionele native live-tests lezen modellen bij reeds geïnstalleerde Codex/Ollama en starten een tijdelijke Codex-thread zonder inferentie:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml installed_ -- --ignored --nocapture
```

Voor een expliciete live-inferentietest kun je daarnaast `GOGOGADGET_LIVE_COMPLETION=1` zetten en met `GOGOGADGET_TEST_MODEL` een model uit je Codex-catalogus kiezen. Dat verstuurt één korte testprompt. CLI-versie en account moeten dat model ondersteunen; een modellijst alleen garandeert dat niet.

`.npmrc` gebruikt `legacy-peer-deps` vanwege een npm 10-resolverfout bij optionele Vitest-browserpeers. Er worden geen browser-testadapters gebruikt.

## Composability

De runtime is geïnspireerd op [A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512). Plugins declareren `requires` en `provides`, krijgen een eigen context en registreren opruimfuncties voor hun effecten. Afhankelijke plugins activeren opnieuw wanneer hun services terugkomen. Bij uitschakelen verdwijnen eerst de consumers, daarna de provider; opruiming wordt afgewacht, ook bij gedeeltelijk mislukte activatie.

Dit is een afgebakende implementatie van de principes, geen implementatie van de volledige Cordis-calculus of formeel bewijs van de paper. Opruiming geldt voor de geregistreerde runtime-effecten. Het starten van een app, een verstuurd AI-verzoek of wijzigingen door externe agents zijn geen terugdraaibare runtime-effecten. Meer details en een voorbeeld: [pluginarchitectuur](docs/architecture.md).

## Status van deze eerste versie

- Windows: native venster, systeemvak, single-instance, globale sneltoets, Start-appindex en starten van apps.
- Providers: drie ingebouwde plugins; laden op aanvraag, configureerbare modellen, streamen, annuleren, fout- en timeoutafhandeling.
- Plugins: broncodemodules die runtime kunnen worden uitgeschakeld; een externe pluginwinkel, pakketinstallatie en een sandbox voor onbetrouwbare plugins zijn nog niet gebouwd.
- Chat: Markdown-weergave met links, lijsten, tabellen en codeblokken, kopiëren en een nieuw gesprek. De interface gebruikt grijstinten. Maximaal 40 berichten blijven in geheugen; maximaal 20 gaan mee in een nieuwe vraag. Geen persistente gespreksgeschiedenis. Agents kunnen zelf gegevens bewaren volgens hun eigen configuratie.
- Portabiliteit: frontend, runtime en providerlogica zijn platformonafhankelijk. macOS/Linux-appindexering en procesboomopruiming moeten nog worden toegevoegd en getest; alleen Windows is nu een ondersteund doelplatform.
- De installer is niet code-ondertekend. Automatische updates, autostart, bestanden zoeken en clipboardgeschiedenis vallen buiten deze eerste versie.

Meetresultaten en de exacte verificatiegrenzen staan in [validation.md](docs/validation.md).

Bronnen voor de protocollen: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization), [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options), [Ollama chat API](https://docs.ollama.com/api/chat), [Tauri](https://v2.tauri.app/start/).
