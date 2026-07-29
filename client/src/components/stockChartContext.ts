import { createContext } from "react";

/**
 * 消息的发送时间（毫秒时间戳）。
 *
 * 聊天记录是持久化的，而 `<StockChart />` 画的是当下行情。用户三天后翻回这条
 * 消息，图表显示的是三天后的价格，与当时的文字对不上。组件用这个值在头部标注
 * "消息发于 N 天前"，让图文不符的地方有个解释。
 *
 * 值为 null 表示不在聊天场景（例如别处复用该组件），此时不显示角标。
 */
export const MessageTimeContext = createContext<number | null>(null);

/**
 * 流式渲染标记。为 true 时 `<StockChart />` 只渲染占位骨架、不发请求——
 * 正文还在逐 token 增长，标签可能只写了一半。
 */
export const StreamingContext = createContext<boolean>(false);
