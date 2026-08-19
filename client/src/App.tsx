import "./index.css";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toaster";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
// Route-level code splitting — each route is its own chunk.
const Topic = lazy(() => import("./routes/topic"));
const Research = lazy(() => import("./routes/research"));
const Strategies = lazy(() => import("./routes/strategies"));
const StrategyDetail = lazy(() => import("./routes/strategy-detail"));
const DcfDemo = lazy(() => import("./routes/dcf-demo"));
import { Toaster as SonnerToaster } from "sonner";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { cn } from "./lib/utils";
import { LanguageProvider } from "./contexts/LanguageContext";
import { apiClient } from "./lib/api";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: Number.POSITIVE_INFINITY,
        },
    },
});

/** `/` is now an entry redirect, not a standalone home page. */
function RootRedirect() {
    const { data, isPending, isError } = useQuery({
        queryKey: ["tenants"],
        queryFn: () => apiClient.getTenants(),
        staleTime: Number.POSITIVE_INFINITY,
    });
    const firstTenant = data?.tenants?.[0];
    if (isPending) {
        return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
    }
    if (isError || !firstTenant) {
        return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No workspace available.</div>;
    }
    return <Navigate to={`/topic/${firstTenant.id}`} replace />;
}

function AppShell() {
    const { theme } = useTheme();

    return (
        <div
            className={cn(
                "antialiased transition-colors duration-300",
                "min-h-dvh w-full",
                "bg-background text-foreground",
                theme === "dark" && "dark"
            )}
            style={{ colorScheme: theme }}
        >
            <BrowserRouter>
                <TooltipProvider delayDuration={0}>
                    {/* No sidebar shell: TopicWorkspace owns its own columns. */}
                    <div className="flex h-dvh min-h-0 w-full flex-col">
                        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-muted-foreground" />}>
                            <Routes>
                                <Route path="/" element={<RootRedirect />} />
                                <Route path="topic/:tenantId/:topicId" element={<Topic />} />
                                <Route path="topic/:tenantId" element={<Topic />} />
                                {/* Spec §7.9 — the focused member is deliberately absent. */}
                                <Route path="research/:tenantId/:researchId" element={<Research />} />
                                <Route path="strategies/:tenantId" element={<Strategies />} />
                                <Route path="strategies/:tenantId/:strategyId" element={<StrategyDetail />} />
                                <Route path="dcf-demo" element={<DcfDemo />} />
                            </Routes>
                        </Suspense>
                    </div>
                    <Toaster />
                    <SonnerToaster />
                </TooltipProvider>
            </BrowserRouter>
        </div>
    );
}

function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <LanguageProvider>
                <ThemeProvider>
                    <AppShell />
                </ThemeProvider>
            </LanguageProvider>
        </QueryClientProvider>
    );
}

export default App;
