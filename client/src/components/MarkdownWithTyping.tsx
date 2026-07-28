import type React from 'react';
import { useEffect } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

// Markdown container class - simplified since styling is now handled by MarkdownRenderer
const MARKDOWN_CONTAINER_CLASSES = "";

interface MarkdownWithTypingProps {
    children: string;
    delay?: number;
    onFinish?: () => void;
    anchorPrefix?: string;
}

export const MarkdownWithTyping: React.FC<MarkdownWithTypingProps> = ({
    children,
    onFinish,
    anchorPrefix = ""
}) => {
    useEffect(() => {
        if (onFinish) {
            onFinish();
        }
    }, [children, onFinish]);

    return (
        <MarkdownRenderer className={MARKDOWN_CONTAINER_CLASSES} anchorPrefix={anchorPrefix}>
            {children}
        </MarkdownRenderer>
    );
};
