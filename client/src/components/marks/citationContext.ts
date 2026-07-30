import { createContext } from "react";
import type { AnswerSourceLink } from "@/lib/semanticMarks";

/** Retrieved source metadata the backend attaches to an assistant message. */
export interface MessageSource {
    url: string;
    title: string;
    snippet?: string;
    publishedDate?: string;
}

/**
 * Sources for the message being rendered.
 *
 * `links` come from the answer's own numbered Sources list (parsed by
 * MarkdownRenderer), which is what a [[cite:…|n]] mark points at. `retrieved`
 * are the search hits the backend carried along; they are matched by URL to add
 * the snippet and publication date a link alone cannot provide.
 */
export const AnswerSourcesContext = createContext<{
    links: Map<number, AnswerSourceLink>;
    retrieved: MessageSource[];
}>({ links: new Map(), retrieved: [] });
