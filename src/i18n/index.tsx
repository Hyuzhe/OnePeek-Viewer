import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EN_DICT } from "./en";
import { ZH_DICT, type I18nKey } from "./zh";

export type Locale = "zh" | "en";
export type { I18nKey };

const DICTIONARIES: Record<Locale, Record<I18nKey, string>> = {
  zh: ZH_DICT,
  en: EN_DICT,
};

function detectSystemLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const primary = (navigator.language || navigator.languages?.[0] || "").toLowerCase();
  return primary.startsWith("zh") ? "zh" : "en";
}

let activeLocale: Locale = detectSystemLocale();

function formatTemplate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`
  );
}

/**
 * Translate a key using the active locale (safe in non-React service helpers).
 */
export function tKey(key: I18nKey, params?: Record<string, string | number>): string {
  const template = DICTIONARIES[activeLocale][key] ?? ZH_DICT[key];
  return formatTemplate(template, params);
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

interface I18nContextValue {
  locale: Locale;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: activeLocale,
  t: tKey,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(detectSystemLocale);

  activeLocale = locale;

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    }
  }, [locale]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onLanguageChange = () => {
      const next = detectSystemLocale();
      activeLocale = next;
      setLocale(next);
    };
    window.addEventListener("languagechange", onLanguageChange);
    return () => window.removeEventListener("languagechange", onLanguageChange);
  }, []);

  const t = useCallback(
    (key: I18nKey, params?: Record<string, string | number>) => {
      const template = DICTIONARIES[locale][key] ?? ZH_DICT[key];
      return formatTemplate(template, params);
    },
    [locale]
  );

  const value = useMemo(() => ({ locale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
