import React from "react";
import { HumanInputDialog, type HumanInputDialogProps } from "./HumanInputDialog";
import {
    StrategyApprovalDialog,
    type StrategyApprovalDialogProps,
} from "./StrategyApprovalDialog";

/**
 * CEX post-PR237 cleanup — the `trading_approval` variant (former
 * `CEXApprovalDialog` consumer) was retired. The active approval
 * flow runs entirely through `human_input` + `HumanInputDialog`,
 * which embeds `TradingOrderEditor` and `MarketSnapshotPanel`. The
 * union is kept so future surfaces (chain approval, custom write
 * actions) can register their own dialog ids.
 */
type DialogProps = {
    id: "human_input";
    props: HumanInputDialogProps;
} | {
    id: "strategy_approval";
    props: StrategyApprovalDialogProps;
};

export const Dialog: React.FC<DialogProps> = ({ id, props }) => {
    switch (id) {
        case "human_input":
            return <HumanInputDialog {...props} />;
        case "strategy_approval":
            return <StrategyApprovalDialog {...props} />;
        default:
            return null;
    }
};
