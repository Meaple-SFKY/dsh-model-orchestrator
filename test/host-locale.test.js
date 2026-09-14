/**
 * Host-locale tests.
 *
 * The host half has no `t` seat: it must read the language itself, and get it right
 * for a deployment whose settings service is absent, late, or silent. These are the
 * cases that decide whether `/model-orchestrator` answers in the user's language.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LANGUAGE,
  createHostLocale,
  languageFromEnvironment,
  normalizeLanguage,
} from '../lib/host-locale.js';
import { translate } from '../lib/locales.js';

test('a language tag is reduced to a shipped dictionary', () => {
  for (const tag of ['zh', 'ZH', 'zh-Hans', 'zh_CN', 'zh-cn']) {
    assert.equal(normalizeLanguage(tag), 'zh', `${tag} is Chinese`);
  }
  for (const tag of ['en', 'EN', 'en-US', 'en_GB']) {
    assert.equal(normalizeLanguage(tag), 'en', `${tag} is English`);
  }
  // A language the plugin does not ship is NOT silently rendered as English: the
  // caller is told nothing matched and falls back deliberately.
  assert.equal(normalizeLanguage('fr'), undefined);
  assert.equal(normalizeLanguage(''), undefined);
  assert.equal(normalizeLanguage(undefined), undefined);
  assert.equal(normalizeLanguage(7), undefined);
});

test('the environment is a usable fallback when no settings document exists', () => {
  assert.equal(languageFromEnvironment({ DSH_LOCALE: 'zh' }), 'zh');
  assert.equal(languageFromEnvironment({ LC_ALL: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(languageFromEnvironment({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(languageFromEnvironment({ LANG: 'fr_FR.UTF-8' }), undefined);
  assert.equal(languageFromEnvironment({}), undefined);
  // DSH_LOCALE wins over the conventional Unix variables.
  assert.equal(languageFromEnvironment({ DSH_LOCALE: 'zh', LANG: 'en_US' }), 'zh');
});

test('an explicit setting decides, and a change is observed without a restart', () => {
  let section = { preference: 'en' };
  let handler;
  const ctx = {
    inject: (services, callback) => {
      assert.deepEqual(services, ['settings']);
      callback({
        settings: { get: (ns) => (ns === 'locale' ? section : undefined) },
        on: (event, listener) => {
          assert.equal(event, 'settings/updated');
          handler = listener;
        },
      });
      return () => {};
    },
  };

  const seen = [];
  const locale = createHostLocale({ ctx, initial: 'en' });
  locale.subscribe((language) => seen.push(language));
  assert.equal(locale.language, 'en');

  section = { preference: 'zh' };
  handler('locale');
  assert.equal(locale.language, 'zh', 'the setting is read on the event');
  assert.deepEqual(seen, ['zh']);

  // An unrelated namespace must not re-read anything.
  handler('theme');
  assert.deepEqual(seen, ['zh']);

  // A no-op refresh must not notify: a listener that re-registers a command must not
  // fire on every unrelated commit.
  locale.refresh();
  assert.deepEqual(seen, ['zh']);
  locale.dispose();
});

test('a deployment with no settings service still gets a working language', () => {
  const ctx = { inject: (services, callback) => callback({ settings: undefined, on: () => {} }) };
  const locale = createHostLocale({ ctx, initial: undefined });
  assert.equal(locale.language, DEFAULT_LANGUAGE);
  assert.equal(locale.explicit, false, 'a default is not a selection');
  // And it still translates rather than throwing.
  assert.equal(typeof locale.translate('command.summary'), 'string');
  assert.equal(locale.translate('no.such.key.at.all'), 'no.such.key.at.all');
  locale.dispose();
});

test('a throwing settings service is contained and reported', () => {
  let seen;
  const ctx = {
    inject: (services, callback) =>
      callback({
        settings: {
          get: () => {
            throw new Error('settings unavailable');
          },
        },
        on: () => {},
      }),
  };
  const locale = createHostLocale({ ctx, logger: { warn: (message) => { seen = message; } } });
  assert.equal(locale.language, DEFAULT_LANGUAGE);
  assert.match(String(seen), /could not read the locale preference/);
  locale.dispose();
});

test('the dictionary lookup falls back to English and then to the key', () => {
  assert.match(translate('zh', 'command.summary'), /编排器/);
  assert.match(translate('en', 'command.summary'), /Model Orchestrator/);
  // An unknown language falls back to English rather than to nothing.
  assert.match(translate('fr', 'command.summary'), /Model Orchestrator/);
  assert.equal(translate('zh', 'nope'), 'nope');
  // Interpolation, and an unknown placeholder left literal exactly as the harness does.
  assert.equal(translate('en', 'command.routing', { task: 'X' }), 'Routing through the orchestrator: X');
  assert.equal(translate('en', 'command.routing', {}), 'Routing through the orchestrator: {task}');
});

test('the browser tells the host which language the UI is showing', () => {
  // The gap this closes: the harness resolves "explicit setting -> browser -> en" and
  // never writes the browser-derived value back, so in the DEFAULT case the host cannot
  // know the UI language and every host-rendered string stayed English inside a
  // Chinese UI.
  const ctx = { inject: (services, callback) => callback({ settings: undefined, on: () => {} }) };
  const locale = createHostLocale({ ctx, initial: undefined });
  // Whatever the host environment says, it is NOT the browser's answer yet — that
  // assertion is what matters here, and it must not depend on this machine's LANG.
  assert.notEqual(locale.source, 'browser');

  assert.equal(locale.report('zh'), true, 'a report changes the language');
  assert.equal(locale.language, 'zh');
  assert.equal(locale.source, 'browser');
  // Re-reporting the same language must not churn: the listener re-registers a command.
  assert.equal(locale.report('zh'), false);
  assert.equal(locale.report('fr'), true, 'an unsupported tag just falls back');
  assert.equal(locale.language, DEFAULT_LANGUAGE);
  locale.dispose();
});

test('an explicit setting outranks the browser, and the environment loses to it', () => {
  let section;
  const ctx = {
    inject: (services, callback) =>
      callback({ settings: { get: (ns) => (ns === 'locale' ? section : undefined) }, on: () => {} }),
  };
  const locale = createHostLocale({ ctx, initial: undefined });
  // No explicit setting: the browser wins over the environment.
  locale.report('zh');
  assert.equal(locale.language, 'zh');
  assert.equal(locale.source, 'browser');

  // An explicit choice wins outright.
  section = { preference: 'en' };
  locale.refresh();
  assert.equal(locale.language, 'en');
  assert.equal(locale.source, 'settings');

  // And the browser cannot override it.
  locale.report('zh');
  assert.equal(locale.language, 'en');
  assert.equal(locale.source, 'settings');

  // Clearing the setting hands the decision back to the browser.
  section = {};
  locale.refresh();
  assert.equal(locale.language, 'zh');
  assert.equal(locale.source, 'browser');
  locale.dispose();
});
