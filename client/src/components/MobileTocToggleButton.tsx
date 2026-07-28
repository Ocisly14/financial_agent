import type React from "react";
import { ListTree } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { useTableOfContents } from "../contexts/TableOfContentsContext";

interface MobileTocToggleButtonProps {
    className?: string;
}

export const MobileTocToggleButton: React.FC<MobileTocToggleButtonProps> = ({ className }) => {
    const { hasAvailable, toggleMobile, isMobileOpen } = useTableOfContents();

    if (!hasAvailable) {
        return null;
    }

    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
                "h-7 w-7 md:hidden",
                isMobileOpen && "text-emerald-600 dark:text-emerald-400",
                className
            )}
            onClick={toggleMobile}
            aria-pressed={isMobileOpen}
            aria-label={isMobileOpen ? "Hide table of contents" : "Show table of contents"}
        >
            <ListTree className="h-4 w-4" />
        </Button>
    );
};
