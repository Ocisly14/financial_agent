import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { UUID } from "@/types/core";
import { apiClient } from "@/lib/api";
import { TopicWorkspace } from "@/components/workspace/TopicWorkspace";

/**
 * `/research/:tenantId/:researchId` (spec §7.9).
 *
 * Note what this route does NOT carry: the focused member. Focus is transient
 * view state and the controller agent can move it, so putting it in the URL
 * would write one history entry per `focus` call and leave the back button
 * walking through the agent's own attention. It lives in `TopicWorkspace`.
 *
 * A Research whose members have all been deleted still resolves here: its
 * conversation and its thesis keep their value, so the workspace renders an
 * empty-members state rather than an error (spec §7.3).
 */
export default function ResearchRoute() {
    const { tenantId, researchId } = useParams<{ tenantId: UUID; researchId: UUID }>();
    const { t } = useTranslation();

    const { data, isPending, isError } = useQuery({
        queryKey: ["research", tenantId, researchId],
        queryFn: () => apiClient.getResearch(tenantId!, researchId!),
        enabled: Boolean(tenantId && researchId),
    });

    if (!tenantId || !researchId) {
        return <CenteredMessage>{t("chat.noAgentSpecified")}</CenteredMessage>;
    }
    if (isPending) {
        return <CenteredMessage>{t("research.loading")}</CenteredMessage>;
    }
    if (isError || !data?.research) {
        return <CenteredMessage>{t("research.loadFailed")}</CenteredMessage>;
    }

    return (
        <TopicWorkspace
            tenantId={tenantId}
            members={data.members ?? []}
            research={data.research}
        />
    );
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
    return <div className="flex h-dvh items-center justify-center text-sm text-label-3">{children}</div>;
}
