/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import CustomRPC from "@plugins/customRPC";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import { React, Select, showToast, TextInput, useState } from "@webpack/common";

import type { PlusPresetOptions } from "./presets";

export const COMPLETE_PRESETS_KEY = "CustomRPCPlus_complete_presets_v1";
const PRESET_DEPS = [COMPLETE_PRESETS_KEY];
const logger = new Logger("CustomRPCPlus");
const RPC_DEFAULTS = {
    enablePresence: true, appID: "", appName: "", details: "", detailsURL: "", state: "", stateURL: "",
    type: 0, streamLink: "", timestampMode: 0, startTime: 0, endTime: 0,
    imageBig: "", imageBigURL: "", imageBigTooltip: "", imageSmall: "", imageSmallURL: "", imageSmallTooltip: "",
    buttonOneText: "", buttonOneURL: "", buttonTwoText: "", buttonTwoURL: "", partySize: 0, partyMaxSize: 0
};

interface CompletePreset {
    name: string;
    config: { rpc: typeof RPC_DEFAULTS; plus: PlusPresetOptions; };
}

interface Props {
    getOptions(): PlusPresetOptions;
    onLoad(options: PlusPresetOptions): void;
}

function readRpc(source: object) {
    const config = { ...RPC_DEFAULTS };
    for (const key of Object.keys(RPC_DEFAULTS) as (keyof typeof RPC_DEFAULTS)[]) {
        if (key in source) {
            const value: unknown = source[key];
            if (typeof value === typeof RPC_DEFAULTS[key]) Object.assign(config, { [key]: value });
        }
    }
    return config;
}

function readPlus(source: object, fallback: PlusPresetOptions): PlusPresetOptions {
    const result = { ...fallback };
    if ("platform" in source && typeof source.platform === "string" && ["", "ps4", "ps5", "playstation", "xbox"].includes(source.platform)) result.platform = source.platform;
    if ("gameProfile" in source && typeof source.gameProfile === "string") result.gameProfile = source.gameProfile;
    if ("statusDisplayType" in source && typeof source.statusDisplayType === "number" && [0, 1, 2].includes(source.statusDisplayType)) result.statusDisplayType = source.statusDisplayType;
    return result;
}

function normalizePresets(value: unknown, fallback: PlusPresetOptions): CompletePreset[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: unknown) => {
        if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string" || !("config" in item)) return [];
        const { config } = item;
        if (!config || typeof config !== "object") return [];
        if ("rpc" in config && config.rpc && typeof config.rpc === "object" && "plus" in config && config.plus && typeof config.plus === "object") {
            return [{ name: item.name, config: { rpc: readRpc(config.rpc), plus: readPlus(config.plus, fallback) } }];
        }
        let plus = readPlus(config, fallback);
        if ("customRPCPlus" in config && typeof config.customRPCPlus === "string") {
            try {
                const stored: unknown = JSON.parse(config.customRPCPlus);
                if (stored && typeof stored === "object") plus = readPlus(stored, plus);
            } catch {
                logger.warn("Skipped invalid Plus options in an existing preset.");
            }
        }
        return [{ name: item.name, config: { rpc: readRpc(config), plus } }];
    });
}

async function readExistingPresets(fallback: PlusPresetOptions) {
    const [original, standalone] = await Promise.all([
        DataStore.get<unknown>("CustomRPC_presets"), DataStore.get<unknown>("CustomRPCPlus_presets")
    ]);
    const presets = normalizePresets(original, fallback);
    for (const preset of normalizePresets(standalone, fallback)) {
        if (!presets.some(current => current.name === preset.name)) presets.push(preset);
    }
    return presets.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadCompletePresets(fallback: PlusPresetOptions) {
    const saved = await DataStore.get<unknown>(COMPLETE_PRESETS_KEY);
    if (saved !== undefined) return normalizePresets(saved, fallback);
    const presets = await readExistingPresets(fallback);
    await DataStore.set(COMPLETE_PRESETS_KEY, presets);
    return presets;
}

export function CompletePresets({ getOptions, onLoad }: Props) {
    const [stored, error, pending] = useAwaiter(() => loadCompletePresets(getOptions()), { fallbackValue: [], deps: PRESET_DEPS });
    const [changed, setChanged] = useState<CompletePreset[] | null>(null);
    const [name, setName] = useState("");
    const [selected, setSelected] = useState("");
    const presets = changed ?? stored;

    async function persist(next: CompletePreset[]) {
        await DataStore.set(COMPLETE_PRESETS_KEY, next);
        setChanged(next);
    }

    async function save() {
        const trimmed = name.trim();
        if (!trimmed) return;
        await persist([
            ...presets.filter(preset => preset.name !== trimmed),
            { name: trimmed, config: { rpc: readRpc(CustomRPC.settings.store), plus: getOptions() } }
        ].sort((a, b) => a.name.localeCompare(b.name)));
        setSelected(trimmed);
        showToast({ text: `Saved complete preset ${trimmed}.`, variant: "success" });
    }

    function load() {
        const preset = presets.find(preset => preset.name === selected);
        if (!preset) return;
        Object.assign(CustomRPC.settings.store, preset.config.rpc);
        onLoad(preset.config.plus);
        showToast({ text: `Loaded complete preset ${preset.name}.`, variant: "success" });
    }

    async function remove() {
        await persist(presets.filter(preset => preset.name !== selected));
        setSelected("");
    }

    async function copyExisting() {
        const existing = await readExistingPresets(getOptions());
        const next = [...presets, ...existing.filter(preset => !presets.some(current => current.name === preset.name))];
        await persist(next.sort((a, b) => a.name.localeCompare(b.name)));
        showToast({ text: "Copied existing presets. Current complete presets were kept.", variant: "success" });
    }

    return (
        <Flex flexDirection="column" gap=".5em">
            <Divider />
            <Heading>Complete Presets</Heading>
            <Paragraph>Save all CustomRPC and Plus settings together. These presets work in both Vencord and Equicord.</Paragraph>
            {error && <Paragraph>Could not load presets. Reopen the settings to try again.</Paragraph>}
            <TextInput placeholder="Complete preset name" value={name} onChange={setName} />
            <Button disabled={pending || !!error || !name.trim()} onClick={save}>Save Complete Preset</Button>
            <Select
                placeholder="Select a complete preset"
                options={presets.map(preset => ({ label: preset.name, value: preset.name }))}
                select={setSelected}
                isSelected={value => value === selected}
                serialize={String}
                closeOnSelect={true}
            />
            <Flex gap=".5em">
                <Button disabled={!selected} onClick={load}>Load Complete Preset</Button>
                <Button disabled={!selected} variant="dangerPrimary" onClick={remove}>Delete Complete Preset</Button>
            </Flex>
            <Button disabled={pending || !!error} onClick={copyExisting}>Copy Existing Presets</Button>
            <Divider />
        </Flex>
    );
}
