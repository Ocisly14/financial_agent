import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export const LANGUAGE_STORAGE_KEY = "financial-agent:language";
export const DEFAULT_LANGUAGE = "en" as const;
export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export function normalizeLanguage(value?: string | null): Language {
    if (!value) {
        return DEFAULT_LANGUAGE;
    }

    return value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function getStoredLanguage(): Language | null {
    if (typeof window === "undefined") {
        return null;
    }

    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return stored ? normalizeLanguage(stored) : null;
}

function getBrowserLanguage(): Language {
    if (typeof navigator === "undefined") {
        return DEFAULT_LANGUAGE;
    }

    return normalizeLanguage(navigator.language);
}

export function getInitialLanguage(): Language {
    return getStoredLanguage() ?? getBrowserLanguage();
}

if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
        resources: {
            en: { translation: en },
            "zh-CN": { translation: zhCN },
        },
        lng: getInitialLanguage(),
        fallbackLng: DEFAULT_LANGUAGE,
        supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
        interpolation: {
            escapeValue: false,
        },
        returnObjects: true,
        react: {
            useSuspense: false,
        },
    });
}

export default i18n;
