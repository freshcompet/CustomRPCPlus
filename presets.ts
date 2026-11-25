/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SettingsStore } from "@api/Settings";
import CustomRPC from "@plugins/customRPC";

export interface PlusPresetOptions {
    platform: string;
    gameProfile: string;
    statusDisplayType: number;
}

const PRESET_PATH = "plugins.CustomRPC.customRPCPlus";

export function startPresetSync(getOptions: () => PlusPresetOptions, applyOptions: (options: PlusPresetOptions) => void) {
    let syncing = false;

    function save() {
        if (syncing) return;
        syncing = true;
        Object.assign(CustomRPC.settings.store, { customRPCPlus: JSON.stringify({ version: 1, ...getOptions() }) });
        syncing = false;
    }

    function load(value: unknown) {
        if (syncing || typeof value !== "string") return;
        let config: unknown;
        try {
            config = JSON.parse(value);
        } catch {
            return;
        }
        if (!config || typeof config !== "object" || !("platform" in config) || !("gameProfile" in config) || !("statusDisplayType" in config)) return;
        const { platform, gameProfile, statusDisplayType } = config;
        if (typeof platform !== "string" || typeof gameProfile !== "string" || typeof statusDisplayType !== "number") return;
        if (!["", "ps5", "ps4", "playstation", "xbox"].includes(platform) || ![0, 1, 2].includes(statusDisplayType)) return;

        syncing = true;
        try {
            applyOptions({ platform, gameProfile, statusDisplayType });
        } finally {
            syncing = false;
        }
    }

    SettingsStore.addChangeListener(PRESET_PATH, load);
    save();
    return {
        save,
        apply(options: PlusPresetOptions) {
            syncing = true;
            try {
                applyOptions(options);
            } finally {
                syncing = false;
            }
            save();
        },
        get loading() { return syncing; },
        stop() {
            SettingsStore.removeChangeListener(PRESET_PATH, load);
            const originalStore = CustomRPC.settings.store as typeof CustomRPC.settings.store & { customRPCPlus?: string; };
            delete originalStore.customRPCPlus;
        }
    };
}
