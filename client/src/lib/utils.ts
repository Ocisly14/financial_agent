import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
import relativeTime from "dayjs/plugin/relativeTime";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

dayjs.extend(localizedFormat);
dayjs.extend(relativeTime);

export const moment = dayjs;

export const formatAgentName = (name: string) => {
    return name.substring(0, 2);
};

export const generateTopicName = () => {
    return `Chat ${dayjs().format("YYYY-MM-DD HH:mm")}`;
};
