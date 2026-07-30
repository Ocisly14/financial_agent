import { useParams, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Chat from "@/components/chat";
import type { UUID } from "@/types/core";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare } from "lucide-react";
import { generateChatRoomName } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";

export default function AgentRoute() {
    const { agentId, roomId } = useParams<{ agentId: UUID; roomId?: UUID }>();
    const navigate = useNavigate();
    const [isCreatingRoom, setIsCreatingRoom] = useState(false);
    const { toast } = useToast();
    const { t } = useTranslation();

    // Fetch rooms for this agent if no roomId is provided
    const { data: roomsData, isLoading } = useQuery({
        queryKey: ["rooms", agentId],
        queryFn: () => apiClient.getRooms(agentId!),
        enabled: !!agentId && !roomId,
    });

    useEffect(() => {
        if (!agentId || roomId || isLoading) return;
        const rooms = roomsData?.rooms || [];
        if (rooms.length > 0) {
            navigate(`/chat/${agentId}/${rooms[0].id}`, { replace: true });
        }
        // If no rooms exist, the empty-state UI below offers a create button.
    }, [agentId, roomId, roomsData, isLoading, navigate]);

    const handleCreateRoom = async () => {
        setIsCreatingRoom(true);
        try {
            const roomName = generateChatRoomName();
            const result = await apiClient.createRoom(agentId!, roomName);
            if (result.success) {
                navigate(`/chat/${agentId}/${result.room.id}`, { replace: true });
                toast({
                    title: t("chat.roomCreatedTitle"),
                    description: t("chat.roomCreatedDescription", { name: result.room.name }),
                });
            } else {
                console.error("Failed to create room:", result);
                toast({
                    variant: "destructive",
                    title: t("chat.createRoomFailedTitle"),
                    description: t("chat.createRoomFailedDescription"),
                });
            }
        } catch (error) {
            console.error("Failed to create room:", error);
            toast({
                variant: "destructive",
                title: t("chat.createRoomFailedTitle"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        } finally {
            setIsCreatingRoom(false);
        }
    };

    if (!agentId) return <div>{t("chat.noAgentSpecified")}</div>;

    if (!roomId) {
        if (isLoading) {
            return <div className="flex items-center justify-center h-full">{t("chat.loadingRoom")}</div>;
        }
        const rooms = roomsData?.rooms || [];
        if (rooms.length === 0) {
            return (
                <div className="flex items-center justify-center h-full">
                    <div className="text-center space-y-6 max-w-md">
                        <div className="space-y-2">
                            <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground" />
                            <h2 className="text-xl font-semibold">{t("chat.noRoomsTitle")}</h2>
                            <p className="text-muted-foreground">
                                {t("chat.noRoomsDescription")}
                            </p>
                        </div>
                        <Button
                            onClick={handleCreateRoom}
                            disabled={isCreatingRoom}
                            className="space-x-2"
                        >
                            <Plus className="h-4 w-4" />
                            <span>{isCreatingRoom ? t("chat.creatingRoom") : t("chat.createRoom")}</span>
                        </Button>
                    </div>
                </div>
            );
        }
        return <div>{t("chat.unableToLoadRoom")}</div>;
    }

    return <Chat agentId={agentId} roomId={roomId} />;
}
