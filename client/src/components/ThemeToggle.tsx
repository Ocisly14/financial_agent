import { Sun, Moon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";

/**
 * Lives inline in the status bar now — no more floating fixed button.
 * `className` lets callers (currently just the status bar) fit it to
 * whatever chrome surrounds it without this component knowing about that
 * context.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const isDark = theme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? t("workspace.statusBar.switchToLight") : t("workspace.statusBar.switchToDark")}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={className ?? "text-label-2"}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
