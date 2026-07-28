import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import i18n, {
    LANGUAGE_STORAGE_KEY,
    SUPPORTED_LANGUAGES,
    normalizeLanguage,
    type Language,
} from "@/i18n";
import { moment } from "@/lib/utils";
import "dayjs/locale/zh-cn";

interface LanguageOption {
    value: Language;
}

interface LanguageContextValue {
    language: Language;
    setLanguage: (language: Language) => Promise<void>;
    supportedLanguages: LanguageOption[];
}

const supportedLanguages = SUPPORTED_LANGUAGES.map((value) => ({ value }));

const LanguageContext = createContext<LanguageContextValue>({
    language: normalizeLanguage(i18n.language),
    setLanguage: async () => {
        /* noop */
    },
    supportedLanguages,
});

interface LanguageProviderProps {
    children: ReactNode;
}

function syncDocumentLanguage(language: Language) {
    moment.locale(language === "zh-CN" ? "zh-cn" : "en");

    if (typeof document !== "undefined") {
        document.documentElement.lang = language;
    }

    if (typeof window !== "undefined") {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    }
}

export function LanguageProvider({ children }: LanguageProviderProps) {
    const [language, setLanguageState] = useState<Language>(() =>
        normalizeLanguage(i18n.resolvedLanguage ?? i18n.language)
    );

    useEffect(() => {
        const handleLanguageChanged = (nextLanguage: string) => {
            const normalized = normalizeLanguage(nextLanguage);
            setLanguageState(normalized);
            syncDocumentLanguage(normalized);
        };

        handleLanguageChanged(i18n.resolvedLanguage ?? i18n.language);
        i18n.on("languageChanged", handleLanguageChanged);

        return () => {
            i18n.off("languageChanged", handleLanguageChanged);
        };
    }, []);

    const setLanguage = useCallback(async (nextLanguage: Language) => {
        await i18n.changeLanguage(nextLanguage);
    }, []);

    const value = useMemo(
        () => ({
            language,
            setLanguage,
            supportedLanguages,
        }),
        [language, setLanguage]
    );

    return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
    return useContext(LanguageContext);
}
