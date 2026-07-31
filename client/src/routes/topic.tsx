import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MessageSquare, Plus } from "lucide-react";
import type { TopicSummary, UUID } from "@/types/core";
import { apiClient } from "@/lib/api";
import { generateTopicName } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { TopicWorkspace } from "@/components/workspace/TopicWorkspace";

/**
 * Resolves `:agentId` / `:topicId` into an active Topic and hands it to the
 * workspace. Three cases: no such topic (redirect to the most recent one),
 * no topics at all (empty state with a create button), and the normal one.
 */
export default function TopicRoute() {
    const { agentId, topicId } = useParams<{ agentId: UUID; topicId?: UUID }>();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { t } = useTranslation();
    const [isCreating, setIsCreating] = useState(false);

    const { data, isPending, isError } = useQuery({
        queryKey: ["topics", agentId],
        queryFn: () => apiClient.getTopics(agentId!),
        enabled: Boolean(agentId),
    });

    // Most recently active first — the same order the rail shows.
    const topics = useMemo<TopicSummary[]>(() => {
        const list = [...(data?.topics ?? [])];
        list.sort((a, b) => {
            const aTime = a.lastMessage?.createdAt ?? a.createdAt;
            const bTime = b.lastMessage?.createdAt ?? b.createdAt;
            return bTime - aTime;
        });
        return list;
    }, [data]);

    const activeTopic = topicId ? topics.find((topic) => topic.id === topicId) : undefined;

    useEffect(() => {
        if (!agentId || isPending || topics.length === 0) return;
        if (activeTopic) return;
        // Either no id in the URL, or one that no longer exists.
        navigate(`/topic/${agentId}/${topics[0].id}`, { replace: true });
    }, [agentId, isPending, topics, activeTopic, navigate]);

    const handleCreate = async () => {
        if (!agentId) return;
        setIsCreating(true);
        try {
            const result = await apiClient.createTopic(agentId, generateTopicName());
            if (result.success) {
                void queryClient.invalidateQueries({ queryKey: ["topics", agentId] });
                navigate(`/topic/${agentId}/${result.topic.id}`, { replace: true });
            } else {
                toast({
                    variant: "destructive",
                    title: t("topics.createFailedTitle"),
                    description: t("topics.createFailedDescription"),
                });
            }
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("topics.createFailedTitle"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        } finally {
            setIsCreating(false);
        }
    };

    if (!agentId) {
        return <CenteredMessage>{t("chat.noAgentSpecified")}</CenteredMessage>;
    }

    if (isPending) {
        return <CenteredMessage>{t("topics.loading")}</CenteredMessage>;
    }

    if (isError) {
        return <CenteredMessage>{t("topics.loadFailed")}</CenteredMessage>;
    }

    if (topics.length === 0) {
        return (
            <div className="flex h-dvh items-center justify-center px-6">
                <div className="max-w-md space-y-6 text-center">
                    <div className="space-y-2">
                        <MessageSquare className="mx-auto size-10 text-label-3" />
                        <h2 className="text-lg font-semibold text-label-1">{t("topics.emptyTitle")}</h2>
                        <p className="text-sm text-label-3">{t("topics.emptyDescription")}</p>
                    </div>
                    <Button onClick={handleCreate} disabled={isCreating} className="gap-2">
                        <Plus className="size-4" />
                        <span>{isCreating ? t("topics.creating") : t("topics.new")}</span>
                    </Button>
                </div>
            </div>
        );
    }

    // The redirect effect above is what resolves this; render nothing rather
    // than a flash of the wrong topic.
    if (!activeTopic) return <CenteredMessage>{t("topics.loading")}</CenteredMessage>;

    return <TopicWorkspace agentId={agentId} members={[activeTopic]} activeTopic={activeTopic} />;
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
    return <div className="flex h-dvh items-center justify-center text-sm text-label-3">{children}</div>;
}
