import { useState, useEffect, Fragment, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useParams, useNavigate, useLocation } from "react-router-dom";
import {
    Plus,
    MessageSquare,
    MoreVertical,
    MoreHorizontal,
    Trash2,
    ChevronRight,
    ChevronDown,
    Edit,
    CheckSquare,
    TrendingUp,
    X
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogFooter,
    DialogDescription,
} from "./ui/dialog";
import { Checkbox } from "./ui/checkbox";
import { apiClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { markdownPreviewText } from "@/lib/semanticMarks";
import { useSidebar } from "./ui/sidebar";
import { useTranslation } from "react-i18next";

interface Room {
    id: string;
    name: string;
    createdAt: number;
    lastMessage: { text: string; createdAt: number } | null;
    messageCount: number;
}

interface RoomSelectorProps {
    agentId: string;
    agentName: string;
    isFirstAgent?: boolean;
    /** Only true when the user actually has more than one agent to pick between. */
    showAgentHeader?: boolean;
}

export function RoomSelector({ agentId, agentName, isFirstAgent = false, showAgentHeader = false }: RoomSelectorProps) {
    const { agentId: currentAgentId, roomId: currentRoomId } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const { isMobile, setOpenMobile } = useSidebar();
    const { t, i18n } = useTranslation();

    // Check if agent header should be active (only when on exact agent page, not when on a room)
    const isAgentHeaderActive = location.pathname === `/chat/${agentId}` && !currentRoomId;

    // Expand if this agent is active (either agent-only view or has a room selected) or if it's the first agent
    const shouldBeExpanded = currentAgentId === agentId || isFirstAgent;
    const [isExpanded, setIsExpanded] = useState(shouldBeExpanded);
    const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
    const [newRoomName, setNewRoomName] = useState("");
    const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
    const [roomToRename, setRoomToRename] = useState<{ id: string; name: string } | null>(null);
    const [renameRoomName, setRenameRoomName] = useState("");

    // Multi-select delete state
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedRoomIds, setSelectedRoomIds] = useState<Set<string>>(new Set());
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const relativeTimeFormatter = useMemo(
        () => new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" }),
        [i18n.language]
    );

    // Update expansion state when the current agent changes
    useEffect(() => {
        setIsExpanded(shouldBeExpanded);
    }, [shouldBeExpanded]);

    useEffect(() => {
        queryClient.removeQueries({ queryKey: ["messages"] });
        queryClient.invalidateQueries({ queryKey: ["rooms", agentId] });
    }, [agentId, queryClient]);

    // Fetch rooms for this agent
    const { data: roomsData, isLoading } = useQuery({
        queryKey: ["rooms", agentId],
        queryFn: () => apiClient.getRooms(agentId),
        enabled: isExpanded,
        refetchInterval: 30000, // Refetch every 30 seconds
    });

    // Sort rooms by timestamp in descending order (newest first)
    // Use lastMessage.createdAt if available, otherwise use room.createdAt
    // Clone to avoid mutating the React Query cache when sorting
    const rooms = [...(roomsData?.rooms || [])].sort((a: Room, b: Room) => {
        const aTime = a.lastMessage?.createdAt || a.createdAt;
        const bTime = b.lastMessage?.createdAt || b.createdAt;
        return bTime - aTime; // Descending order (newest first)
    });

    // Group sorted rooms by recency bucket (Today / Yesterday / Previous 7
    // days / Previous 30 days / Older). Each room's bucket is computed off
    // its most recent activity (last message if any, otherwise createdAt).
    // The buckets preserve the descending sort within each group because we
    // walk the already-sorted array in order.
    type RoomGroupKey = "today" | "yesterday" | "previous7" | "previous30" | "older";
    const roomGroups = useMemo(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startOfYesterday = startOfToday - 86_400_000;
        const startOfPrevious7 = startOfToday - 7 * 86_400_000;
        const startOfPrevious30 = startOfToday - 30 * 86_400_000;
        // defaultValue keeps the UI sensible when translation keys haven't
        // been added yet — i18next falls back to the literal string here
        // instead of returning the bare key.
        const groups: Array<{ key: RoomGroupKey; label: string; rooms: Room[] }> = [
            { key: "today", label: t("rooms.groupToday", { defaultValue: "Today" }), rooms: [] },
            { key: "yesterday", label: t("rooms.groupYesterday", { defaultValue: "Yesterday" }), rooms: [] },
            { key: "previous7", label: t("rooms.groupPrevious7", { defaultValue: "Previous 7 days" }), rooms: [] },
            { key: "previous30", label: t("rooms.groupPrevious30", { defaultValue: "Previous 30 days" }), rooms: [] },
            { key: "older", label: t("rooms.groupOlder", { defaultValue: "Older" }), rooms: [] },
        ];
        for (const room of rooms) {
            const ts = room.lastMessage?.createdAt || room.createdAt;
            let bucket: RoomGroupKey;
            if (ts >= startOfToday) bucket = "today";
            else if (ts >= startOfYesterday) bucket = "yesterday";
            else if (ts >= startOfPrevious7) bucket = "previous7";
            else if (ts >= startOfPrevious30) bucket = "previous30";
            else bucket = "older";
            (groups.find((g) => g.key === bucket)!).rooms.push(room);
        }
        return groups.filter((g) => g.rooms.length > 0);
    }, [rooms, t]);

    const handleCreateRoom = async () => {
        try {
            const result = await apiClient.createRoom(agentId, newRoomName || undefined);
            
            if (result.success) {
                // Navigate to the new room
                navigate(`/chat/${agentId}/${result.room.id}`);
                
                // Invalidate and refetch rooms
                queryClient.invalidateQueries({ queryKey: ["rooms", agentId] });
                
                toast({
                    title: t("rooms.createdTitle"),
                    description: t("rooms.createdDescription", { name: result.room.name }),
                });
                
                setIsCreateDialogOpen(false);
                setNewRoomName("");
            } else {
                console.error("Room creation failed:", result);
                toast({
                    variant: "destructive",
                    title: t("rooms.createFailedTitle"),
                    description: t("rooms.createFailedDescription"),
                });
            }
        } catch (error) {
            console.error("Room creation error:", error);
            toast({
                variant: "destructive",
                title: t("rooms.createFailedTitle"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
            setIsCreateDialogOpen(false);
        }
    };

    const handleDeleteRoom = async (roomId: string, roomName: string) => {
        try {
            const result = await apiClient.deleteRoom(agentId, roomId);
            if (result.success) {
                // Clear all cached data for the deleted room
                queryClient.removeQueries({ queryKey: ["messages", agentId, roomId] });

                // If we're currently in the deleted room, navigate to agent page
                if (currentRoomId === roomId) {
                    navigate(`/chat/${agentId}`);
                }

                // Invalidate and refetch rooms
                queryClient.invalidateQueries({ queryKey: ["rooms", agentId] });

                toast({
                    title: t("rooms.deletedTitle"),
                    description: t("rooms.deletedDescription", { name: roomName }),
                });
            }
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("rooms.deleteFailedTitle"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        }
    };

    const handleBatchDeleteRooms = async () => {
        const roomIdsToDelete = Array.from(selectedRoomIds);

        try {
            const result = await apiClient.batchDeleteRooms(agentId, roomIdsToDelete);

            // Clear cache for all deleted rooms
            for (const roomId of roomIdsToDelete) {
                queryClient.removeQueries({ queryKey: ["messages", agentId, roomId] });
            }

            // If we're currently in one of the deleted rooms, navigate to agent page
            if (currentRoomId && selectedRoomIds.has(currentRoomId)) {
                navigate(`/chat/${agentId}`);
            }

            // Invalidate and refetch rooms
            queryClient.invalidateQueries({ queryKey: ["rooms", agentId] });

            // Handle partial failures
            const failedRooms = result.results.filter(r => !r.success);

            if (failedRooms.length === 0) {
                // All succeeded
                toast({
                    title: t("rooms.deletedManyTitle"),
                    description: t("rooms.deletedManyDescription", { count: result.results.length }),
                });
            } else if (failedRooms.length === roomIdsToDelete.length) {
                // All failed
                toast({
                    variant: "destructive",
                    title: t("rooms.deleteManyFailedTitle"),
                    description: t("rooms.deleteManyFailedDescription"),
                });
            } else {
                // Partial success
                const successCount = result.results.length - failedRooms.length;
                toast({
                    variant: "destructive",
                    title: t("rooms.partialDeletionTitle"),
                    description: t("rooms.partialDeletionDescription", {
                        successCount,
                        totalCount: result.results.length,
                        failedCount: failedRooms.length,
                    }),
                });

            }

            // Always clear selection and exit selection mode after batch deletion attempt
            setSelectedRoomIds(new Set());
            setIsSelectionMode(false);

            // Close dialog
            setIsDeleteDialogOpen(false);

        } catch (error) {
            toast({
                variant: "destructive",
                title: t("rooms.deleteManyFailedTitle"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
            setIsDeleteDialogOpen(false);
        }
    };

    const handleOpenRenameDialog = (roomId: string, roomName: string) => {
        setRoomToRename({ id: roomId, name: roomName });
        setRenameRoomName(roomName);
        setIsRenameDialogOpen(true);
    };

    const handleRenameRoom = async () => {
        if (!roomToRename) return;

        if (!renameRoomName.trim()) {
            toast({
                variant: "destructive",
                title: t("rooms.invalidNameTitle"),
                description: t("rooms.invalidNameDescription"),
            });
            return;
        }

        try {
            const result = await apiClient.renameRoom(agentId, roomToRename.id, renameRoomName.trim());
            if (result.success) {
                // Invalidate and refetch rooms to show new name
                queryClient.invalidateQueries({ queryKey: ["rooms", agentId] });

                toast({
                    title: t("rooms.renamedTitle"),
                    description: t("rooms.renamedDescription", {
                        oldName: roomToRename.name,
                        newName: renameRoomName.trim(),
                    }),
                });

                setIsRenameDialogOpen(false);
                setRoomToRename(null);
                setRenameRoomName("");
            }
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("rooms.renameFailedTitle"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        }
    };

    const formatTimestamp = (timestamp: number) => {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        
        if (diff < 60000) return t("rooms.justNow");
        if (diff < 3600000) return relativeTimeFormatter.format(-Math.floor(diff / 60000), "minute");
        if (diff < 86400000) return relativeTimeFormatter.format(-Math.floor(diff / 3600000), "hour");
        return date.toLocaleDateString(i18n.language);
    };

    return (
        <Fragment>
        <div className="group/rooms space-y-1">
            {/*
             * The agent row only exists when there is more than one agent to
             * choose between. With a single agent it repeated the product name
             * a third time (header, group label, row), spent a chevron on a
             * group that was always open, and pushed the first conversation
             * below 200px — chrome that had nothing to say.
             */}
            {showAgentHeader && (
                <div className="flex items-center">
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="rounded-md p-2 transition-colors hover:bg-fill-1 group-data-[collapsible=icon]:hidden"
                        aria-expanded={isExpanded}
                    >
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <NavLink
                        to={`/chat/${agentId}`}
                        onClick={() => {
                            if (isMobile) setOpenMobile(false);
                        }}
                        className={cn(
                            "flex flex-grow items-center gap-2 rounded-md p-2 text-left transition-colors group-data-[collapsible=icon]:hidden",
                            isAgentHeaderActive ? "bg-brand-sub text-label-1" : "hover:bg-fill-1",
                        )}
                    >
                        <MessageSquare className="h-4 w-4" />
                        <span className="flex-grow text-sm font-medium">{agentName}</span>
                    </NavLink>
                </div>
            )}

            {/* Primary actions. Both carry a word: "new chat" is the most-used
                control in the app and was a 32px unlabelled glyph, and nobody
                guesses that a trending-up arrow means the strategy monitor. */}
            <div className="space-y-0.5 group-data-[collapsible=icon]:hidden">
                <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
                    <DialogTrigger asChild>
                        <button
                            type="button"
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm font-medium text-label-1 transition-colors hover:bg-fill-1"
                        >
                            <Plus className="size-4 shrink-0 text-label-2" />
                            {t("rooms.newChat")}
                        </button>
                    </DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("rooms.createDialogTitle")}</DialogTitle>
                            <DialogDescription>
                                {t("rooms.createDialogDescription")}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                            <Input
                                placeholder={t("rooms.roomNameOptional")}
                                value={newRoomName}
                                onChange={(e) => setNewRoomName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (
                                        e.key === "Enter" &&
                                        !e.shiftKey &&
                                        !e.nativeEvent.isComposing
                                    ) {
                                        e.preventDefault();
                                        handleCreateRoom();
                                    }
                                }}
                            />
                        </div>
                        <DialogFooter>
                            <Button 
                                variant="outline" 
                                onClick={() => setIsCreateDialogOpen(false)}
                            >
                                {t("common.cancel")}
                            </Button>
                            <Button onClick={handleCreateRoom}>
                                {t("chat.createRoom")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <NavLink
                    to={`/strategies/${agentId}`}
                    onClick={() => {
                        if (isMobile) setOpenMobile(false);
                    }}
                    className={({ isActive }) =>
                        cn(
                            "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm font-medium transition-colors",
                            isActive ? "bg-brand-sub text-label-1" : "text-label-1 hover:bg-fill-1",
                        )
                    }
                >
                    <TrendingUp className="size-4 shrink-0 text-label-2" />
                    {t("strategies.title")}
                </NavLink>
            </div>

            {/* Room list. No left indent any more — with the agent row gone the
                conversations are the sidebar's top-level content, not children
                of anything. */}
            {isExpanded && (
                <div className="space-y-1 group-data-[collapsible=icon]:hidden">
                    {isLoading ? (
                        <div className="p-2 text-xs text-label-3">{t("rooms.loading")}</div>
                    ) : rooms.length === 0 ? (
                        <div className="p-2 text-xs text-label-3">{t("rooms.empty")}</div>
                    ) : (
                        roomGroups.flatMap((group, groupIndex) => [
                            <div
                                key={`group-${group.key}`}
                                // Tinted with the sidebar's own background, not
                                // the generic material — .material is white/72%
                                // and floated a bright band over the list.
                                className="sticky top-0 z-10 flex items-center gap-2 bg-card pb-1.5 pl-2 pr-1 pt-3"
                            >
                                <span className="fin-label flex-1 text-label-3">{group.label}</span>
                                {/* Bulk selection is a rare, destructive-adjacent
                                    mode — it belongs behind an overflow on the
                                    list, not beside "new chat". */}
                                {groupIndex === 0 && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button
                                                type="button"
                                                aria-label={t("rooms.selectMultiple")}
                                                className="rounded-sm p-1 text-label-3 opacity-0 transition-opacity hover:bg-fill-1 hover:text-label-1 focus-visible:opacity-100 group-hover/rooms:opacity-100 data-[state=open]:opacity-100"
                                            >
                                                <MoreHorizontal className="size-3.5" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                onClick={() => {
                                                    setIsSelectionMode(!isSelectionMode);
                                                    if (isSelectionMode) setSelectedRoomIds(new Set());
                                                }}
                                            >
                                                {isSelectionMode ? (
                                                    <X className="mr-2 h-4 w-4" />
                                                ) : (
                                                    <CheckSquare className="mr-2 h-4 w-4" />
                                                )}
                                                {isSelectionMode ? t("rooms.exitSelection") : t("rooms.selectMultiple")}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </div>,
                            ...group.rooms.map((room: Room) => {
                            const isSelected = selectedRoomIds.has(room.id);

                            return (
                                <div key={room.id} className="flex items-center group">
                                    {/* Checkbox for selection mode */}
                                    {isSelectionMode && (
                                        <div className="pl-2 pr-1">
                                            <Checkbox
                                                checked={isSelected}
                                                onCheckedChange={(checked: boolean) => {
                                                    const newSelected = new Set(selectedRoomIds);
                                                    if (checked) {
                                                        newSelected.add(room.id);
                                                    } else {
                                                        newSelected.delete(room.id);
                                                    }
                                                    setSelectedRoomIds(newSelected);
                                                }}
                                            />
                                        </div>
                                    )}

                                    {isSelectionMode ? (
                                        // In selection mode, show a clickable div instead of NavLink
                                        <div
                                            onClick={() => {
                                                const newSelected = new Set(selectedRoomIds);
                                                if (isSelected) {
                                                    newSelected.delete(room.id);
                                                } else {
                                                    newSelected.add(room.id);
                                                }
                                                setSelectedRoomIds(newSelected);
                                            }}
                                            className={cn(
                                                "flex-grow flex flex-col p-2 rounded-md text-left transition-all min-w-0 border cursor-pointer min-h-[44px]",
                                                isSelected
                                                    ? "border-transparent bg-brand-sub"
                                                    : "border-transparent [@media(hover:hover)]:hover:bg-fill-1 active:bg-fill-2"
                                            )}
                                        >
                                            <span className="text-sm font-medium truncate">
                                                {room.name}
                                            </span>
                                            {room.lastMessage && (
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className="text-xs text-muted-foreground truncate flex-grow">
                                                        {markdownPreviewText(room.lastMessage.text).substring(0, 50)}
                                                        {markdownPreviewText(room.lastMessage.text).length > 50 ? "…" : ""}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground shrink-0">
                                                        {formatTimestamp(room.lastMessage.createdAt)}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        // Normal mode, show NavLink. On mobile we drive navigation
                                        // explicitly so a single tap reliably navigates while the
                                        // Sheet sidebar is closing — letting NavLink handle the
                                        // navigation on its own can race with the Sheet's
                                        // unmount/animation and require a second tap.
                                        <NavLink
                                            to={`/chat/${agentId}/${room.id}`}
                                            onClick={(e) => {
                                                if (isMobile) {
                                                    e.preventDefault();
                                                    navigate(`/chat/${agentId}/${room.id}`);
                                                    setOpenMobile(false);
                                                }
                                            }}
                                            className={cn(
                                                // Selection is marked by a rule in the
                                                // gutter, not by lifting the row off the
                                                // page — the drop shadow was the single
                                                // most "consumer app" detail in here.
                                                "flex-grow flex flex-col p-2 pl-2.5 rounded-md text-left transition-colors min-w-0 border border-l-2 min-h-[44px]",
                                                location.pathname === `/chat/${agentId}/${room.id}`
                                                    ? "border-transparent border-l-brand bg-brand-sub text-label-1"
                                                    : "border-transparent border-l-transparent [@media(hover:hover)]:hover:bg-fill-1"
                                            )}
                                        >
                                            <span className="text-sm font-medium truncate">
                                                {room.name}
                                            </span>
                                            {room.lastMessage && (
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className="text-xs text-muted-foreground truncate flex-grow">
                                                        {markdownPreviewText(room.lastMessage.text).substring(0, 50)}
                                                        {markdownPreviewText(room.lastMessage.text).length > 50 ? "…" : ""}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground shrink-0">
                                                        {formatTimestamp(room.lastMessage.createdAt)}
                                                    </span>
                                                </div>
                                            )}
                                        </NavLink>
                                    )}

                                    {/* Room options - hide in selection mode */}
                                    {!isSelectionMode && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-8 w-8 p-0 shrink-0 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                                                >
                                                    <MoreVertical className="h-4 w-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem
                                                    onClick={() => handleOpenRenameDialog(room.id, room.name)}
                                                >
                                                    <Edit className="h-4 w-4 mr-2" />
                                                    {t("rooms.renameMenu")}
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    onClick={() => handleDeleteRoom(room.id, room.name)}
                                                    className="text-destructive"
                                                >
                                                    <Trash2 className="h-4 w-4 mr-2" />
                                                    {t("rooms.deleteMenu")}
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                </div>
                            );
                        }),
                        ])
                    )}
                </div>
            )}

            {/* Floating action bar for selection mode */}
            {isSelectionMode && selectedRoomIds.size > 0 && (
                <div className="material sticky bottom-0 mt-2 mx-2 p-3 rounded-lg border border-sep shadow-e2-rim animate-in slide-in-from-bottom-5 duration-300">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                            {t("rooms.selectedCount", { count: selectedRoomIds.size })}
                        </span>
                        <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setIsDeleteDialogOpen(true)}
                        >
                            <Trash2 className="h-4 w-4 mr-1" />
                            {t("common.delete")}
                        </Button>
                    </div>
                </div>
            )}
        </div>
        {/* Rename Room Dialog */}
        <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("rooms.renameDialogTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("rooms.renameDialogDescription")}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <Input
                        placeholder={t("rooms.renamePlaceholder")}
                        value={renameRoomName}
                        onChange={(e) => setRenameRoomName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                handleRenameRoom();
                            }
                        }}
                        autoFocus
                    />
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => {
                            setIsRenameDialogOpen(false);
                            setRoomToRename(null);
                            setRenameRoomName("");
                        }}
                    >
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={handleRenameRoom}>
                        {t("common.rename")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        {/* Batch Delete Confirmation Dialog */}
        <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("rooms.deleteDialogTitle", { count: selectedRoomIds.size })}</DialogTitle>
                    <DialogDescription>
                        {t("rooms.deleteDialogDescription")}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                    <p className="text-sm font-medium">{t("rooms.roomsToDelete")}</p>
                    <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
                        {Array.from(selectedRoomIds).slice(0, 5).map((roomId) => {
                            const room = rooms.find((r: Room) => r.id === roomId);
                            return room ? <li key={roomId}>{room.name}</li> : null;
                        })}
                        {selectedRoomIds.size > 5 && (
                            <li className="text-foreground font-medium">
                                {t("rooms.moreRooms", { count: selectedRoomIds.size - 5 })}
                            </li>
                        )}
                    </ul>
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => setIsDeleteDialogOpen(false)}
                    >
                        {t("common.cancel")}
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={handleBatchDeleteRooms}
                    >
                        {t("rooms.deleteDialogConfirm", { count: selectedRoomIds.size })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
        </Fragment>
    );
}
