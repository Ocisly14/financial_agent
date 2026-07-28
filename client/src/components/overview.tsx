import type { Character } from "@/types/core";
import ArrayInput from "@/components/array-input";
import InputCopy from "@/components/input-copy";
import PageTitle from "./page-title";
import { useTranslation } from "react-i18next";

export default function Overview({ character }: { character: Character }) {
    const { t } = useTranslation();

    return (
        <div className="p-4">
            <PageTitle
                title={t("overview.title")}
                subtitle={t("overview.subtitle")}
            />
            <div className="space-y-4">
                <InputCopy title={t("overview.fields.name")} value={character?.name} />
                <InputCopy title={t("overview.fields.username")} value={character?.username} />
                <InputCopy title={t("overview.fields.system")} value={character?.system} />
                <InputCopy title={t("overview.fields.model")} value={character?.modelProvider} />
                <InputCopy
                    title={t("overview.fields.voiceModel")}
                    value={character?.settings?.voice?.model}
                />
                <ArrayInput
                    title={t("overview.fields.bio")}
                    data={
                        typeof character?.bio === "object" ? character?.bio : []
                    }
                />
                <ArrayInput
                    title={t("overview.fields.lore")}
                    data={
                        typeof character?.lore === "object"
                            ? character?.lore
                            : []
                    }
                />
            </div>
        </div>
    );
}
