import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";

type Theme = "light" | "dark";

interface ThemeContextValue {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    toggleTheme: () => void;
}

const DEFAULT_THEME: Theme = "dark";
const THEME_STORAGE_KEY = "financial-agent:theme";

const ThemeContext = createContext<ThemeContextValue>({
    theme: DEFAULT_THEME,
    setTheme: () => {
        /* noop */
    },
    toggleTheme: () => {
        /* noop */
    },
});

interface ThemeProviderProps {
    children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
    const [theme, setThemeState] = useState<Theme>(() => {
        let initialTheme = DEFAULT_THEME;

        if (typeof window !== "undefined") {
            const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
            initialTheme = storedTheme === "light" || storedTheme === "dark" ? storedTheme : DEFAULT_THEME;
        }

        if (typeof document !== "undefined") {
            const root = document.documentElement;
            root.classList.remove("light", "dark");
            root.classList.add(initialTheme);
            root.setAttribute("data-theme", initialTheme);
            root.style.colorScheme = initialTheme;
        }

        return initialTheme;
    });

    const updateDocumentTheme = useCallback((nextTheme: Theme) => {
        if (typeof document === "undefined") {
            return;
        }

        const root = document.documentElement;
        root.classList.remove("light", "dark");
        root.classList.add(nextTheme);
        root.setAttribute("data-theme", nextTheme);
        root.style.colorScheme = nextTheme;
    }, []);

    useEffect(() => {
        updateDocumentTheme(theme);

        if (typeof window !== "undefined") {
            window.localStorage.setItem(THEME_STORAGE_KEY, theme);
        }
    }, [theme, updateDocumentTheme]);

    const setTheme = useCallback((nextTheme: Theme) => {
        setThemeState(nextTheme);
    }, []);

    const toggleTheme = useCallback(() => {
        setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
    }, []);

    const value = useMemo(
        () => ({
            theme,
            setTheme,
            toggleTheme,
        }),
        [setTheme, theme, toggleTheme]
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
    return useContext(ThemeContext);
}
