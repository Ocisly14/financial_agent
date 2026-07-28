import "./index.css";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar, FloatingSidebarToggle } from "./components/app-sidebar";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toaster";
import { BrowserRouter, Route, Routes } from "react-router";
// Route-level code splitting — each route is its own chunk.
const Chat = lazy(() => import("./routes/chat"));
const Overview = lazy(() => import("./routes/overview"));
const LandingPage = lazy(() => import("./routes/landing"));
const Orders = lazy(() => import("./routes/orders"));
const Strategies = lazy(() => import("./routes/strategies"));
const StrategyFloor = lazy(() => import("./routes/strategy-floor"));
const StrategyDetail = lazy(() => import("./routes/strategy-detail"));
import { ThinkingBubbleProvider } from "./contexts/ThinkingBubbleContext";
import { AuthProvider } from "./contexts/AuthContext";
import { Toaster as SonnerToaster } from "sonner";
import { UserButton } from "./components/UserButton";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { cn } from "./lib/utils";
import { TableOfContentsProvider } from "./contexts/TableOfContentsContext";
import { LanguageProvider } from "./contexts/LanguageContext";
import { KillSwitchBanner } from "./components/cex/KillSwitchBanner";
import { LiveTradingConsentModal } from "./components/cex/LiveTradingConsentModal";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: Number.POSITIVE_INFINITY,
        },
    },
});

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
                        <TableOfContentsProvider>
                            <AppSidebar />
                            <FloatingSidebarToggle />
                            <SidebarInset className="pl-[20px]">
                                <div className="flex flex-1 flex-col h-dvh w-full">
                                    <div className="flex flex-1 flex-col min-h-0 w-full">
                                        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-muted-foreground" />}>
                                            <Routes>
                                                <Route path="/" element={<LandingPage />} />
                                                <Route path="chat/:agentId/:roomId" element={<Chat />} />
                                                <Route path="chat/:agentId" element={<Chat />} />
                                                <Route path="settings/:agentId" element={<Overview />} />
                                                <Route path="orders/:agentId" element={<Orders />} />
                                                <Route path="floor/:agentId" element={<StrategyFloor />} />
                                                <Route path="strategies/:agentId" element={<Strategies />} />
                                                <Route path="strategies/:agentId/:strategyId" element={<StrategyDetail />} />
                                            </Routes>
                                        </Suspense>
                                    </div>
                                </div>
                            </SidebarInset>
                        </TableOfContentsProvider>
                    </SidebarProvider>
                    <UserButton />
                    <KillSwitchBanner />
                    <LiveTradingConsentModal />
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
            <AuthProvider>
                <LanguageProvider>
                    <ThemeProvider>
                        <ThinkingBubbleProvider>
                            <AppShell />
                        </ThinkingBubbleProvider>
                    </ThemeProvider>
                </LanguageProvider>
            </AuthProvider>
        </QueryClientProvider>
    );
}

export default App;
