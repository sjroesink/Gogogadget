# Pluginarchitectuur

## Scheiding van verantwoordelijkheden

```text
Launcher UI (TypeScript / DOM)
    │
Context runtime ── commands.essentials
    │
    ├── provider.ollama ── ai.ollama ── commands.ai.ollama
    ├── provider.codex  ── ai.codex  ── commands.ai.codex
    └── provider.acp    ── ai.acp    ── commands.ai.acp
              │
          native.host
              │
     Rust: HTTP / stdio / platform
              │
     Windows apps / externe providers
```

De UI kent het `Provider`-contract, niet het protocol. `src/plugins/catalog.ts` registreert lazy providers. De concrete adapters staan in `ollama.ts` en `agent.ts`. ACP en Codex delen een stdio/RPC-implementatie, maar hebben verschillende initialisatie-, model- en promptprotocollen.

De Rust-host bevat geen modelnamen of AI-specifieke promptlogica. HTTP is momenteel afgebakend tot de twee Ollama-paden. De generieke stdio-host voert geconfigureerde executables uit met gescheiden argumenten, leest begrensde frames, verwerkt stderr zonder opslaggroei en sluit de procesboom. Commandinvoer gaat via stdin. Providerconfiguratie is vertrouwd: een gekozen agentprogramma kan lokaal code uitvoeren.

## Declaratieve tekstacties

`src/core/actions.ts` definieert het provideronafhankelijke formaat `{id, title, prompt, enabled}` en valideert zowel opgeslagen acties als AI-voorstellen. De UI verwerkt acties via hetzelfde `Provider.complete`-contract als chat; ACP, Ollama en Codex hebben hiervoor geen aparte implementatie nodig. Een actie start een nieuw gesprek. De UI toont de actietitel en de originele selectie, terwijl de provider de instructies plus de JSON-gequote selectie krijgt. Vervolgvragen behouden die instructies binnen het bestaande historielimiet.

Actiebeheer gebruikt een aparte, begrensde AI-aanvraag met alleen de actiecatalogus en het expliciete beheerverzoek. De uitvoer moet één geldig `add`, `update` of `delete`-voorstel zijn; updates en verwijderingen moeten naar een bestaande ID verwijzen. Het voorstel is inert totdat de gebruiker het opslaat. Geselecteerde tekst en AI-antwoorden worden nooit door de beheerrouter verwerkt. De schema-validatie en deterministische toepassing staan los van modelgedrag.

`src-tauri/src/selection.rs` is de Windows-adapter. Een aparte sneltoets start op aanvraag één blijvende worker met een eigen COM-levensduur. Die bewaart hoogstens één oorspronkelijk UIA-element en een gekloonde tekstselectie; COM-objecten verlaten deze thread niet. Die vraagt alleen de huidige TextPattern-selectie op, controleert wachtwoordvelden en focus, en emit een snapshot naar de frontend. Het openen wacht maximaal 1,5 seconde; late resultaten worden weggegooid. Bij ontbrekende ondersteuning blijft handmatig plakken beschikbaar. De normale launcher-sneltoets doet geen selectie-opvraag. Er is geen permanente toegankelijkheidslistener, clipboard-watcher of achtergrond-AI-proces.

## Runtimecontract

Een plugin heeft een unieke `id`, expliciete `requires`, unieke `provides` en een `activate(context)`-functie. De runtime:

1. Wacht tot alle vereiste services bestaan.
2. Activeert de plugin met een eigen `AbortSignal`.
3. Registreert services met eigendom en een inverse verwijdering.
4. Ruimt consumers eerst op bij verlies van een dependency.
5. Voert de eigen cleanupfuncties in omgekeerde volgorde uit en wacht ze af.
6. Activeert wachtende consumers opnieuw zodra de dependency terugkomt.

Mutaties worden geserialiseerd. Een activatiefout trekt al geregistreerde voorzieningen in en houdt de plugin op `failed`, zonder eindeloze automatische retries. Onverwante plugins blijven werken. Cycles zonder beschikbare basisservice blijven `waiting`. Conflicterende service-eigenaars worden bij registratie geweigerd. Zelfs als een cleanup faalt, worden resterende cleanups geprobeerd.

Een plugin moet elk zelf aangemaakt effect registreren. Gebruik `ctx.signal` ook na een `await` en gebruik `AbortSignal.any` voor de combinatie van een gebruiker-annulering en de pluginlevensduur. De runtime kan niet ontdekken dat willekeurige JavaScript-code buiten de context een globale listener of proces heeft aangemaakt. Dit is daarom een contract voor vertrouwde plugins, geen beveiligingsgrens.

## Een plugin toevoegen

```ts
import type { Plugin } from '../core/runtime';
import type { Provider, Command } from '../core/types';

export const summarize: Plugin = {
  id: 'commands.summarize',
  requires: ['ai.ollama'],
  provides: ['commands.summarize'],
  activate(ctx) {
    const ai = ctx.get<Provider>('ai.ollama');
    const commands: Command[] = [{
      id: 'summarize-example',
      title: 'Vat voorbeeldtekst samen',
      subtitle: 'Via je Ollama-provider',
      keywords: 'samenvatten summary',
      icon: 'spark',
      kind: 'ai',
      async run() {
        await ai.complete({
          model: 'jouw-geïnstalleerde-model',
          messages: [{ role: 'user', content: 'Vat samen: een voorbeeldtekst.' }],
          signal: ctx.signal,
          onText: text => console.log(text),
          onStatus: status => console.log(status),
        });
      },
    }];
    ctx.provide('commands.summarize', commands);
  },
};
```

Registreer de module in `rebuild()` en neem de geëxporteerde commandservice op in `rebuildIndex()`. Een nieuwe provider implementeert `models`, `complete` en `dispose`, voegt een catalogusentry en standaardconfiguratie toe en registreert zijn `ai.<id>`-service. Configuratie heeft versie 1 en wordt gecontroleerd bij het laden. Externe pluginbestanden worden momenteel niet via de UI geïmporteerd.

## Prestatiekeuzes

- Tauri gebruikt de aanwezige WebView2; productie bundelt geen Node of Chromium.
- De interface heeft één runtimeafhankelijkheid, `@tauri-apps/api`, en gebruikt systeemfonts en SVG-iconen.
- Provideradapters laden via dynamische imports. Geen health polling, geen modeldiscovery bij opstarten en geen permanente agentprocessen.
- App-indexering gebeurt eenmaal buiten het UI-thread; resultaten worden daarna lokaal uit een genormaliseerde index gezocht. Maximaal 40 zoekresultaten worden gerenderd.
- Streaming wijzigt alleen het actuele tekstknooppunt, hoogstens eenmaal per animation frame. Geen volledige gespreksrender per token. Een expliciet eindbericht over het IPC-kanaal voorkomt dat de UI te vroeg voltooiing ziet.
- Frames zijn begrensd op 4 MiB, output op 500.000 tekens per antwoord en context op 20 berichten. Requests hebben verbindings- en opdrachttimeouts.
- Agentprocessen per request beperken idle-geheugen, met extra handshake-latency als bewuste afweging. Een toekomstige optionele idle-cache moet eigendom, timeouts en teardown behouden.

## Overige platformen

De platformlaag zit in `src-tauri/src/platform.rs`. Windows gebruikt `Get-StartApps` voor Win32- en Store-apps en start een gekozen ID via de AppsFolder. Voor macOS is een .app-index/NSWorkspace-adapter nodig; voor Linux een .desktop-index/desktop-entry-adapter. URL-openen heeft al OS-specifieke implementaties. Voor Unix moet een eigen procesgroep met betrouwbare teardown worden toegevoegd. Tauri bundeldoelen en CI moeten vervolgens per platform worden ingesteld. Er is nog geen claim dat macOS of Linux releasewaardig is.

## Terugschrijven naar de selectie (0.1.5)

De native adapter levert een tijdelijk doeltoken bij een enkelvoudige selectie. De UI koppelt dat aan het actiegesprek; handmatige invoerwijzigingen, een nieuwe selectie, een nieuw gesprek en providerwissels verwijderen de UI-koppeling. `replace_selection` accepteert alleen een bestaand token en begrensde tekst zonder ongewenste besturingstekens. De worker verbruikt het doel vóór een poging, controleert het oorspronkelijke element, IsReadOnly, selectie-inhoud en beide UIA-rangegrenzen, herstelt de focus en stuurt één Unicode SendInput-batch. Het klembord blijft ongewijzigd. Een verstreken deadline voorkomt late invoer na vertraagde UIA-calls; er is geen externe timeout die een nog uitvoerbare schrijfopdracht ten onrechte als afgebroken meldt. Bij gedeeltelijke invoer volgt een fout en geen automatische retry.

## Plakken als geheel (0.1.6)

De Unicode-invoerbatch uit 0.1.5 is vervangen: het volledige antwoord gaat nu als CF_UNICODETEXT in een GMEM_MOVEABLE-blok naar het klembord, met de launcher als eigenaar. Na succesvolle SetClipboardData draagt de host het geheugen over aan Windows. Na sluiting van het klembord worden volgnummer en focus opnieuw gecontroleerd, waarna precies één Ctrl+V-shortcut wordt gestuurd. Het klembord wordt bewust niet onmiddellijk hersteld, zodat een asynchrone paste in de bronapp het antwoord kan blijven lezen. Gedeeltelijke shortcuts krijgen een best-effort key-up voor V en Ctrl, zonder de paste opnieuw te proberen. De bestaande selectie- en tokencontroles blijven gelden.
