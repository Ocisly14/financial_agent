import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import Overview from "@/components/overview";
import { useParams } from "react-router";
import type { UUID } from "@/types/core";
import { useTranslation } from "react-i18next";

export default function AgentRoute() {
    const { agentId } = useParams<{ agentId: UUID }>();
    const { t } = useTranslation();

    const query = useQuery({
        queryKey: ["agent", agentId],
        queryFn: () => apiClient.getAgent(agentId ?? ""),
        // Single-agent details barely change at runtime; 5s polling was a
        // mobile-bandwidth tax with no user benefit.
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        enabled: Boolean(agentId),
    });

    if (!agentId) return <div>{t("overview.empty")}</div>;

    const character = query?.data?.character;

    if (!character) return null;

    return <Overview character={character} />;
}
