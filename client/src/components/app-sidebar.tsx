import { useQuery } from "@tanstack/react-query";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarFooter,
    SidebarGroupContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSkeleton,
    SidebarTrigger,
    useSidebar,
} from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api";
import { NavLink, useNavigate } from "react-router";
import type { UUID } from "@/types/core";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RoomSelector } from "./room-selector";

export function AppSidebar() {
    const navigate = useNavigate();
    const { isMobile, setOpenMobile } = useSidebar();
    const query = useQuery({
        queryKey: ["agents"],
        queryFn: () => apiClient.getAgents(),
        staleTime: Number.POSITIVE_INFINITY, // Never consider data stale
        refetchOnWindowFocus: false, // Don't refetch when user returns to tab
        refetchOnMount: false, // Don't refetch on component remount
        refetchOnReconnect: false, // Don't refetch on network reconnect
        // Only fetches once on initial page load. User must refresh page (F5) to see changes after server restart.
    });

    const agents = query?.data?.agents;
    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="pb-4">
                <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
                    <SidebarMenu className="flex-1 group-data-[collapsible=icon]:flex-none">
                        <SidebarMenuItem>
                            <SidebarMenuButton size="lg" asChild>
                                <NavLink
                                    to="/"
                                    className="flex items-center py-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:py-2"
                                    onClick={(e) => {
                                        if (isMobile) {
                                            e.preventDefault();
                                            navigate("/");
                                            setOpenMobile(false);
                                        }
                                    }}
                                >
                                    <div
                                        aria-label="Financial Agent"
                                        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground group-data-[collapsible=icon]:mr-0 mr-3 mt-1 group-data-[collapsible=icon]:mt-0"
                                    >
                                        FA
                                    </div>

                                    {/* Just the name. The build number is not
                                        identity — it moved to the footer. */}
                                    <span className="mt-1 text-[15px] font-semibold tracking-[-0.011em] group-data-[collapsible=icon]:hidden">
                                        Financial Agent
                                    </span>
                                </NavLink>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                    <SidebarTrigger
                        data-tour="sidebar-toggle"
                        className="mr-2 group-data-[collapsible=icon]:mr-0 group-data-[collapsible=icon]:hidden"
                    />
                </div>
                <div className="hidden group-data-[collapsible=icon]:flex justify-center pt-2">
                    <SidebarTrigger data-tour="sidebar-toggle" />
                </div>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    {/* No "AGENTS" label. It named a group of one, under a header
                        that already said the same words. */}
                    <SidebarGroupContent>
                        <SidebarMenu className="space-y-0.5 px-1">
                            {query?.isPending ? (
                                <div className="space-y-1">
                                    {Array.from({ length: 5 }).map(
                                        (_, index) => (
                                            <SidebarMenuItem key={`skeleton-item-${index}`}>
                                                <SidebarMenuSkeleton />
                                            </SidebarMenuItem>
                                        )
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {agents?.map(
                                        (agent: { id: UUID; name: string }, index: number) => (
                                            <SidebarMenuItem key={agent.id} className="list-none">
                                                <RoomSelector
                                                    agentId={agent.id}
                                                    agentName={agent.name}
                                                    isFirstAgent={index === 0}
                                                    showAgentHeader={(agents?.length ?? 0) > 1}
                                                />
                                            </SidebarMenuItem>
                                        )
                                    )}
                                </div>
                            )}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter className="group-data-[collapsible=icon]:hidden">
                <span className="fin-figure px-2 pb-1 text-[10px] text-label-4">v3.0.0</span>
            </SidebarFooter>
        </Sidebar>
    );
}

// Desktop-only floating fallback. The in-sidebar SidebarTrigger gets clipped
// by the inner card's m-4 margin when the sidebar is in icon-collapsed mode
// (3rem outer width − 2rem horizontal margin = 1rem usable, which is narrower
// than the 28px trigger button), leaving no way to reopen the sidebar. Mobile
// uses an off-canvas sheet whose trigger lives in each page header (md:hidden),
// so this only renders for desktop+collapsed.
export function FloatingSidebarToggle() {
    const { state, isMobile, toggleSidebar } = useSidebar();
    const { t } = useTranslation();

    if (isMobile || state !== "collapsed") return null;

    return (
        <button
            type="button"
            onClick={toggleSidebar}
            aria-label={t("common.toggleSidebar")}
            className="material fixed top-3 left-3 z-50 inline-flex h-9 w-9 items-center justify-center rounded-md border border-sep text-label-1 shadow-e2-rim transition-colors hover:bg-fill-1"
        >
            <PanelLeft className="h-4 w-4" />
            <span className="sr-only">{t("common.toggleSidebar")}</span>
        </button>
    );
}
