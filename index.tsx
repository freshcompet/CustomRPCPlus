/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import CustomRPC, { setRpc } from "@plugins/customRPC";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { Application } from "@vencord/discord-types";
import { ActivityStatusDisplayType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { ApplicationStore, FluxDispatcher, IconUtils, React, Select, TextInput, useEffect, useState, useStateFromStores } from "@webpack/common";
import type { ReactElement, ReactNode } from "react";

import { CompletePresets } from "./completePresets";
import { startPresetSync } from "./presets";
import { createTimestampLoop } from "./timestampLoop";

const logger = new Logger("CustomRPCPlus");
const { fetchApplication }: { fetchApplication(id: string): Promise<Application | null>; } = findByPropsLazy("fetchApplication");
const pendingApplications = new Set<string>();
const PLATFORM_OPTIONS = [
    { label: "Default (no platform)", value: "", default: true },
    { label: "PlayStation", value: "ps5" },
    { label: "Xbox", value: "xbox" }
];
const STATUS_OPTIONS = [
    { label: "Application Name", value: ActivityStatusDisplayType.NAME, default: true },
    { label: "State", value: ActivityStatusDisplayType.STATE },
    { label: "Details", value: ActivityStatusDisplayType.DETAILS }
];
const ACTIVITY_KEYS: ("platform" | "gameProfile" | "statusDisplayType")[] = ["platform", "gameProfile", "statusDisplayType"];
let active = false;
let presetSync: ReturnType<typeof startPresetSync> | undefined;
let timestampLoop: ReturnType<typeof createTimestampLoop> | undefined;
let originalEditor: typeof CustomRPC.settings.def.config.component | undefined;
let originalAbout: typeof CustomRPC.settingsAboutComponent | undefined;

function refreshOriginal() {
    timestampLoop?.sync();
    const gameId = getGameId(settings.store.gameProfile);
    if (gameId && !CustomRPC.settings.store.imageBig) ensureGameImage(gameId);
    if (isPluginEnabled(CustomRPC.name)) {
        setRpc().catch(error => logger.error("Could not refresh CustomRPC.", error));
    }
}

function ensureGameImage(gameId: string) {
    if (!active || ApplicationStore.getApplication(gameId) || ApplicationStore.didFetchingApplicationFail(gameId) || pendingApplications.has(gameId)) return;
    pendingApplications.add(gameId);
    fetchApplication(gameId).then(() => {
        if (active && getGameId(settings.store.gameProfile) === gameId && ApplicationStore.getApplication(gameId)?.icon) {
            refreshOriginal();
        }
    }).catch(error => logger.error("Could not load the game artwork.", error))
        .finally(() => pendingApplications.delete(gameId));
}

export const settings = definePluginSettings({
    statusDisplayType: {
        type: OptionType.SELECT,
        description: "Field displayed as your activity text in the member list.",
        options: STATUS_OPTIONS,
        onChange: onOptionsChange
    },
    gameProfile: {
        type: OptionType.STRING,
        description: "Discord game page URL or game Application ID. Leave empty to use CustomRPC's Application ID.",
        default: "https://discord.com/games/1445160676522856458",
        isValid: isGameProfileValid,
        onChange: onOptionsChange
    },
    platform: {
        type: OptionType.SELECT,
        description: "Platform added to the original CustomRPC activity.",
        options: PLATFORM_OPTIONS,
        onChange: onOptionsChange
    }
});

function onOptionsChange() {
    if (!active || presetSync?.loading) return;
    presetSync?.save();
    refreshOriginal();
}

function getGameId(value: string) {
    const input = value.trim();
    if (/^\d{16,21}$/.test(input)) return input;
    try {
        const url = new URL(input);
        if (url.protocol !== "https:" || url.hostname !== "discord.com") return;
        return url.pathname.match(/^\/(?:games\/|game\/(?:[\w-]+-)?)(\d{16,21})\/?$/)?.[1];
    } catch {
        return;
    }
}

function isGameProfileValid(value: string) {
    return !value.trim() || !!getGameId(value) || "Enter a Discord game page link or a valid game Application ID.";
}

function getPlatform() {
    const { platform } = settings.store;
    if (platform === "ps5" || platform === "ps4" || platform === "playstation") return "ps5";
    if (platform === "xbox") return "xbox";
    return "";
}

function withActivityOptions(source: object) {
    const activity: Record<string, unknown> = timestampLoop?.apply({ ...source }) ?? { ...source };
    const platform = getPlatform();
    if (platform) activity.platform = platform;
    else delete activity.platform;
    activity.status_display_type = settings.store.statusDisplayType;

    const gameId = getGameId(settings.store.gameProfile);
    if (gameId) {
        const originalAppId = activity.application_id;
        activity.application_id = gameId;
        const assets: Record<string, unknown> = activity.assets && typeof activity.assets === "object" ? { ...activity.assets } : {};
        for (const key of ["large_image", "small_image"]) {
            const image = assets[key];
            if (originalAppId !== gameId && typeof originalAppId === "string" && /^\d{16,21}$/.test(originalAppId)
                && typeof image === "string" && /^\d{16,21}$/.test(image)) {
                assets[key] = `mp:app-assets/${originalAppId}/${image}.png`;
            }
        }
        if (!assets.large_image) {
            const application = ApplicationStore.getApplication(gameId);
            if (application?.icon) {
                const url = new URL(IconUtils.getApplicationIconURL({ id: gameId, icon: application.icon }));
                assets.large_image = `mp:${url.pathname.slice(1)}`;
                if (!assets.large_text) assets.large_text = application.name;
            }
        }
        delete assets.large_url;
        delete assets.small_url;
        if (Object.keys(assets).length) activity.assets = assets;
    }
    return activity;
}

function interceptActivity(event: { type?: string; socketId?: unknown; activity?: unknown; }) {
    if (!active || event.type !== "LOCAL_ACTIVITY_UPDATE" || event.socketId !== "CustomRPC") return;
    timestampLoop?.sync();
    if (!event.activity || typeof event.activity !== "object") return;
    event.activity = withActivityOptions(event.activity);
    const gameId = getGameId(settings.store.gameProfile);
    if (gameId && !CustomRPC.settings.store.imageBig) ensureGameImage(gameId);
}

function updatePreview(node: ReactNode): ReactNode {
    if (Array.isArray(node)) return node.map(updatePreview);
    if (!node || typeof node !== "object" || !("type" in node) || !("props" in node)) return node;

    const element = node as ReactElement<{ activity?: object; children?: ReactNode; }>;
    const { activity, children } = element.props;
    if (activity) {
        return React.createElement(element.type, { ...element.props, key: element.key, activity: withActivityOptions(activity) });
    }
    if (children == null) return node;
    const updatedChildren = Array.isArray(children) ? children.map(updatePreview) : [updatePreview(children)];
    return React.createElement(element.type, { ...element.props, key: element.key }, ...updatedChildren);
}

const SafeRPCAbout = ErrorBoundary.wrap(function RPCAboutContent() {
    const { gameProfile } = settings.use(ACTIVITY_KEYS);
    useStateFromStores([ApplicationStore], () => ApplicationStore.getApplication(getGameId(gameProfile) ?? "")?.icon, [gameProfile]);
    return <>{originalAbout && updatePreview(originalAbout())}</>;
}, { noop: false });

function EnhancedRPCAbout() {
    return <SafeRPCAbout />;
}

function PlatformSetting() {
    settings.use(ACTIVITY_KEYS);
    return (
        <>
            <Heading>Platform</Heading>
            <Select
                options={PLATFORM_OPTIONS}
                select={value => settings.store.platform = value}
                isSelected={value => value === getPlatform()}
                serialize={String}
                closeOnSelect={true}
            />
            <Paragraph>This platform is used in both the CustomRPC preview and the outgoing activity.</Paragraph>
        </>
    );
}

function StatusDisplaySetting() {
    const { statusDisplayType } = settings.use(ACTIVITY_KEYS);
    return (
        <>
            <Heading>Status Display Type</Heading>
            <Select
                options={STATUS_OPTIONS}
                select={value => settings.store.statusDisplayType = value}
                isSelected={value => value === statusDisplayType}
                serialize={String}
                closeOnSelect={true}
            />
            <Paragraph>Choose which field appears in the member list: Application Name, State or Details.</Paragraph>
        </>
    );
}

function GameProfileSetting() {
    const { gameProfile } = settings.use(ACTIVITY_KEYS);
    const [draft, setDraft] = useState(gameProfile);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setDraft(gameProfile);
        setError(null);
    }, [gameProfile]);
    return (
        <>
            <Heading>Game Profile</Heading>
            <TextInput
                value={draft}
                placeholder="Discord game page URL or game Application ID"
                onChange={value => {
                    setDraft(value);
                    const valid = isGameProfileValid(value);
                    setError(valid === true ? null : valid);
                    if (valid === true) settings.store.gameProfile = value;
                }}
            />
            {error && <Paragraph>{error}</Paragraph>}
            <Paragraph>Links the icon to the game's Discord page. Your image is kept; if the large image is empty, the game's artwork is used when available. Clear this field to use the original activity.</Paragraph>
        </>
    );
}

const SafeRPCSettings = ErrorBoundary.wrap(function RPCSettingsContent() {
    const OriginalEditor = originalEditor;
    const [formVersion, setFormVersion] = useState(0);
    return (
        <>
            <PlatformSetting />
            <StatusDisplaySetting />
            <GameProfileSetting />
            <CompletePresets
                getOptions={() => ({ platform: getPlatform(), gameProfile: settings.store.gameProfile, statusDisplayType: settings.store.statusDisplayType })}
                onLoad={options => {
                    presetSync?.apply(options);
                    setFormVersion(version => version + 1);
                }}
            />
            {OriginalEditor && <OriginalEditor key={formVersion} />}
        </>
    );
}, { noop: false });

function EnhancedRPCSettings() {
    return <SafeRPCSettings />;
}

export default definePlugin({
    name: "CustomRPCPlus",
    description: "Adds platforms, game profiles, status display selection and complete presets to CustomRPC.",
    authors: [{ name: "thisispink", id: 801514233010847784n }],
    tags: ["Activity", "Customisation"],
    dependencies: ["CustomRPC"],
    settings,
    settingsAboutComponent: () => (
        <Paragraph>Keep CustomRPC enabled and edit your presence there. Use Complete Presets to save all settings in either Vencord or Equicord.</Paragraph>
    ),

    start() {
        active = true;
        timestampLoop = createTimestampLoop(refreshOriginal);
        presetSync = startPresetSync(
            () => ({ platform: getPlatform(), gameProfile: settings.store.gameProfile, statusDisplayType: settings.store.statusDisplayType }),
            options => {
                Object.assign(settings.store, options);
                queueMicrotask(() => { if (active) refreshOriginal(); });
            }
        );
        originalEditor = CustomRPC.settings.def.config.component;
        CustomRPC.settings.def.config.component = EnhancedRPCSettings;
        originalAbout = CustomRPC.settingsAboutComponent;
        CustomRPC.settingsAboutComponent = EnhancedRPCAbout;
        FluxDispatcher.addInterceptor(interceptActivity);
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", socketId: "CustomRPCPlus", activity: null });
        refreshOriginal();
    },

    stop() {
        active = false;
        timestampLoop?.stop();
        timestampLoop = undefined;
        presetSync?.stop();
        presetSync = undefined;
        const interceptors: unknown[] = FluxDispatcher._interceptors;
        const index = interceptors.indexOf(interceptActivity);
        if (index !== -1) interceptors.splice(index, 1);
        if (CustomRPC.settings.def.config.component === EnhancedRPCSettings && originalEditor) {
            CustomRPC.settings.def.config.component = originalEditor;
        }
        if (CustomRPC.settingsAboutComponent === EnhancedRPCAbout && originalAbout) {
            CustomRPC.settingsAboutComponent = originalAbout;
        }
        refreshOriginal();
    }
});
