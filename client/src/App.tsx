import "./index.css";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar, FloatingSidebarToggle } from "./components/app-sidebar";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toaster";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
// Route-level code splitting — each route is its own chunk.
const Chat = lazy(() => import("./routes/chat"));
const Strategies = lazy(() => import("./routes/strategies"));
const StrategyDetail = lazy(() => import("./routes/strategy-detail"));
import { Toaster as SonnerToaster } from "sonner";
import { ThemeToggle } from "./components/ThemeToggle";
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
        queryKey: ["agents"],
        queryFn: () => apiClient.getAgents(),
        staleTime: Number.POSITIVE_INFINITY,
    });
    const firstAgent = data?.agents?.[0];
    if (isPending) {
        return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
    }
    if (isError || !firstAgent) {
        return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No agents available.</div>;
    }
    return <Navigate to={`/chat/${firstAgent.id}`} replace />;
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
                    <SidebarProvider>
                        <AppSidebar />
                        <FloatingSidebarToggle />
                        <SidebarInset className="pl-[20px]">
                            <div className="flex flex-1 flex-col h-dvh w-full">
                                <div className="flex flex-1 flex-col min-h-0 w-full">
                                    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-muted-foreground" />}>
                                        <Routes>
                                            <Route path="/" element={<RootRedirect />} />
                                            <Route path="chat/:agentId/:roomId" element={<Chat />} />
                                            <Route path="chat/:agentId" element={<Chat />} />
                                            <Route path="strategies/:agentId" element={<Strategies />} />
                                            <Route path="strategies/:agentId/:strategyId" element={<StrategyDetail />} />
                                        </Routes>
                                    </Suspense>
                                    </div>
                                </div>
                        </SidebarInset>
                    </SidebarProvider>
                    <ThemeToggle />
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
