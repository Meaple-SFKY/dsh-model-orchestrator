/**
 * The host half's view of the UI language.
 *
 * The browser half gets a `t` seat from the harness and re-renders whenever the
 * language changes. The HOST half gets nothing: a slash command's description, its
 * input hint, and every reply its handler returns are rendered by the harness, and the
 * harness translates a third-party command's copy only if the plugin wrote it in the
 * active language. So `/model-orchestrator` answered in English under a Chinese UI.
 *
 * The language itself is a durable host setting — the `locale` namespace owned by the
 * harness's locale plugin, whose `preference` field is the explicit selection. It is
 * read here, never written: the plugin has no business changing someone's language, and
 * an absent preference (which delegates to the browser) is reported as unknown so the
 * caller can decide rather than guess.
 *
 * Everything is optional and defensively resolved. A deployment without a settings
 * service, or one where the locale plugin is not mounted, still gets a working command
 * in the harness's default language.
 *
 * @module dsh-model-orchestrator/host-locale
 */
import { LANGUAGES, translate } from './locales.js';

/** Harness default, used whenever no explicit selection is readable. */
export const DEFAULT_LANGUAGE = 'en';

/**
 * Where the language came from, strongest first.
 *
 * `browser` sits between the durable setting and the environment, and it is the reason
 * this module has a `report()` at all: the harness resolves the language as
 * "explicit host setting → browser detection → en", and it does NOT write the
 * browser-derived value back to the host. So a deployment whose language comes from
 * browser detection — which is the default, and needs no user action — leaves the host
 * genuinely unable to know it, and every host-rendered string stayed English inside a
 * Chinese UI. The browser half knows the answer, so it tells the host. An explicit
 * setting still wins: a person who chose a language outranks a browser's guess.
 */
export const LANGUAGE_SOURCES = Object.freeze(['settings', 'browser', 'environment', 'initial', 'default']);

/** Settings namespace and field the harness's locale plugin owns. */
export const LOCALE_NAMESPACE = 'locale';
export const LOCALE_PREFERENCE_FIELD = 'preference';

/**
 * Reduce an arbitrary tag to a language this plugin ships.
 *
 * `zh-Hans`, `zh_CN` and `ZH` are all the Chinese dictionary; anything unknown is
 * `undefined` so the caller can fall back deliberately instead of silently rendering
 * English for a language the plugin does not have.
 *
 * @param value - the raw tag.
 * @returns `'en' | 'zh' | undefined`.
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return undefined;
  const tag = value.trim().toLowerCase();
  if (tag === '') return undefined;
  const base = tag.split(/[-_]/)[0];
  return LANGUAGES.includes(base) ? base : undefined;
}

/**
 * The language named by the environment, for a deployment with no settings service.
 *
 * `DSH_LOCALE` is the plugin-specific override; `LC_ALL`/`LC_MESSAGES`/`LANG` are the
 * conventional Unix sources a CLI host inherits.
 *
 * @param env - the environment (injectable for tests).
 * @returns `'en' | 'zh' | undefined`.
 */
export function languageFromEnvironment(env = globalThis.process?.env ?? {}) {
  for (const key of ['DSH_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const found = normalizeLanguage(env?.[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Create the host-side language reader.
 *
 * @param options - `{ ctx, logger, initial }`, where `ctx` may be undefined (tests).
 * @returns `{ get, subscribe, translate, dispose, source }`.
 */
export function createHostLocale({ ctx, logger, initial } = {}) {
  let settings;
  let language = normalizeLanguage(initial) ?? languageFromEnvironment() ?? DEFAULT_LANGUAGE;
  let source =
    normalizeLanguage(initial) !== undefined
      ? 'initial'
      : languageFromEnvironment() !== undefined
        ? 'environment'
        : 'default';
  // The language the browser half last reported, when it has. Not persisted and not
  // authoritative over an explicit setting.
  let reported;
  const listeners = new Set();

  /** Read the explicit selection from the harness's settings document. */
  function readFromSettings() {
    if (settings === undefined || typeof settings.get !== 'function') return undefined;
    try {
      const section = settings.get(LOCALE_NAMESPACE);
      return normalizeLanguage(section?.[LOCALE_PREFERENCE_FIELD]);
    } catch (error) {
      logger?.warn?.(`orchestrator: could not read the locale preference: ${String(error)}`);
      return undefined;
    }
  }

  /** Re-read the language and tell everyone when it actually changed. */
  function refresh() {
    const explicit = readFromSettings();
    const fromBrowser = normalizeLanguage(reported);
    const fromEnvironment = languageFromEnvironment();
    // Precedence: a person's explicit choice, then what the UI is actually showing,
    // then the host environment, then the harness default.
    let next;
    let nextSource;
    if (explicit !== undefined) {
      next = explicit;
      nextSource = 'settings';
    } else if (fromBrowser !== undefined) {
      next = fromBrowser;
      nextSource = 'browser';
    } else if (fromEnvironment !== undefined) {
      next = fromEnvironment;
      nextSource = 'environment';
    } else {
      next = DEFAULT_LANGUAGE;
      nextSource = 'default';
    }
    if (next === language && nextSource === source) return false;
    language = next;
    source = nextSource;
    for (const listener of [...listeners]) {
      try {
        listener(language);
      } catch (error) {
        logger?.warn?.(`orchestrator: a locale listener failed: ${String(error)}`);
      }
    }
    return true;
  }

  // The settings service is OPTIONAL and frequently mounted after this plugin
  // activates, so it is resolved through `ctx.inject` rather than read off the context
  // (which would throw for a name this plugin does not inject). The listener is
  // registered on the injected context, so disposing the injection removes it.
  const injected =
    typeof ctx?.inject === 'function'
      ? ctx.inject(['settings'], (settingsCtx) => {
          settings = settingsCtx.settings;
          try {
            settingsCtx.on('settings/updated', (namespace) => {
              if (namespace === undefined || namespace === LOCALE_NAMESPACE) refresh();
            });
          } catch (error) {
            // A context that refuses the event still gets the read below; only live
            // updates are lost.
            logger?.warn?.(`orchestrator: could not watch the locale setting: ${String(error)}`);
          }
          refresh();
          return undefined;
        })
      : undefined;

  return {
    /** The current language. */
    get language() {
      return language;
    },
    /** Which source decided it: `settings`, `environment`, or `initial`. */
    get source() {
      return source;
    },
    /** Whether the language is an explicit selection rather than a default. */
    get explicit() {
      return source === 'settings' || source === 'initial';
    },
    /**
     * Observe language changes.
     * @param listener - invoked with the new language.
     * @returns a disposer.
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Translate one key in the current language.
     * @param key - the dictionary key.
     * @param params - interpolation values.
     * @returns the rendered string.
     */
    translate(key, params) {
      return translate(language, key, params);
    },
    /**
     * Record the language the browser half is showing.
     *
     * @param value - the active locale id, as the client reports it.
     * @returns whether the language changed as a result.
     */
    report(value) {
      const next = normalizeLanguage(value);
      if (next === reported) return false;
      reported = next;
      return refresh();
    },
    /** Re-read the setting now (used by tests and by a manual refresh). */
    refresh,
    dispose() {
      listeners.clear();
      try {
        injected?.();
      } catch {
        // Injection teardown is owned by the Fiber.
      }
    },
  };
}
