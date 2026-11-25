/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import CustomRPC, { setRpc, TimestampMode } from "@plugins/customRPC";

export function createTimestampLoop(refresh: () => void) {
    let interval: ReturnType<typeof setInterval> | undefined;
    let anchor = 0;
    let signature = "";

    function stop() {
        if (interval !== undefined) clearInterval(interval);
        interval = undefined;
        anchor = 0;
        signature = "";
    }

    return {
        sync() {
            const { enablePresence, timestampMode, startTime, endTime } = CustomRPC.settings.store;
            if (!Object.is(CustomRPC.start, setRpc) || !enablePresence || timestampMode !== TimestampMode.CUSTOM || !startTime || !endTime || endTime <= startTime) {
                stop();
                return;
            }
            const next = `${startTime}:${endTime}`;
            if (next === signature) return;
            stop();
            signature = next;
            anchor = Date.now();
            const duration = endTime - startTime;
            interval = setInterval(() => {
                if (Date.now() >= anchor + duration) {
                    anchor = Date.now();
                    refresh();
                }
            }, 1000);
        },
        apply(activity: Record<string, unknown>) {
            if (!anchor) return activity;
            const { startTime = 0, endTime = 0 } = CustomRPC.settings.store;
            return { ...activity, timestamps: { start: anchor, end: anchor + endTime - startTime } };
        },
        stop
    };
}
