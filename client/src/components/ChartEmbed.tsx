import React, { useState, useEffect, useCallback } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTheme } from '@/contexts/ThemeContext';
import { useTranslation } from 'react-i18next';

interface ChartEmbedProps {
    chartUrl: string;
    chartPath: string;
    title?: string;
    className?: string;
    id?: string;
    showHeader?: boolean;
}

export const ChartEmbed: React.FC<ChartEmbedProps> = ({
    chartUrl,
    chartPath,
    title,
    className,
    id,
    showHeader = true
}) => {
    const [isLoading, setIsLoading] = useState(true);
    const [blockingError, setBlockingError] = useState<string | null>(null);
    const [iframeError, setIframeError] = useState<string | null>(null);
    const [iframeActualSrc, setIframeActualSrc] = useState<string>('');
    // LOADING_HEIGHT is the placeholder shown before the chart reports its
    // size (initial render, cross-origin iframes we cannot measure, error
    // recovery). HEIGHT_FLOOR is the minimum applied to a measured or
    // chart-reported height — small enough that legitimate short charts
    // hug their content (no white gap below the plot), large enough to
    // avoid total collapse if measurement glitches before the chart paints.
    const LOADING_HEIGHT = 280;
    const HEIGHT_FLOOR = 80;
    const [iframeHeight, setIframeHeight] = useState(LOADING_HEIGHT);
    const iframeRef = React.useRef<HTMLIFrameElement>(null);
    const resizeTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
    const { theme } = useTheme();
    const { t } = useTranslation();
    const isDarkMode = theme === 'dark';

    const iframeSrc = React.useMemo(() => {
        const params = new URLSearchParams();
        if (!showHeader) params.set('view', 'compact');
        params.set('theme', isDarkMode ? 'dark' : 'light');
        const sep = chartUrl.includes('?') ? '&' : '?';
        return `${chartUrl}${sep}${params.toString()}`;
    }, [chartUrl, showHeader, isDarkMode]);

    // Preflight: same cookies as the iframe navigation. Surfaces 401/404 JSON
    // (and non-HTML) as visible text instead of a blank white iframe.
    useEffect(() => {
        let cancelled = false;
        setBlockingError(null);
        setIframeError(null);
        setIframeActualSrc('');
        setIsLoading(true);

        if (!iframeSrc) {
            setIsLoading(false);
            return;
        }

        (async () => {
            try {
                const res = await fetch(iframeSrc, {
                    method: 'HEAD',
                    credentials: 'include',
                    redirect: 'follow',
                });
                if (cancelled) return;
                if (!res.ok) {
                    setBlockingError(t('charts.loadFailedHttp', { status: res.status }));
                    setIsLoading(false);
                    return;
                }
                const ct = (res.headers.get('content-type') || '').toLowerCase();
                if (ct && !ct.includes('text/html')) {
                    setBlockingError(t('charts.loadFailedNotHtml'));
                    setIsLoading(false);
                    return;
                }
                setIframeActualSrc(iframeSrc);
            } catch {
                if (cancelled) return;
                // CORS, offline, or HEAD unsupported — fall back to iframe load
                setIframeActualSrc(iframeSrc);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [iframeSrc, t]);

    const readChartContentHeight = useCallback((): number | null => {
        if (!iframeRef.current || typeof window === "undefined") return null;

        try {
            const iframeUrl = new URL(iframeRef.current.src, window.location.href);
            const isSameOrigin = iframeUrl.origin === window.location.origin;
            if (!isSameOrigin) return null;

            const iframeDocument = iframeRef.current.contentDocument || iframeRef.current.contentWindow?.document;
            if (!iframeDocument) return null;

            const chartContainer = iframeDocument.querySelector(
                '.chart-container, .plotly, canvas, #chart, main, .content'
            );
            if (!chartContainer) return null;

            const rect = chartContainer.getBoundingClientRect();
            const styles = window.getComputedStyle(chartContainer);
            const marginBottom = Number.parseFloat(styles.marginBottom) || 0;
            const measured = rect.height + marginBottom;
            return Number.isFinite(measured) && measured > 0 ? measured : null;
        } catch {
            return null;
        }
    }, []);

    const isCompactEmbed = !showHeader;

    const measureIframeHeight = useCallback(() => {
        if (!iframeRef.current) return;

        try {
            if (typeof window === "undefined") return;

            const iframeUrl = new URL(iframeRef.current.src, window.location.href);
            const isSameOrigin = iframeUrl.origin === window.location.origin;

            if (!isSameOrigin) {
                setIframeHeight(LOADING_HEIGHT);
                return;
            }

            const iframeDocument = iframeRef.current.contentDocument || iframeRef.current.contentWindow?.document;
            if (!iframeDocument) return;

            const measured = readChartContentHeight();
            const body = iframeDocument.body;
            const bodyFallback = body
                ? Math.max(body.scrollHeight, body.offsetHeight)
                : LOADING_HEIGHT;

            const contentHeight = isCompactEmbed && measured
                ? measured
                : bodyFallback;
            setIframeHeight(Math.max(contentHeight, HEIGHT_FLOOR));
        } catch (error) {
            console.warn('Unable to access iframe content for height adjustment:', error);
            setIframeHeight(LOADING_HEIGHT);
        }
    }, [readChartContentHeight, isCompactEmbed]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.data && event.data.type === 'chartHeight' && typeof event.data.height === 'number') {
                const reported = event.data.height;
                const measured = isCompactEmbed ? readChartContentHeight() : null;
                const refined = measured !== null
                    ? Math.min(reported, measured)
                    : reported;
                setIframeHeight(Math.max(refined, HEIGHT_FLOOR));
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [readChartContentHeight, isCompactEmbed]);

    useEffect(() => {
        const handleResize = () => {
            if (resizeTimeoutRef.current) {
                clearTimeout(resizeTimeoutRef.current);
            }
            resizeTimeoutRef.current = setTimeout(() => {
                measureIframeHeight();
            }, 300);
        };

        window.addEventListener('resize', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            if (resizeTimeoutRef.current) {
                clearTimeout(resizeTimeoutRef.current);
            }
        };
    }, [measureIframeHeight]);

    useEffect(() => {
        const target = iframeRef.current?.parentElement;
        if (!target || typeof ResizeObserver === "undefined") return;

        const observer = new ResizeObserver(() => {
            if (resizeTimeoutRef.current) {
                clearTimeout(resizeTimeoutRef.current);
            }
            resizeTimeoutRef.current = setTimeout(() => {
                measureIframeHeight();
            }, 200);
        });

        observer.observe(target);
        return () => observer.disconnect();
    }, [measureIframeHeight]);

    const handleIframeLoad = () => {
        setIsLoading(false);
        setIframeError(null);
        setTimeout(() => {
            measureIframeHeight();
        }, 500);
    };

    const handleIframeError = () => {
        setIsLoading(false);
        setIframeError(t('charts.loadFailedNetwork'));
    };

    const handleOpenInNewTab = () => {
        window.open(chartUrl, '_blank');
    };

    const chartName =
        title ||
        chartPath.split('/').pop()?.split('\\').pop()?.replace(/\.(html|png)$/, '') ||
        t("charts.defaultTitle");

    const displayError = blockingError ?? iframeError;
    if (displayError) {
        return (
            <div
                id={id}
                className={cn(
                    'relative w-full rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm',
                    className
                )}
            >
                <p className="text-destructive pr-10">{displayError}</p>
                <Button
                    onClick={handleOpenInNewTab}
                    variant="outline"
                    size="sm"
                    className="mt-3 h-8"
                >
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    {t("charts.openInNewTab")}
                </Button>
            </div>
        );
    }

    return (
        <div
            id={id}
            className={cn(
                'relative w-full',
                className
            )}
        >
            <div
                className="relative w-full"
            >
                {showHeader && (
                    <div
                        className="flex items-center justify-between px-4 py-3"
                    >
                        <h3 className={cn(
                            'text-sm font-medium truncate',
                            isDarkMode ? 'text-white/90' : 'text-slate-900'
                        )}>
                            {chartName}
                        </h3>
                        <Button
                            onClick={handleOpenInNewTab}
                            variant="ghost"
                            size="sm"
                            className={cn(
                                'h-8 px-2 gap-1.5',
                                isDarkMode
                                    ? 'text-white/70 hover:text-white hover:bg-white/10'
                                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                            )}
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span className="text-xs">{t("charts.open")}</span>
                        </Button>
                    </div>
                )}
                {!showHeader && (
                    <Button
                        onClick={handleOpenInNewTab}
                        variant="ghost"
                        size="icon"
                        aria-label={t("charts.openInNewTab")}
                        className={cn(
                            'absolute top-2 right-2 z-20 h-8 w-8 rounded opacity-60 hover:opacity-100',
                            isDarkMode
                                ? 'text-white/80 hover:text-white hover:bg-white/10'
                                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/50'
                        )}
                    >
                        <ExternalLink className="h-4 w-4" />
                    </Button>
                )}

                {isLoading && iframeActualSrc && (
                    <div className="chart-embed-loading-screen absolute inset-0 flex items-center justify-center z-10 bg-background/50 backdrop-blur-sm">
                        <div className="flex flex-col items-center gap-2">
                            <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                            <span className="text-sm text-muted-foreground">{t("charts.loadingChart")}</span>
                        </div>
                    </div>
                )}

                <div
                    className="relative w-full"
                    style={{
                        height: `${iframeHeight}px`
                    }}
                >
                    {iframeActualSrc ? (
                        <iframe
                            ref={iframeRef}
                            src={iframeActualSrc}
                            title={chartName}
                            className="w-full h-full border-0"
                            onLoad={handleIframeLoad}
                            onError={handleIframeError}
                            sandbox="allow-scripts allow-same-origin"
                        />
                    ) : (
                        <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
                            <Loader2 className="h-6 w-6 animate-spin text-purple-600 mr-2" />
                            {t("charts.loadingChart")}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
