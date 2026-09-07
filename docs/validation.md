# Verificatie — 7 september 2026

Oorspronkelijk getest op deze Windows-ontwikkelmachine met Node 22.19.0, Rust 1.93.1 en Codex CLI 0.116.0. De aanvullende Terra-verificatie hieronder gebruikt CLI 0.153.4. Metingen zijn lokale observaties, geen universele garanties.

## Uitgevoerde controles

- TypeScript strict-check en Vite-productiebuild.
- 17 Vitest-tests: activatie/cleanup/afhankelijkheden, foutisolatie, cycles, eigenaarschap, zoeken, configvalidatie, ACP- en Codex-protocollen, modelkeuze, streaming, permission denial, afgebroken responses, timeout, cancellation en IPC-eindvolgorde.
- 7 Rust-tests, inclusief de optionele live-tests: lokale stdio roundtrip, wachtende teardown, grote frames, stderr, gesplitste UTF-8, HTTP-annulering, endpointvalidatie en echte providerdiscovery.
- Codex: handshake en **6 modellen** opgehaald via de native stdio-host.
- Ollama: **7 modellen** opgehaald via de native HTTP-host.
- Rust Clippy met warnings als fouten.
- Native launcher gestart, **312 Windows-apps** geïndexeerd en het instellingenscherm geopend.
- Browsercontrole: zoekscherm, pluginbeheer, uitschakelen en reactiveren van afhankelijke AI-opdrachten, providerinstellingen en validatiefouten.

De Windows-automatisering verloor tijdens verdere bediening toegang (`GetCursorPos failed: Access is denied`). Daarom zijn app-startacties, globale sneltoetsen en de complete native chatbediening niet volledig via UI-automatisering geverifieerd. Bij de eerste controles was streaming getest met protocolfixtures en echte lokale transports; de latere live Terra-test staat hieronder. ACP is getest tegen protocolfixtures, niet tegen iedere externe ACP-agent. macOS/Linux zijn niet getest.

## Metingen

| Onderdeel | Waarneming |
|---|---|
| Zoeken over 10.000 opdrachten | gemiddeld 0,75 ms; p99 1,31 ms |
| Zoekbenchmark | 667 samples, Vitest bench, alleen indexwerk, geen DOM |
| Initieel launcher-JavaScript | circa 33 kB ongecomprimeerd / 12 kB gzip |
| Providerchunks | circa 0,84 kB Ollama; 6 kB gedeelde agentlogica |
| CSS | circa 14 kB ongecomprimeerd |
| Windows-executable | circa 4,7 MB, exclusief systeem-WebView en modellen |

De opstarttijd en het totale geheugengebruik inclusief alle WebView2-processen zijn nog niet betrouwbaar gebenchmarkt. De zoekbenchmark meet niet AI-latency; die wordt grotendeels bepaald door het gekozen model en de provider.

Herhaalbare opdrachten staan in de README. De CI voert gewone tests uit zonder een AI-account, modeldownload of inferentieverzoek. De optionele live-tests zijn expliciet te starten.

## Reparatie 0.1.1

De `thread/start`-parameter `sandbox` gebruikt `read-only`, terwijl het geretourneerde `SandboxPolicy.type` de waarde `readOnly` gebruikt. Deze twee enums waren verwisseld in de provider en de protocolfixture. De requestwaarde en fixture zijn gecorrigeerd en gecontroleerd tegen het schema dat Codex CLI 0.116.0 zelf genereert. De native live-test verifieert nu ook een echte tijdelijke `thread/start` en de teruggegeven sandbox.

Een volledige live-streamingtest is vervolgens geprobeerd. Het startverzoek werkt, maar inferentie wordt upstream geweigerd: het ingestelde standaardmodel `gpt-6-astra` vereist een nieuwere CLI, en het catalogusmodel `gpt-5.3-codex` wordt voor dit ChatGPT-account niet ondersteund. Er is geen automatische modelvervanging of wijziging van de gebruikersinstellingen gedaan. De inferentietest is apart opt-in via `GOGOGADGET_LIVE_COMPLETION=1`; gewone tests en standaard live-discovery doen geen inferentie.

## Terra met bijgewerkte CLI

De globale npm-installatie van Codex is bijgewerkt van 0.116.0 naar 0.153.4, omdat ook `gpt-5.6-terra` door de oude versie werd geweigerd. Via dezelfde native proceshost die Gogogadget gebruikt zijn nu 7 modellen gevonden, waaronder Terra. De optionele test `installed_codex_handshake_and_models` is geslaagd met `GOGOGADGET_LIVE_COMPLETION=1` en `GOGOGADGET_TEST_MODEL=gpt-5.6-terra`: de read-only sessie is gestart en de echte gestreamde reactie was `OK`. Hiervoor was geen wijziging aan de launcher-executable nodig.
## Tekstacties 0.1.4

- 26 gewone TypeScript-tests geslaagd; de optionele live-actietest wordt standaard overgeslagen.
- Native tests: 5 geslaagd, 2 bestaande live-tests overgeslagen. Rustfmt en Clippy met `-D warnings` geslaagd.
- Echte Terra-test geslaagd met de productie-Codex-adapter: een Nederlands verzoek maakte een geldig uitlegactievoorstel, waarna de gegenereerde actie een codefragment met resultaat 6 uitlegde. Alleen twee synthetische testprompts, geen echte selectie of gewijzigde gebruikersinstellingen.
- Browserpreview: toevoegen, uitschakelen, herladen/behouden en verwijderen van een tijdelijke actie gecontroleerd. Selectie- en beheerpagina visueel gecontroleerd op de launchermaat. Previewdata staan los van desktopinstellingen.
- De Windows-bedieningsomgeving leverde screenshots maar geen toegankelijkheidsinformatie voor het testvenster in Kladblok. De daadwerkelijke selectie-overdracht vanuit externe apps is daarom nog niet end-to-end bevestigd. Ondersteuning hangt af van de TextPattern-implementatie van de bronapp; handmatig plakken blijft beschikbaar.
- Initieel JavaScript circa 43,2 kB / 15,1 kB gzip; Markdown blijft een afzonderlijke lazy chunk. Geen nieuwe startup- of geheugencijfers gemeten. De normale launcher-sneltoets doet geen selectie-uitlezing.

De optionele live-actietest is te starten door `GOGOGADGET_ACTION_CODEX_EXE` in te stellen op het volledige pad naar een reeds ingelogde `codex.exe` en `npx vitest run tests/actions.live.test.ts` uit te voeren. Dit verstuurt twee korte inferentieverzoeken met Terra.
