import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useTranslation } from "react-i18next";

const CopyButton = ({ text }: { text: string | undefined }) => {
    const [copied, setCopied] = useState(false);
    const { t } = useTranslation();

    const handleCopy = () => {
        if (!text) return; // Don't copy if text is undefined
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
        });
    };

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    onClick={handleCopy}
                    variant="ghost"
                    size="icon"
                    className="flex items-center space-x-2 text-muted-foreground"
                >
                    {copied ? (
                        <Check className="size-4" />
                    ) : (
                        <Copy className="size-4" />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
                <p>{copied ? t("common.copied") : t("common.copy")}</p>
            </TooltipContent>
        </Tooltip>
    );
};

export default CopyButton;
