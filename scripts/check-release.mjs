#!/usr/bin/env node
// Release-Prüfung für ioBroker-Adapter (ohne Abhängigkeiten, Node >= 22).
//
//   node check-release.mjs pr --base <sha> [--extra-runtime-paths "src/"]
//       Prüft einen Pull Request: Ändert er Code, der ausgeliefert wird, muss die Version
//       steigen und überall konsistent sein (package.json, package-lock.json, io-package.json,
//       common.news, README-Changelog).
//   node check-release.mjs verify
//       Prüft nur die Konsistenz der aktuellen Version (für den Release-Job).
//   node check-release.mjs notes <version>
//       Gibt den README-Changelog-Abschnitt der Version aus (Release-Notes).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const NEWS_LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
export const MAX_NEWS = 20;

// Felder in package.json, die das ausgelieferte Paket betreffen
const RUNTIME_PACKAGE_FIELDS = [
    'name',
    'main',
    'files',
    'engines',
    'os',
    'cpu',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
];

// Dateien, die zwar in "files" stehen können, aber keinen Release brauchen
const DOC_FILE = /^(README|LICENSE|CHANGELOG)[^/]*$/i;

// ---------- Semver ----------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v) {
    const m = SEMVER.exec(String(v ?? ''));
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

export function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) throw new Error(`Ungültige Version: ${!x ? a : b}`);
    for (const k of ['major', 'minor', 'patch']) {
        if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
    }
    // Ohne Vorabkennung ist höher als mit
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i];
        const q = y.pre[i];
        if (p === undefined) return -1;
        if (q === undefined) return 1;
        if (p === q) continue;
        const pn = /^\d+$/.test(p);
        const qn = /^\d+$/.test(q);
        if (pn && qn) return +p < +q ? -1 : 1;
        if (pn !== qn) return pn ? -1 : 1;
        return p < q ? -1 : 1;
    }
    return 0;
}

// ---------- Prüfungen ----------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Findet den Changelog-Abschnitt "### <version> (<datum>)" und liefert seinen Inhalt oder null. */
export function changelogSection(readme, version) {
    const lines = readme.split(/\r?\n/);
    const head = new RegExp(`^###\\s+${escapeRegExp(version)}\\s+\\(\\d{4}-\\d{2}-\\d{2}\\)\\s*$`);
    const start = lines.findIndex((l) => head.test(l));
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && !/^#{1,3}\s/.test(lines[end])) end++;
    return lines.slice(start + 1, end).join('\n').trim();
}

/** Konsistenz der Version in allen Dateien. Liefert eine Liste von Fehlern. */
export function checkConsistency({ pkg, lock, ioPkg, readme }) {
    const errors = [];
    const version = pkg.version;
    if (!parseVersion(version)) {
        errors.push(`package.json: "version" ist keine gültige Version: ${version}`);
        return errors;
    }
    if (lock) {
        if (lock.version !== version) errors.push(`package-lock.json: "version" ist ${lock.version}, erwartet ${version}`);
        const root = lock.packages?.[''];
        if (root && root.version !== version) {
            errors.push(`package-lock.json: packages[""].version ist ${root.version}, erwartet ${version}`);
        }
    }
    const common = ioPkg?.common ?? {};
    if (common.version !== version) errors.push(`io-package.json: common.version ist ${common.version}, erwartet ${version}`);
    if (common.nogit) errors.push('io-package.json: common.nogit ist gesetzt, die Installation aus GitHub wäre gesperrt');

    const news = common.news ?? {};
    const keys = Object.keys(news);
    const entry = news[version];
    if (!entry) {
        errors.push(`io-package.json: common.news hat keinen Eintrag für ${version}`);
    } else {
        if (keys[0] !== version) errors.push(`io-package.json: der Eintrag ${version} muss in common.news ganz oben stehen`);
        const missing = NEWS_LANGUAGES.filter((l) => typeof entry[l] !== 'string' || !entry[l].trim());
        if (missing.length) errors.push(`io-package.json: common.news["${version}"] fehlt in: ${missing.join(', ')}`);
    }
    if (keys.length > MAX_NEWS) errors.push(`io-package.json: common.news hat ${keys.length} Einträge, höchstens ${MAX_NEWS}`);

    if (readme === undefined) errors.push('README.md fehlt');
    else if (changelogSection(readme, version) === null) {
        errors.push(`README.md: Abschnitt "### ${version} (JJJJ-MM-TT)" fehlt im Changelog`);
    } else if (!changelogSection(readme, version)) {
        errors.push(`README.md: Abschnitt "### ${version}" ist leer`);
    }
    return errors;
}

/** Laufzeit-Pakete im Lockfile, deren Stand sich geändert hat (Pakete ohne "dev": true). */
export function changedRuntimeLockPackages(baseLock, headLock) {
    const runtime = (lock) => {
        const out = new Map();
        for (const [path, p] of Object.entries(lock?.packages ?? {})) {
            if (path === '' || p.dev) continue;
            out.set(path, JSON.stringify([p.version, p.resolved, p.integrity, p.link]));
        }
        return out;
    };
    const a = runtime(baseLock);
    const b = runtime(headLock);
    const changed = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) changed.push(k);
    return changed.sort();
}

/** Ob ein geänderter Pfad zum ausgelieferten Paket gehört. */
export function isRuntimePath(file, { files = [], main, extraPaths = [] }) {
    if (DOC_FILE.test(file)) return false;
    if (file === 'io-package.json') return true;
    if (main && file === main.replace(/^\.\//, '')) return true;
    const patterns = [...files, ...extraPaths].map((p) => p.replace(/^\.\//, '').replace(/\/\*\*?$/, '/'));
    return patterns.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p || file.startsWith(`${p}/`)));
}

/**
 * Prüft einen Pull Request.
 * @param {object} o
 * @param {object} o.base  { pkg, lock } auf dem Ziel-Branch
 * @param {object} o.head  { pkg, lock, ioPkg, readme } im Pull Request
 * @param {string[]} o.changedFiles
 * @param {string[]} [o.extraPaths]
 */
export function checkPullRequest({ base, head, changedFiles, extraPaths = [] }) {
    const reasons = [];
    const opts = { files: head.pkg.files ?? [], main: head.pkg.main, extraPaths };
    // Auch Pfade, die nur auf dem Ziel-Branch ausgeliefert wurden, zählen
    const baseOpts = { files: base.pkg.files ?? [], main: base.pkg.main, extraPaths };
    const runtimeFiles = changedFiles.filter((f) => isRuntimePath(f, opts) || isRuntimePath(f, baseOpts));
    if (runtimeFiles.length) reasons.push(`ausgelieferte Dateien geändert: ${runtimeFiles.join(', ')}`);

    const fields = RUNTIME_PACKAGE_FIELDS.filter(
        (f) => JSON.stringify(base.pkg[f] ?? null) !== JSON.stringify(head.pkg[f] ?? null),
    );
    if (fields.length) reasons.push(`package.json: ${fields.join(', ')} geändert`);

    const lockChanges = changedRuntimeLockPackages(base.lock, head.lock);
    if (lockChanges.length) {
        const shown = lockChanges.slice(0, 10).map((p) => p.replace(/^node_modules\//, ''));
        reasons.push(
            `Laufzeit-Abhängigkeiten im Lockfile geändert: ${shown.join(', ')}${lockChanges.length > 10 ? ', …' : ''}`,
        );
    }

    const versionChanged = base.pkg.version !== head.pkg.version;
    const errors = [];
    if (reasons.length || versionChanged) {
        if (!parseVersion(head.pkg.version)) {
            errors.push(`package.json: "version" ist keine gültige Version: ${head.pkg.version}`);
        } else if (parseVersion(base.pkg.version) && compareVersions(head.pkg.version, base.pkg.version) <= 0) {
            errors.push(
                `Die Version muss steigen: ${head.pkg.version} ist nicht größer als ${base.pkg.version} auf dem Ziel-Branch`,
            );
        }
        errors.push(...checkConsistency(head));
    }
    return { needsRelease: reasons.length > 0, versionChanged, reasons, errors };
}

// ---------- CLI ----------

function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readJson(file, optional = false) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        if (optional && e.code === 'ENOENT') return undefined;
        throw new Error(`${file}: ${e.message}`);
    }
}

function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return undefined;
        throw e;
    }
}

function jsonAt(rev, file) {
    try {
        return JSON.parse(git('show', `${rev}:${file}`));
    } catch {
        return undefined;
    }
}

function readHead() {
    return {
        pkg: readJson('package.json'),
        lock: readJson('package-lock.json', true),
        ioPkg: readJson('io-package.json'),
        readme: readText('README.md'),
    };
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
            out[k] = v;
        } else out._.push(a);
    }
    return out;
}

const splitList = (s) =>
    String(s ?? '')
        .split(/[\s,]+/)
        .filter(Boolean);

function report(errors, okMessage) {
    if (errors.length) {
        for (const e of errors) console.log(`::error::${e}`);
        console.log(`\n${errors.length} Fehler. Siehe "Versionierung" in der CLAUDE.md des Adapters.`);
        return 1;
    }
    console.log(okMessage);
    return 0;
}

export function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const [cmd] = args._;
    if (cmd === 'pr') {
        if (!args.base) throw new Error('--base <sha> fehlt');
        const changedFiles = git('diff', '--name-only', '--no-renames', `${args.base}...HEAD`).split('\n').filter(Boolean);
        const base = { pkg: jsonAt(args.base, 'package.json') ?? {}, lock: jsonAt(args.base, 'package-lock.json') };
        const head = readHead();
        const r = checkPullRequest({
            base,
            head,
            changedFiles,
            extraPaths: splitList(args['extra-runtime-paths'] ?? 'src/'),
        });
        console.log(`Version: ${base.pkg.version ?? '(keine)'} -> ${head.pkg.version}`);
        if (r.needsRelease) {
            console.log('Der Pull Request ändert das ausgelieferte Paket:');
            for (const reason of r.reasons) console.log(`  - ${reason}`);
        } else {
            console.log('Der Pull Request ändert nur Werkzeuge/Dokumentation, keine neue Version nötig.');
        }
        return report(r.errors, r.needsRelease || r.versionChanged ? `Version ${head.pkg.version} ist vollständig.` : 'OK');
    }
    if (cmd === 'verify') {
        const head = readHead();
        return report(checkConsistency(head), `Version ${head.pkg.version} ist vollständig.`);
    }
    if (cmd === 'notes') {
        const version = args._[1] ?? readJson('package.json').version;
        const section = changelogSection(readText('README.md') ?? '', version);
        if (section === null) throw new Error(`README.md: kein Abschnitt für ${version}`);
        process.stdout.write(`${section}\n`);
        return 0;
    }
    console.error('Aufruf: check-release.mjs pr --base <sha> | verify | notes [<version>]');
    return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        process.exitCode = main();
    } catch (e) {
        console.log(`::error::${e.message}`);
        process.exitCode = 1;
    }
}
