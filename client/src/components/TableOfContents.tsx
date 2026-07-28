import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import type { Content } from "@/types/core";
import { useTableOfContents } from "../contexts/TableOfContentsContext";
import { Button } from "./ui/button";
import { useTranslation } from "react-i18next";

type ExtraContentFields = {
  user: string;
  createdAt: number;
  isLoading?: boolean;
};

type ContentWithUser = Content & ExtraContentFields & {
  error?: {
    type: string;
    message: string;
    originalError?: string;
    stack?: string | null;
    [key: string]: unknown;
  };
};

type BeforeNavContent = React.ReactNode | ((variant: "desktop" | "mobile") => React.ReactNode);

interface TableOfContentsProps {
  messages: ContentWithUser[];
  className?: string;
  anchorPrefix?: string;
  taskNames?: string[]; // Task identifiers (name/title) to exclude from TOC (additional to auto-detected)
  beforeNavContent?: BeforeNavContent;
  title?: React.ReactNode;
}

interface TocItem {
  id: string;
  text: string;
  level: number;
  number: string;
}

const STICKY_HEADER_HEIGHT = 40;
const VISUAL_PADDING = 140;
const TOTAL_SCROLL_OFFSET = STICKY_HEADER_HEIGHT + VISUAL_PADDING;

/**
 * Generates a URL-safe anchor id from heading text
 */
const generateAnchorId = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5\-]/g, ''); // Allow Chinese characters
};

const stripLeadingNumbering = (text: string): string => {
  const numberingPattern = /^\s*(?:第\s*)?\d+(?:\.\d+)*(?:[.)、:：]\s*|\s*-\s*)/i;
  let result = text;

  while (numberingPattern.test(result)) {
    result = result.replace(numberingPattern, '').trimStart();
  }

  return result;
};

let generalEmojiRegex: RegExp | null = null;
try {
  generalEmojiRegex = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}]/gu;
} catch (_error) {
  generalEmojiRegex = null;
}

const removeEmojiCharacters = (text: string): string => {
  if (!text) {
    return '';
  }

  let result = text;
  if (generalEmojiRegex) {
    result = result.replace(generalEmojiRegex, '');
  }

  return result
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis (supplementary plane)
    .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Remove misc symbols (sun, umbrella, etc.)
    .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Remove dingbats
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Remove emoticons
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Remove transport and map symbols
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // Remove flags
    .replace(/[\u{2300}-\u{23FF}]/gu, '')   // Remove misc technical
    .replace(/[\u{2B50}]/gu, '')            // Remove star emoji
    .replace(/[\u{2705}\u{2611}\u{2714}\u{2716}\u{274C}\u{274E}]/gu, ''); // Remove checkmarks and crosses
};

/**
 * Removes markdown formatting and emojis from text
 */
const cleanMarkdownFormatting = (text: string): string => {
  const withoutNumbering = stripLeadingNumbering(text);
  const withoutEmojis = removeEmojiCharacters(withoutNumbering);

  const sanitized = withoutEmojis
    .replace(/\*\*/g, '') // Remove bold markers
    .replace(/\*/g, '')   // Remove italic markers
    .replace(/`/g, '')    // Remove code markers
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Remove links, keep text
    .replace(/:/g, '')    // Remove colons
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Remove variation selectors
    .replace(/\s+/g, ' ')                   // Normalize whitespace
    .trim();

  return stripLeadingNumbering(sanitized).trim();
};

const normalizeForComparison = (text: string): string => {
  return cleanMarkdownFormatting(text).toLowerCase().trim();
};

const createNormalizedVariants = (value: string): string[] => {
  const base = normalizeForComparison(value);
  if (!base) {
    return [];
  }

  const variants = new Set<string>();
  variants.add(base);

  const withoutTaskPrefix = base.replace(/^task\s*/i, '').trim();
  if (withoutTaskPrefix) {
    variants.add(withoutTaskPrefix);
  }

  return Array.from(variants);
};

/**
 * Adds numbering to headings (e.g., 1, 1.1, 1.2)
 * Adjusts numbering based on the highest level heading present
 */
const addNumbering = (headings: Omit<TocItem, "number">[]): TocItem[] => {
  if (headings.length === 0) return [];

  const minLevel = Math.min(...headings.map((h) => h.level));
  const counters: number[] = [];

  return headings.map((heading) => {
    const adjustedLevel = Math.max(0, heading.level - minLevel);

    while (counters.length <= adjustedLevel) {
      counters.push(0);
    }

    if (adjustedLevel > 0 && counters[0] === 0) {
      counters[0] = 1;
    }

    counters[adjustedLevel] += 1;

    for (let i = adjustedLevel + 1; i < counters.length; i++) {
      counters[i] = 0;
    }

    const number = counters.slice(0, adjustedLevel + 1).join(".");

    return {
      ...heading,
      number
    };
  });
};

/**
 * Extracts h1 and h2 headings from markdown text
 *
 * IMPORTANT: This regex requires STRICT markdown heading format:
 * - Headings MUST start with # or ## at the beginning of a line (^)
 * - MUST have at least one space (\s+) after the hash symbols
 * - Then followed by heading text (.+)
 * - Ends at the end of the line ($)
 *
 * Examples of VALID formats:
 * ✅ "# Heading"     - One space after #
 * ✅ "## Heading"    - One space after ##
 * ✅ "##  Heading"   - Multiple spaces work (\s+ matches 1 or more)
 *
 * Examples of INVALID formats that WON'T match:
 * ❌ "##Heading"     - No space after ## (won't match)
 * ❌ " ## Heading"   - Leading space before ## (won't match ^)
 *
 * Backend Integration:
 * All LLM-generated content is automatically sanitized via:
 * - packages/core/src/utils/markdownSanitizer.ts
 * - Integrated in regularMessageHandler.ts and comprehensiveAnalysisWorkflowGraph.ts
 * - Fixes malformed headings like "##Heading" → "## Heading"
 *
 * See CLAUDE.md "Markdown Content Generation Guidelines" for full documentation.
 *
 * @param markdown - The markdown text to extract headings from
 * @param anchorPrefix - Optional prefix for anchor IDs
 * @returns Array of heading items with id, text, level, and number
 */
const extractHeadings = (markdown: string, anchorPrefix = "", taskNames: string[] = []): TocItem[] => {
  // Regex breakdown:
  // ^ - Start of line (heading must be at line start)
  // (#{1,2}) - Capture 1-2 hash symbols (H1-H2 only)
  // \s+ - Match one or more whitespace characters (CRITICAL: ensures space after #)
  // (.+) - Capture the heading text
  // $ - End of line
  // gm flags - global and multiline matching
  const headingRegex = /^(#{1,2})\s+(.+)$/gm;
  const headings: Omit<TocItem, 'number'>[] = [];
  let match;

  // Normalize task names for comparison
  const normalizedTaskNames = new Set<string>();
  taskNames.forEach((name) => {
    createNormalizedVariants(name).forEach((variant) => {
      if (variant) {
        normalizedTaskNames.add(variant);
      }
    });
  });

  const normalizedTaskList = Array.from(normalizedTaskNames);

  const isTaskHeading = (normalizedHeading: string): boolean => {
    if (!normalizedHeading) return false;

    for (const variant of normalizedTaskList) {
      if (!variant) continue;

      if (normalizedHeading === variant) {
        return true;
      }

      if (normalizedHeading.length >= variant.length) {
        const startsWithVariant = normalizedHeading.startsWith(variant);
        const endsWithVariant = normalizedHeading.endsWith(variant);

        if (endsWithVariant) {
          const prefix = normalizedHeading.slice(0, normalizedHeading.length - variant.length).trim();
          if (!prefix) {
            return true;
          }
        }

        if (startsWithVariant) {
          const suffix = normalizedHeading.slice(variant.length).trim();
          if (!suffix) {
            return true;
          }

          const allowedSuffixes = [
            "result",
            "results",
            "result summary",
            "results summary",
            "summary",
            "report",
            "analysis",
            "overview",
            "output",
            "outputs",
            "details"
          ];

          const normalizedSuffix = suffix.replace(/[^a-z\s]/gi, '').trim();

          if (
            normalizedSuffix &&
            allowedSuffixes.some((allowed) =>
              normalizedSuffix === allowed || normalizedSuffix.startsWith(`${allowed} `)
            )
          ) {
            return true;
          }
        }
      }
    }

    return false;
  };

  while ((match = headingRegex.exec(markdown)) !== null) {
    const level = match[1].length;
    const rawText = match[2].trim();
    const text = cleanMarkdownFormatting(rawText);

    // Skip if this heading matches a task name/title variant
    const normalizedHeading = normalizeForComparison(rawText);

    if (isTaskHeading(normalizedHeading)) {
      continue;
    }

    const id = `${anchorPrefix}${generateAnchorId(text)}`;
    headings.push({ id, text, level });
  }

  return addNumbering(headings);
};

/**
 * TableOfContents component for taskchain messages
 * Automatically generates a table of contents from markdown headings
 */
export const TableOfContents: React.FC<TableOfContentsProps> = ({
  messages,
  className,
  anchorPrefix = "",
  taskNames = [],
  beforeNavContent,
  title
}) => {
  const { t } = useTranslation();
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const tocId = useId();
  const {
    registerToc,
    setTocAvailability,
    setActiveToc,
    closeMobile: closeMobileTableOfContents,
    activeId: activeMobileTocId,
    isMobileOpen: isMobileTableOfContentsOpen
  } = useTableOfContents();
  const [isMounted, setIsMounted] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const resolvedTitle = title ?? t("progress.toc");

  const getBeforeNavContent = (variant: "desktop" | "mobile"): React.ReactNode => {
    if (!beforeNavContent) {
      return null;
    }
    if (typeof beforeNavContent === "function") {
      return (beforeNavContent as (variant: "desktop" | "mobile") => React.ReactNode)(variant);
    }
    if (React.isValidElement(beforeNavContent)) {
      return React.cloneElement(beforeNavContent, { key: `toc-before-${variant}` });
    }
    return beforeNavContent;
  };

  useEffect(() => {
    return registerToc(tocId);
  }, [registerToc, tocId]);

  useEffect(() => {
    setIsMounted(true);
    return () => {
      setIsMounted(false);
    };
  }, []);
  const derivedTaskNames = useMemo(() => {
    const names = new Set<string>();

    taskNames.forEach((name) => {
      if (typeof name === 'string' && name.trim().length > 0) {
        names.add(name);
      }
    });

    messages.forEach((msg) => {
      // Use standard format: content.metadata
      const metadata = (msg as any)?.content?.metadata || {};
      const taskChainSnapshot = metadata.taskChainSnapshot;
      const taskChainMetadata = metadata.taskChain;
      const tasksSources: any[] = [];

      if (taskChainSnapshot?.taskChainData?.tasks) {
        tasksSources.push(taskChainSnapshot.taskChainData.tasks);
      }
      if (Array.isArray(taskChainMetadata?.tasks)) {
        tasksSources.push(taskChainMetadata.tasks);
      }
      if (Array.isArray((msg as any)?.taskChain?.tasks)) {
        tasksSources.push((msg as any).taskChain.tasks);
      }

      tasksSources.forEach((tasks) => {
        tasks.forEach((task: any) => {
          const candidates = [task?.name, task?.title, task?.displayName];
          candidates.forEach((candidate) => {
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
              names.add(candidate);
            }
          });
        });
      });
    });

    return Array.from(names);
  }, [messages, taskNames]);

  const tocItems = useMemo(() => {
    // Extract headings from each message with its own anchor prefix
    const allHeadings: Omit<TocItem, 'number'>[] = [];

    messages.forEach((msg, index) => {
      // Get message text
      let text = '';
      if (typeof msg.text === 'string') {
        text = msg.text;
      } else if (msg.content && typeof msg.content === 'object' && 'text' in msg.content) {
        text = (msg.content as any).text || '';
      }

      if (!text) return;

      // Generate anchor prefix for this message (same logic as in chat.tsx)
      // Use the anchorPrefix prop as a base if provided, otherwise generate one
      const anchorPrefixBase = anchorPrefix || `msg-${msg.createdAt ?? "pending"}-${index}`;
      const sanitizedAnchorPrefixBase = anchorPrefixBase.replace(/[^a-zA-Z0-9_-]/g, "");
      const messageAnchorPrefix = sanitizedAnchorPrefixBase ? `${sanitizedAnchorPrefixBase}-` : "";

      // Extract headings from this message
      const headings = extractHeadings(text, messageAnchorPrefix, derivedTaskNames);
      allHeadings.push(...headings.map(h => ({ id: h.id, text: h.text, level: h.level })));
    });

    return addNumbering(allHeadings);
  }, [messages, derivedTaskNames, anchorPrefix]);

  const hasTocItems = tocItems.length > 0;
  const hasBeforeNavSection = beforeNavContent !== undefined && beforeNavContent !== null;
  const hasContent = hasTocItems || hasBeforeNavSection;
  const isMobileOverlayVisible = isMobileTableOfContentsOpen && activeMobileTocId === tocId;

  useEffect(() => {
    setTocAvailability(tocId, hasContent);
  }, [hasContent, setTocAvailability, tocId]);

  useEffect(() => {
    if (!isMobileOverlayVisible) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMobileTableOfContents();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileOverlayVisible, closeMobileTableOfContents]);

  useEffect(() => {
    if (!hasContent || typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
      return;
    }

    const element = sentinelRef.current;
    if (!element) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.35) {
            setActiveToc(tocId);
          }
        });
      },
      {
        threshold: [0.35],
        rootMargin: "0px 0px -35% 0px"
      }
    );

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [hasContent, setActiveToc, tocId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (tocItems.length === 0) {
      setActiveHeadingId(null);
      return;
    }

    let cleanup: (() => void) | undefined;
    const rafId = window.requestAnimationFrame(() => {
      const headingElements = tocItems
        .map(item => document.getElementById(item.id))
        .filter((element): element is HTMLElement => element instanceof HTMLElement);

      if (headingElements.length === 0) {
        return;
      }

      const scrollContainer = headingElements[0].closest<HTMLElement>('.overflow-y-auto');

      const getRelativeTop = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        if (!scrollContainer) {
          return window.scrollY + rect.top;
        }
        const containerRect = scrollContainer.getBoundingClientRect();
        return scrollContainer.scrollTop + rect.top - containerRect.top;
      };

      const updateActiveHeading = () => {
        if (headingElements.length === 0) {
          return;
        }

        const currentScroll = (scrollContainer ? scrollContainer.scrollTop : window.scrollY) + TOTAL_SCROLL_OFFSET;
        let newActiveId = headingElements[0].id;

        for (const heading of headingElements) {
          const headingTop = getRelativeTop(heading);
          if (headingTop <= currentScroll + 1) {
            newActiveId = heading.id;
          } else {
            break;
          }
        }

        setActiveHeadingId(prev => (prev === newActiveId ? prev : newActiveId));
      };

      const handleScroll = () => {
        updateActiveHeading();
      };

      const handleResize = () => {
        updateActiveHeading();
      };

      if (scrollContainer) {
        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
      } else {
        window.addEventListener('scroll', handleScroll, { passive: true });
      }
      window.addEventListener('resize', handleResize);

      updateActiveHeading();

      cleanup = () => {
        if (scrollContainer) {
          scrollContainer.removeEventListener('scroll', handleScroll);
        } else {
          window.removeEventListener('scroll', handleScroll);
        }
        window.removeEventListener('resize', handleResize);
      };
    });

    return () => {
      if (cleanup) {
        cleanup();
      }
      window.cancelAnimationFrame(rafId);
    };
  }, [tocItems]);

  useEffect(() => {
    if (tocItems.length > 0) {
      setActiveHeadingId(prev => prev ?? tocItems[0].id);
    } else {
      setActiveHeadingId(null);
    }
  }, [tocItems]);

  const handleClick = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      // Find the scroll container
      const scrollContainer = element.closest<HTMLElement>('.overflow-y-auto');
      if (scrollContainer) {
        // Get element's position relative to scroll container
        const elementRect = element.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const relativeTop = elementRect.top - containerRect.top;

        // Scroll to position with offset (additional 30px padding below the heading)
        const targetScrollTop = scrollContainer.scrollTop + relativeTop - TOTAL_SCROLL_OFFSET + 30;

        scrollContainer.scrollTo({
          top: targetScrollTop,
          behavior: 'smooth'
        });
      } else {
        const elementRect = element.getBoundingClientRect();
        const absoluteTop = elementRect.top + window.scrollY;

        window.scrollTo({
          top: absoluteTop - TOTAL_SCROLL_OFFSET + 30,
          behavior: 'smooth'
        });
      }
      setActiveHeadingId(id);
      setActiveToc(tocId);
      if (isMobileOverlayVisible) {
        closeMobileTableOfContents();
      }
    } else {
      console.warn(`[TOC] Element with id "${id}" not found in the document`);
    }
  };

  const renderTocButtons = () =>
    tocItems.map((item, index) => (
      <button
        key={`${item.id}-${index}`}
        onClick={() => handleClick(item.id)}
        className={cn(
          "relative w-full text-left text-xs transition-colors duration-200 rounded-lg px-2.5 py-2 border",
          "line-clamp-2 leading-relaxed backdrop-blur-sm",
          item.level === 1 && "pl-2",
          item.level === 2 && "pl-6",
          activeHeadingId === item.id
            ? "backdrop-blur-md bg-emerald-50 dark:bg-white/20 border-emerald-200 dark:border-white/30 text-emerald-600 dark:text-emerald-500/90 font-semibold shadow"
            : "border-transparent text-slate-700 dark:text-foreground/70 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:border-slate-200 dark:hover:border-white/25"
        )}
        type="button"
      >
        <span
          className={cn(
            "text-slate-600 dark:text-foreground/60 mr-2",
            activeHeadingId === item.id && "text-emerald-600 dark:text-emerald-500"
          )}
        >
          {item.number}
        </span>
        {item.text}
      </button>
    ));

  if (!hasContent) {
    return null;
  }

  const desktopBeforeNav = getBeforeNavContent("desktop");
  const mobileBeforeNav = isMobileOverlayVisible ? getBeforeNavContent("mobile") : null;

  const mobileOverlay = isMounted && isMobileOverlayVisible
    ? createPortal(
      <div className="fixed inset-0 z-50 flex md:hidden">
        <div
          className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          onClick={closeMobileTableOfContents}
        />
        <div
          className="relative ml-auto flex h-full w-[min(20rem,90vw)] flex-col border-l border-slate-200/80 bg-background shadow-2xl dark:border-white/10"
          role="dialog"
          aria-modal="true"
          aria-label={t("progress.toc")}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200/80 dark:border-white/10">
            <h3 className="text-sm font-semibold text-foreground">
              {resolvedTitle}
            </h3>
            <Button
              variant="ghost"
              size="icon"
              onClick={closeMobileTableOfContents}
              aria-label={t("progress.closeToc")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3 space-y-4 custom-scrollbar">
            {mobileBeforeNav && (
              <div
                className={cn(
                  "space-y-3",
                  hasTocItems && "pb-4 border-b border-slate-200/80 dark:border-white/10"
                )}
              >
                {mobileBeforeNav}
              </div>
            )}
            {hasTocItems && (
              <nav className="space-y-1.5">
                {renderTocButtons()}
              </nav>
            )}
          </div>
        </div>
      </div>,
      document.body
    )
    : null;

  return (
    <>
      <div
        ref={sentinelRef}
        className="pointer-events-none block h-px w-full opacity-0 -mt-px"
        aria-hidden="true"
      />
      {mobileOverlay}
      <div
        className={cn(
          "hidden md:flex md:flex-col rounded-xl border border-slate-200/60 dark:border-white/15",
          "bg-white/30 dark:bg-slate-900/20 backdrop-blur-xl",
          "shadow-md dark:shadow-[0_12px_30px_rgba(15,23,42,0.45)]",
          "supports-[backdrop-filter]:bg-white/20 supports-[backdrop-filter]:dark:bg-slate-900/25",
          className
        )}
      >
        <div className="p-3 flex-shrink-0">
          <h3 className="text-sm font-medium text-foreground/80 mb-2">
            {resolvedTitle}
          </h3>
        </div>
        {desktopBeforeNav && (
          <div
            className={cn(
              "px-3 pb-3",
              hasTocItems && "border-b border-slate-200/60 dark:border-white/10"
            )}
          >
            {desktopBeforeNav}
          </div>
        )}
        {hasBeforeNavSection && hasTocItems && (
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("progress.documentOutline")}
          </div>
        )}
        {hasTocItems && (
          <nav className="space-y-1.5 px-3 pb-3 overflow-y-auto max-h-[300px] lg:max-h-[calc(100vh-6rem)] custom-scrollbar">
            {renderTocButtons()}
          </nav>
        )}
      </div>
    </>
  );
};
