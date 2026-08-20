import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

/**
 * The agents the server declares, by name and description.
 *
 * The client used to hard-code which agents exist, which meant two lists of the same thing: adding
 * an agent on the server left the UI calling it "Other" until someone remembered to edit here.
 * Presentation — icon, colour — still belongs to the client; identity comes from the topology.
 *
 * The roster changes only on deploy, so it is cached for the session and never refetched on focus.
 */
export function useAgentRoster() {
    const { data } = useQuery({
        queryKey: ["agent-roster"],
        queryFn: () => apiClient.getAgentRoster(),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
    const byName = new Map((data?.agents ?? []).map((agent) => [agent.name, agent.description]));
    return { describeAgent: (name: string): string | undefined => byName.get(name) };
}
