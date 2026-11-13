# ioBroker-workflows

Gemeinsame GitHub-Workflows für die ioBroker-Adapter von Exc3pt10n: Prüfungen bei Pull Requests und automatische
Releases nach einem Merge. Jeder Adapter bindet sie über eine kurze `.github/workflows/test.yml` ein
([Vorlage](templates/test.yml)).

| Adapter | Sprache | `build` | Standard-Branch |
|---|---|---|---|
| ioBroker.hue-v2 (Pilot) | TypeScript | `true` | `master` |
| ioBroker.smartvis | TypeScript + React/Vite | `true` | `main` |
| ioBroker.toshiba-ac | JavaScript | `false` | `main` |
| ioBroker.sungrow-local | JavaScript | `false` | `main` |
| ioBroker.qhome-ess-hyb-g2 | JavaScript | `false` | `main` |

## Was geprüft wird

[`.github/workflows/adapter.yml`](.github/workflows/adapter.yml):

| Job | Wann | Was |
|---|---|---|
| `check` | immer | `npm ci`, Lint, bei `build: true` Typprüfung und Build, `npm test` je Node-Version |
| `integration` | immer | Integrationstest mit echter js-controller-Instanz |
| `install` | immer | Installation wie `iobroker url`: `npm install git+file://…` mit `--omit=dev` in einem leeren Verzeichnis; danach müssen `main`, `io-package.json` und `package.json` im Paket liegen. Prüft bei TS-Adaptern den Build über `prepare`, bei JS-Adaptern die `files`-Liste |
| `audit` | immer | `npm audit --omit=dev --audit-level=high` |
| `release-guard` | Pull Requests | Versionsregeln, siehe unten |
| `ci-result` | immer | Fasst alle Jobs zusammen, **der einzige Pflicht-Check** im Branch-Schutz |
| `release` | Push auf den Standard-Branch | nach grünem `check`, `integration` und `install`, siehe unten |

Pull Requests und Pushes laufen nur auf Linux mit Node 22/24 (Integrationstest einmal auf Node 22). Der wöchentliche
Lauf (`schedule`) und ein manueller Start (`workflow_dispatch`) nutzen die volle Matrix: Linux und Windows mit
Node 22, 24 und 26, auch für den Integrationstest.

Alle Jobs haben `timeout-minutes` und nur Leserecht, Schreibrecht hat allein `release`. Actions sind per Commit-SHA
eingebunden; Dependabot (`github-actions`) hält sie in diesem Repo aktuell.

### release-guard

[`scripts/check-release.mjs`](scripts/check-release.mjs) vergleicht den Pull Request mit dem Ziel-Branch. Ein Release
ist nötig, wenn er Folgendes ändert:

- Dateien, die ausgeliefert werden: alles aus `files` und `main` in `package.json`, `io-package.json` sowie
  `extra-runtime-paths` (Standard `src/`). README, LICENSE und CHANGELOG zählen nicht.
- In `package.json` die Felder `dependencies`, `optionalDependencies`, `peerDependencies`, `engines`, `main`,
  `files`, `name`, `os` oder `cpu`.
- In `package-lock.json` ein Paket ohne `"dev": true`, also eine Laufzeit-Abhängigkeit, auch eine indirekte.

Reine Werkzeug-Änderungen wie CI, Tests, Lint-Konfiguration, `CLAUDE.md` oder Updates von Dev-Abhängigkeiten brauchen
keine Version. Ist ein Release nötig oder wurde die Version geändert, muss Folgendes stimmen:

- Die Version ist größer als auf dem Ziel-Branch (Semver, auch Vorabversionen wie `4.0.0-alpha.2`).
- Die Version ist gleich in `package.json`, `package-lock.json` (oben und `packages[""]`) und in `common.version` von
  `io-package.json`.
- `common.news` enthält die Version als obersten Eintrag mit Texten in en, de, ru, pt, nl, fr, it, es, pl, uk und
  zh-cn, insgesamt höchstens 20 Einträge.
- `common.nogit` ist nicht gesetzt, sonst lehnt js-controller die Installation aus GitHub ab.
- `README.md` enthält einen nicht leeren Abschnitt `### <version> (JJJJ-MM-TT)`.

Lokal prüfen (im Adapter-Verzeichnis):

```bash
node ../ioBroker-workflows/scripts/check-release.mjs pr --base origin/main
```

```bash
node ../ioBroker-workflows/scripts/check-release.mjs verify
```

### Release

Nach jedem Push auf den Standard-Branch prüft der Job `release`, ob es den Tag `v<version>` aus `package.json` schon
gibt. Zeigt er auf einen älteren Commit, z. B. nach einem Merge ohne Versionssprung, passiert nichts. Andernfalls:

1. prüft er die Version erneut (`check-release.mjs verify`),
2. setzt den annotierten Tag `vX.Y.Z`,
3. baut bei `prebuilt-package: true` das Paket mit `npm ci` und `npm pack`,
4. legt ein GitHub-Release an. Die Notes kommen aus dem README-Abschnitt der Version, das `.tgz` kommt als Asset
   dazu. Vorabversionen werden als Pre-release markiert.
5. spult den Branch `release` auf den Tag vor, ohne Force-Push. Beim ersten Release wird der Branch angelegt.

Alles läuft in einem Job, weil Tags und Pushes mit `GITHUB_TOKEN` keine weiteren Workflows auslösen. Schlägt ein
Schritt fehl, schließt ein erneuter Start des Jobs das Release ab.

### Installationswege für Nutzer

| Zweck | URL für „Installieren aus eigener URL" |
|---|---|
| stabil, gleichbleibende URL | `https://github.com/Exc3pt10n/ioBroker.<name>/tarball/release` |
| fertig gebaut, ohne Build auf dem Pi | `https://github.com/Exc3pt10n/ioBroker.<name>/releases/download/vX.Y.Z/iobroker.<name>-X.Y.Z.tgz` |
| Entwicklungsstand | `https://github.com/Exc3pt10n/ioBroker.<name>/tarball/<Standard-Branch>` |

> Bei `.tgz`-URLs leitet js-controller den Adapternamen mit `/\.([-_\w]+)-[.\d]+/` aus dem Dateinamen ab. Bei
> `iobroker.hue-v2-4.0.2.tgz` sollte das laut Code `hue-v2` ergeben. Vor der Umstellung der Doku einmal praktisch
> testen.

## Parameter (`with:`)

| Parameter | Standard | Bedeutung |
|---|---|---|
| `default-branch` | `main` | Standard-Branch, nur dort wird released |
| `build` | `false` | TS-Adapter: `npm run check` und `npm run build` |
| `prebuilt-package` | `false` | `.tgz` am GitHub-Release |
| `release-branch` | `release` | Branch, der jedem Release folgt, leer zum Abschalten |
| `node-versions` | `["22", "24"]` | Node-Versionen für `check` |
| `integration-node` | `22` | Node für Integration, Installation, Audit und Release |
| `weekly-node-versions` | `["22", "24", "26"]` | volle Matrix |
| `weekly-os` | `["ubuntu-latest", "windows-latest"]` | volle Matrix |
| `lint-command` | `npm run lint` | leer zum Überspringen |
| `test-command` | `npm test` | Unit- und Paket-Tests |
| `integration-command` | `npm run test:integration` | leer zum Überspringen |
| `extra-runtime-paths` | `src/` | zusätzliche ausgelieferte Pfade für den release-guard |
| `audit-level` | `high` | Schwelle für `npm audit` |
| `tools-ref` | `v1` | Stand dieses Repos für `check-release.mjs`, passend zum eingebundenen Tag |

## Umstellung eines Adapters

1. `.github/workflows/test.yml` durch die [Vorlage](templates/test.yml) ersetzen: `default-branch`, `build` und
   `prebuilt-package` setzen, bei `master` auch `branches: [master]`.
2. `.github/workflows/tag-release.yml` löschen.
3. `.github/auto-merge.yml` durch die [Vorlage](templates/auto-merge.yml) ersetzen, damit nur noch
   Dev-Abhängigkeiten automatisch gemergt werden.
4. Bei sungrow-local und qhome-ess-hyb-g2 zusätzlich: `@alcalzone/release-script`, das Skript `release` und
   `.releaseconfig.json` entfernen, `engines.node` auf `>=22` anheben, die Versionsregeln der `CLAUDE.md`
   angleichen. Fehlende news-Übersetzungen ergänzen; bei sungrow-local fehlen sie für `0.3.0`.
5. In der `CLAUDE.md` den Abschnitt „Versions-Tags" auf den neuen Release-Ablauf umschreiben.
6. Diese Werkzeug-Änderungen in einem eigenen PR ohne Version mergen. Der nächste Versionssprung ist das erste
   Release über die neue Pipeline.
7. Branch-Schutz einrichten (Settings → Rules → Rulesets, Ziel Standard-Branch):
   - Pull Request vor dem Merge erforderlich
   - Force-Pushes und Löschen blockieren
   - Pflicht-Check `adapter / ci-result`, „Require branches to be up to date before merging"
   - Den Branch `release` nicht schützen oder `github-actions` als Bypass erlauben, sonst kann der Release-Job ihn
     nicht vorspulen.

## Versionen dieses Repos

Adapter binden `@v1` ein. `v1` ist ein beweglicher Tag auf dem neuesten kompatiblen Stand `v1.x.y`. Inkompatible
Änderungen, z. B. neue Pflicht-Parameter oder geänderte Job-Namen, bekommen `v2`, und dabei ändert sich der
Standard von `tools-ref`.

Die Tags werden nicht von Hand gesetzt: Nach einem Merge auf `main` setzt der Workflow
[Self-test](.github/workflows/self-test.yml) bei grünen Tests den Tag `vX.Y.Z` aus `package.json`, sofern er fehlt,
und zieht den Major-Tag (`v1`) auf diesen Stand. Für einen neuen Stand also im Pull Request die Version in
`package.json` erhöhen: Patch für Korrekturen, Minor für neue Parameter oder Prüfungen, Major für inkompatible
Änderungen.

Tests: `npm test`. Der Self-test führt zusätzlich actionlint aus.
