import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    NEWS_LANGUAGES,
    changedRuntimeLockPackages,
    changelogSection,
    checkConsistency,
    checkPullRequest,
    compareVersions,
    isRuntimePath,
} from '../scripts/check-release.mjs';

const news = (...versions) =>
    Object.fromEntries(versions.map((v) => [v, Object.fromEntries(NEWS_LANGUAGES.map((l) => [l, `text ${l}`]))]));

const readme = (...versions) =>
    `# Adapter\n\n## Changelog\n<!--\n\t### **WORK IN PROGRESS**\n-->\n\n${versions
        .map((v) => `### ${v} (2026-11-13)\n- (Exc3pt10n) Änderung ${v}\n`)
        .join('\n')}\n## License\nMIT\n`;

function state(version, { deps = { a: '^1.0.0' }, lockDeps = { a: '1.0.0' }, newsVersions, readmeVersions } = {}) {
    const lock = {
        version,
        lockfileVersion: 3,
        packages: {
            '': { version, dependencies: deps },
            ...Object.fromEntries(Object.entries(lockDeps).map(([n, v]) => [`node_modules/${n}`, { version: v }])),
            'node_modules/eslint': { version: '9.0.0', dev: true },
        },
    };
    return {
        pkg: { name: 'iobroker.test', version, main: 'build/main.js', files: ['admin/', 'build/', 'io-package.json', 'README.md'], dependencies: deps },
        lock,
        ioPkg: { common: { version, news: news(...(newsVersions ?? [version])) } },
        readme: readme(...(readmeVersions ?? [version])),
    };
}

describe('compareVersions', () => {
    it('vergleicht nach Semver', () => {
        assert.equal(compareVersions('4.0.2', '4.0.1'), 1);
        assert.equal(compareVersions('4.0.1', '4.0.1'), 0);
        assert.equal(compareVersions('4.0.0', '4.0.0-alpha.1'), 1);
        assert.equal(compareVersions('4.0.0-alpha.10', '4.0.0-alpha.9'), 1);
        assert.equal(compareVersions('4.0.0-alpha.1', '4.0.0-beta.0'), -1);
        assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    });
});

describe('changelogSection', () => {
    it('liefert den Abschnitt bis zur nächsten Überschrift', () => {
        assert.equal(changelogSection(readme('4.0.2', '4.0.1'), '4.0.2'), '- (Exc3pt10n) Änderung 4.0.2');
        assert.equal(changelogSection(readme('4.0.1'), '4.0.1'), '- (Exc3pt10n) Änderung 4.0.1');
        assert.equal(changelogSection(readme('4.0.1'), '4.0.2'), null);
    });
    it('verwechselt keine Versionen mit gleichem Anfang', () => {
        assert.equal(changelogSection(readme('4.0.10'), '4.0.1'), null);
    });
});

describe('isRuntimePath', () => {
    const opts = { files: ['admin/', 'lib/', 'main.js', 'io-package.json', 'README.md', 'tools'], main: 'main.js', extraPaths: ['src/'] };
    it('erkennt ausgelieferte Dateien', () => {
        for (const f of ['admin/jsonConfig.json', 'lib/x.js', 'main.js', 'io-package.json', 'src/main.ts', 'tools/a.js']) {
            assert.ok(isRuntimePath(f, opts), f);
        }
    });
    it('ignoriert Werkzeuge und Dokumentation', () => {
        for (const f of ['README.md', '.github/workflows/test.yml', 'test/unit/a.test.ts', 'CLAUDE.md', 'eslint.config.mjs', 'mainjs', 'toolsx/a']) {
            assert.ok(!isRuntimePath(f, opts), f);
        }
    });
});

describe('changedRuntimeLockPackages', () => {
    it('ignoriert Dev-Abhängigkeiten', () => {
        const a = state('1.0.0').lock;
        const b = structuredClone(a);
        b.packages['node_modules/eslint'].version = '9.1.0';
        assert.deepEqual(changedRuntimeLockPackages(a, b), []);
        b.packages['node_modules/a'].version = '1.0.1';
        assert.deepEqual(changedRuntimeLockPackages(a, b), ['node_modules/a']);
    });
});

describe('checkConsistency', () => {
    it('akzeptiert einen vollständigen Stand', () => {
        assert.deepEqual(checkConsistency(state('4.0.2', { newsVersions: ['4.0.2', '4.0.1'] })), []);
    });
    it('meldet jede Abweichung', () => {
        const s = state('4.0.2');
        s.lock.packages[''].version = '4.0.1';
        s.ioPkg.common.version = '4.0.1';
        s.ioPkg.common.nogit = true;
        delete s.ioPkg.common.news['4.0.2']['zh-cn'];
        s.readme = readme('4.0.1');
        const errors = checkConsistency(s);
        assert.equal(errors.length, 5, errors.join('\n'));
        assert.match(errors.join('\n'), /packages\[""\]/);
        assert.match(errors.join('\n'), /zh-cn/);
        assert.match(errors.join('\n'), /nogit/);
    });
    it('verlangt den neuen news-Eintrag oben und höchstens 20 Einträge', () => {
        const versions = Array.from({ length: 21 }, (_, i) => `1.0.${i}`);
        const s = state('1.0.20', { newsVersions: versions });
        const errors = checkConsistency(s);
        assert.equal(errors.length, 2, errors.join('\n'));
    });
});

describe('checkPullRequest', () => {
    const base = state('4.0.1');

    it('lässt reine Werkzeug-Änderungen ohne Version durch', () => {
        const r = checkPullRequest({ base, head: state('4.0.1'), changedFiles: ['.github/workflows/test.yml', 'CLAUDE.md', 'README.md'] });
        assert.equal(r.needsRelease, false);
        assert.deepEqual(r.errors, []);
    });

    it('lässt Updates von Dev-Abhängigkeiten ohne Version durch', () => {
        const head = state('4.0.1');
        head.lock.packages['node_modules/eslint'].version = '9.2.0';
        const r = checkPullRequest({ base, head, changedFiles: ['package.json', 'package-lock.json'] });
        assert.equal(r.needsRelease, false);
        assert.deepEqual(r.errors, []);
    });

    it('verlangt eine neue Version bei Code-Änderungen', () => {
        const r = checkPullRequest({ base, head: state('4.0.1'), changedFiles: ['src/main.ts'], extraPaths: ['src/'] });
        assert.equal(r.needsRelease, true);
        assert.match(r.errors.join('\n'), /muss steigen/);
    });

    it('verlangt eine neue Version bei Laufzeit-Abhängigkeiten im Lockfile', () => {
        const head = state('4.0.1', { lockDeps: { a: '1.0.1' } });
        const r = checkPullRequest({ base, head, changedFiles: ['package-lock.json'] });
        assert.equal(r.needsRelease, true);
        assert.match(r.errors.join('\n'), /muss steigen/);
    });

    it('akzeptiert eine vollständige neue Version', () => {
        const head = state('4.0.2', { newsVersions: ['4.0.2', '4.0.1'], readmeVersions: ['4.0.2', '4.0.1'] });
        const r = checkPullRequest({ base, head, changedFiles: ['src/main.ts', 'io-package.json', 'README.md'] });
        assert.deepEqual(r.errors, []);
    });

    it('prüft eine Versionsänderung auch ohne Code-Änderung', () => {
        const head = state('4.0.2', { readmeVersions: ['4.0.1'] });
        const r = checkPullRequest({ base, head, changedFiles: ['package.json'] });
        assert.match(r.errors.join('\n'), /README/);
    });

    it('lehnt eine kleinere Version ab', () => {
        const head = state('4.0.0', { newsVersions: ['4.0.0'] });
        const r = checkPullRequest({ base, head, changedFiles: ['src/main.ts'] });
        assert.match(r.errors.join('\n'), /muss steigen/);
    });
});
