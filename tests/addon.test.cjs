/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const { buildSync } = require("esbuild");

const pluginDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(pluginDir, "../../..");
const nativePresetsAvailable = fs.readFileSync(path.join(repoDir, "src/plugins/customRPC/RpcSettings.tsx"), "utf8").includes("function PresetSettings(");
const bundle = buildSync({
    absWorkingDir: repoDir,
    stdin: {
        contents: `export { default as plus, settings as plusSettings } from "./index";
            export { loadCompletePresets, COMPLETE_PRESETS_KEY } from "./completePresets";
            export { default as original, settings as originalSettings, setRpc } from "@plugins/customRPC";`,
        resolveDir: pluginDir,
        loader: "tsx"
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    external: ["@api/*", "@components/*", "@utils/*", "@shared/*", "@webpack", "@webpack/*", "react/jsx-runtime"]
}).outputFiles[0].text;

function harness(gameProfile = "") {
    const stores = {};
    const definitions = {};
    const events = [];
    const errors = [];
    const interceptors = [];
    const timers = new Map();
    const applications = new Map();
    const applicationRequests = [];
    const failedApplications = new Set();
    const settingListeners = new Map();
    const data = new Map();
    const hookState = new Map();
    const hookEffects = new Map();
    let componentPath = "direct";
    let hookIndex = 0;
    const enabled = { CustomRPC: true, CustomRPCPlus: true };
    const jsx = (type, props) => ({ type, props: props ?? {} });
    let previewActivity;
    let now = 1800000000000;
    let assetResolver = async (_id, keys) => keys.map(key => "asset:" + key);
    let applicationResolver = async () => null;
    const dispatcher = {
        _interceptors: interceptors,
        addInterceptor: fn => interceptors.push(fn),
        dispatch(event) {
            interceptors.forEach(fn => fn(event));
            events.push(event);
            return Promise.resolve();
        }
    };
    const mocks = {
        "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: component => component } },
        "@api/PluginManager": { isPluginEnabled: name => enabled[name] },
        "@api/Settings": {
            SettingsStore: {
                addChangeListener(path, listener) {
                    if (!settingListeners.has(path)) settingListeners.set(path, new Set());
                    settingListeners.get(path).add(listener);
                },
                removeChangeListener(path, listener) { settingListeners.get(path)?.delete(listener); }
            },
            definePluginSettings(def) {
                const result = {
                    def, pluginName: "",
                    get store() { return stores[this.pluginName]; },
                    use() { return this.store; },
                    withPrivateSettings() { return this; }
                };
                return result;
            }
        },
        "@api/UserSettings": { getUserSettingLazy: () => ({ useSetting: () => true, updateSetting() {} }) },
        "@api/index": { DataStore: {
            get: async key => structuredClone(data.get(key)),
            set: async (key, value) => { data.set(key, structuredClone(value)); }
        } },
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error(...args) { errors.push(args); } warn() {} } },
        "@utils/react": { useAwaiter: (_fn, opts) => [Array.isArray(opts.fallbackValue)
            ? structuredClone(data.get(opts.deps?.[0] ?? "CustomRPC_presets") ?? opts.fallbackValue) : previewActivity ?? opts.fallbackValue, null, false] },
        "@utils/guards": { isTruthy: Boolean },
        "@utils/types": {
            __esModule: true,
            default(plugin) {
                plugin.settings.pluginName = plugin.name;
                definitions[plugin.name] = plugin.settings.def;
                const initial = {};
                for (const [key, definition] of Object.entries(plugin.settings.def)) {
                    const value = definition.default ?? definition.options?.find(option => option.default)?.value;
                    if (value !== undefined) initial[key] = value;
                }
                stores[plugin.name] = new Proxy(initial, {
                    set(target, key, value) {
                        const changed = target[key] !== value;
                        target[key] = value;
                        if (changed) definitions[plugin.name][key]?.onChange?.(value);
                        if (changed) settingListeners.get(`plugins.${plugin.name}.${String(key)}`)?.forEach(listener => listener(value));
                        return true;
                    }
                });
                return plugin;
            },
            OptionType: { BOOLEAN: 0, COMPONENT: 1, SELECT: 2 }
        },
        "@utils/css": { classNameFactory: prefix => name => prefix + name },
        "@shared/debounce": { debounce: fn => fn },
        "@components/settings/tabs/plugins/components/Common": { resolveError: () => null },
        "@webpack": {
            findByCodeLazy: () => () => ({ profileThemeStyle: {} }), findComponentByCodeLazy: () => "ActivityView",
            findByPropsLazy: () => ({ fetchApplication: async id => {
                applicationRequests.push(id);
                try {
                    const application = await applicationResolver(id);
                    if (application) applications.set(id, application);
                    return application;
                } catch (error) {
                    failedApplications.add(id);
                    throw error;
                }
            } })
        },
        "@webpack/common": {
            FluxDispatcher: dispatcher,
            ApplicationAssetUtils: { fetchAssetIds: (...args) => assetResolver(...args) },
            ApplicationStore: { getApplication: id => applications.get(id), didFetchingApplicationFail: id => failedApplications.has(id) },
            IconUtils: { getApplicationIconURL: ({ id, icon }) => `https://cdn.discordapp.com/app-icons/${id}/${icon}.png` },
            React: { createElement: (type, props, ...children) => jsx(type,
                children.length ? { ...props, children: children.length === 1 ? children[0] : children } : props) },
            Select: "Select", TextInput: "TextInput", Menu: {}, UserStore: { getCurrentUser: () => ({ id: "801514233010847784" }) },
            useState(value) {
                const key = componentPath + ":" + hookIndex++;
                if (!hookState.has(key)) hookState.set(key, value);
                return [hookState.get(key), next => hookState.set(key, typeof next === "function" ? next(hookState.get(key)) : next)];
            },
            useEffect(effect, dependencies) {
                const key = componentPath + ":" + hookIndex++;
                const previous = hookEffects.get(key);
                if (!previous || dependencies.some((value, index) => value !== previous[index])) {
                    hookEffects.set(key, dependencies);
                    effect();
                }
            },
            useStateFromStores: (_stores, selector) => selector(), showToast() {}
        }
    };
    const module = { exports: {} };
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    vm.runInNewContext(bundle, {
        module, exports: module.exports, Date: FakeDate, URL, queueMicrotask,
        setInterval(fn) { const id = Symbol(); timers.set(id, fn); return id; },
        clearInterval(id) { timers.delete(id); },
        require(name) {
            if (mocks[name]) return mocks[name];
            if (name.startsWith("@components/")) {
                const component = name.split("/").pop();
                return { [component]: component };
            }
            throw new Error("Unexpected dependency: " + name);
        }
    });
    const api = module.exports;
    api.plusSettings.store.gameProfile = gameProfile;
    Object.assign(api.originalSettings.store, { appName: "Original game", appID: "12345678901234567" });
    function renderEditor() {
        const nodes = [];
        function visit(node, location) {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) { node.forEach((child, index) => visit(child, location + ":" + index)); return; }
            if (typeof node.type === "function") {
                const previousPath = componentPath;
                const previousIndex = hookIndex;
                componentPath = location + ":" + node.type.name + ":" + (node.props.key ?? "");
                hookIndex = 0;
                visit(node.type(node.props), componentPath);
                componentPath = previousPath;
                hookIndex = previousIndex;
                return;
            }
            nodes.push(node);
            visit(node.props?.children, location);
        }
        visit(jsx(api.original.settings.def.config.component, {}), "editor");
        return nodes;
    }
    return {
        ...api, events, errors, interceptors, timers, enabled, dispatcher, applications, applicationRequests, data, renderEditor, settingListeners,
        plusOptions: () => ({ platform: api.plusSettings.store.platform, gameProfile: api.plusSettings.store.gameProfile, statusDisplayType: api.plusSettings.store.statusDisplayType }),
        activity: () => events.filter(event => event.socketId === "CustomRPC").at(-1)?.activity,
        setPreview(activity) { previewActivity = activity; },
        async settle() { await new Promise(setImmediate); },
        resolveAssets(fn) { assetResolver = fn; },
        resolveApplication(fn) { applicationResolver = fn; },
        advance(ms) { now += ms; for (const fn of timers.values()) fn(); }
    };
}

const plain = value => JSON.parse(JSON.stringify(value));
function withoutPlatform(value) {
    const { platform, status_display_type, ...activity } = plain(value);
    return activity;
}

test("original sender and payload are preserved except for platform and status display", async () => {
    const h = harness();
    Object.assign(h.originalSettings.store, {
        details: "Details", state: "State", type: 0, detailsURL: "https://example.com/details",
        imageBig: "large", imageSmall: "small", imageBigTooltip: "Large image",
        buttonOneText: "Website", buttonOneURL: "https://example.com", partySize: 2, partyMaxSize: 8
    });
    await h.setRpc();
    const baseline = plain(h.activity());
    h.plus.start();
    await h.settle();
    assert.equal(Object.hasOwn(h.activity(), "platform"), false);
    assert.deepEqual(withoutPlatform(h.activity()), withoutPlatform(baseline));
    for (const platform of ["ps5", "xbox", ""]) {
        h.plusSettings.store.platform = platform;
        await h.settle();
        await h.setRpc();
        assert.deepEqual(withoutPlatform(h.activity()), withoutPlatform(baseline));
        assert.equal(h.activity().platform, platform || undefined);
    }
    assert.ok(h.events.every(event => event.socketId === "CustomRPC" || event.activity === null));
    assert.deepEqual(Array.from(h.plus.dependencies), ["CustomRPC"]);
});

test("dropdown is added to the original editor and restores on stop", async () => {
    const h = harness();
    const originalEditor = h.original.settings.def.config.component;
    h.plus.start();
    const wrapper = h.original.settings.def.config.component;
    assert.notEqual(wrapper, originalEditor);
    const children = renderRoot(wrapper()).props.children;
    assert.ok(children.some(child => child.type === originalEditor));
    const platformControl = children[0].type();
    const select = platformControl.props.children.find(node => node.type === "Select");
    assert.deepEqual(Array.from(select.props.options, option => option.value), ["", "ps5", "xbox"]);
    select.props.select("xbox");
    await h.settle();
    assert.equal(h.activity().platform, "xbox");
    h.plus.stop();
    await h.settle();
    assert.equal(h.original.settings.def.config.component, originalEditor);
    assert.equal(h.interceptors.length, 0);
});

test("other activity senders and clear events are untouched", () => {
    const h = harness("https://discord.com/games/1445160676522856458");
    h.plus.start();
    h.plusSettings.store.platform = "xbox";
    for (const socketId of ["LastFM", "CustomRPCPlus", "another-game", undefined]) {
        const activity = { name: "Other", platform: "desktop" };
        const event = { type: "LOCAL_ACTIVITY_UPDATE", socketId, activity };
        h.dispatcher.dispatch(event);
        assert.equal(event.activity, activity);
        assert.equal(activity.platform, "desktop");
    }
    const clear = { type: "LOCAL_ACTIVITY_UPDATE", socketId: "CustomRPC", activity: null };
    h.dispatcher.dispatch(clear);
    assert.equal(clear.activity, null);
    const activity = { platform: "ps5" };
    const unrelated = { type: "OTHER_EVENT", socketId: "CustomRPC", activity };
    h.dispatcher.dispatch(unrelated);
    assert.equal(unrelated.activity, activity);
});

test("interception does not mutate the original activity object", () => {
    const h = harness();
    h.plus.start();
    h.plusSettings.store.platform = "xbox";
    const activity = Object.freeze({ name: "Game", type: 0, flags: 1, platform: "ps5" });
    const event = { type: "LOCAL_ACTIVITY_UPDATE", socketId: "CustomRPC", activity };
    h.dispatcher.dispatch(event);
    assert.notEqual(event.activity, activity);
    assert.equal(event.activity.platform, "xbox");
    assert.equal(activity.platform, "ps5");
});

test("legacy platform settings use the three supported choices", async () => {
    const h = harness();
    h.plus.start();
    for (const platform of ["ps4", "ps5", "playstation"]) {
        h.plusSettings.store.platform = platform;
        await h.setRpc();
        assert.equal(h.activity().platform, "ps5");
    }
    for (const platform of ["ios", "android", "samsung", "web", "desktop", "embedded", ""]) {
        h.plusSettings.store.platform = platform;
        await h.setRpc();
        assert.equal(Object.hasOwn(h.activity(), "platform"), false);
    }
});

test("original custom timer retains its duration and rollover", async () => {
    const h = harness();
    Object.assign(h.originalSettings.store, { timestampMode: 3, startTime: 1000, endTime: 6000 });
    h.original.start();
    const nativeTimerCount = h.timers.size;
    h.plus.start();
    h.plusSettings.store.platform = "xbox";
    await h.settle();
    const first = h.activity().timestamps.start;
    assert.equal(h.activity().timestamps.end - first, 5000);
    assert.equal(h.timers.size, 1);
    h.advance(5000);
    await h.settle();
    assert.equal(h.activity().timestamps.start - first, 5000);
    assert.equal(h.activity().platform, "xbox");
    h.plus.stop();
    assert.equal(h.timers.size, nativeTimerCount);
    h.original.stop();
    assert.equal(h.timers.size, 0);
});

test("changing platform during an image lookup applies the latest choice", async () => {
    const h = harness();
    h.plus.start();
    await h.settle();
    const resolvers = [];
    h.originalSettings.store.imageBig = "slow";
    h.resolveAssets(() => new Promise(done => { resolvers.push(done); }));
    const pending = h.setRpc();
    h.plusSettings.store.platform = "xbox";
    resolvers.forEach(resolve => resolve(["asset:slow"]));
    await pending;
    assert.equal(h.activity().platform, "xbox");
    assert.equal(h.activity().assets.large_image, "asset:slow");
});

test("stop restores the original sender behavior without changing its settings", async () => {
    const h = harness();
    await h.setRpc();
    const nativePlatform = h.activity().platform;
    const originalSettings = plain(h.originalSettings.store);
    h.plus.start();
    h.plusSettings.store.platform = "xbox";
    await h.settle();
    assert.equal(h.activity().platform, "xbox");
    h.plus.stop();
    await h.settle();
    assert.deepEqual(plain(h.originalSettings.store), originalSettings);
    assert.equal(h.activity().platform, nativePlatform);
    h.plus.start();
    await h.settle();
    assert.equal(h.interceptors.length, 1);
    assert.equal(h.activity().platform, "xbox");
    h.plus.stop();
});

function descendants(node) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(descendants);
    if (typeof node.type === "function") return descendants(node.type(node.props));
    return [node, ...descendants(node.props?.children)];
}

function renderRoot(node) {
    return typeof node.type === "function" ? renderRoot(node.type(node.props)) : node;
}

test("the original preview follows every platform without changing its activity data", async () => {
    const h = harness();
    Object.assign(h.originalSettings.store, { details: "Preview details", state: "Preview state", imageBig: "large" });
    await h.setRpc();
    const source = Object.freeze({ ...h.activity() });
    const nativePlatform = source.platform;
    h.setPreview(source);
    const originalAbout = h.original.settingsAboutComponent;
    const paragraphs = descendants(originalAbout()).filter(node => node.type === "Paragraph").map(node => plain(node.props));
    h.plus.start();
    for (const platform of ["xbox", "ps5", ""]) {
        h.plusSettings.store.platform = platform;
        const tree = descendants(h.original.settingsAboutComponent());
        const preview = tree.find(node => node.type === "ActivityView");
        assert.ok(preview);
        assert.equal(preview.props.activity.platform, platform || undefined);
        assert.deepEqual(withoutPlatform(preview.props.activity), withoutPlatform(source));
        assert.deepEqual(tree.filter(node => node.type === "Paragraph").map(node => plain(node.props)), paragraphs);
        assert.equal(source.platform, nativePlatform);
    }
    h.plus.stop();
    assert.equal(h.original.settingsAboutComponent, originalAbout);
    const restored = descendants(originalAbout()).find(node => node.type === "ActivityView");
    assert.equal(restored.props.activity, source);
});

test("an empty preview is safe and the settings panel is restored after repeated toggles", () => {
    const h = harness();
    const originalAbout = h.original.settingsAboutComponent;
    for (let i = 0; i < 2; i++) {
        h.plus.start();
        assert.equal(descendants(h.original.settingsAboutComponent()).some(node => node.type === "ActivityView"), false);
        h.plus.stop();
        assert.equal(h.original.settingsAboutComponent, originalAbout);
    }
});

test("Plus credits only the requested Discord account in plugin metadata", () => {
    const h = harness();
    assert.equal(h.plus.authors.length, 1);
    assert.equal(h.plus.authors[0].id, 801514233010847784n);
    assert.equal(h.original.authors.length, 4);
});

test("game page links and game IDs are validated without accepting other URLs", () => {
    const h = harness();
    const validate = h.plusSettings.def.gameProfile.isValid;
    for (const input of ["", "  ", "1445160676522856458", "https://discord.com/games/1445160676522856458",
        "https://discord.com/game/grand-theft-auto-vi-1445160676522856458"]) {
        assert.equal(validate(input), true, input);
    }
    for (const input of ["123", "https://example.com/games/1445160676522856458",
        "https://discord.com.evil.test/games/1445160676522856458", "http://discord.com/games/1445160676522856458",
        "https://discord.com/servers/1445160676522856458", "javascript:alert(1)", "GTA VI"]) {
        assert.notEqual(validate(input), true, input);
    }
    assert.equal(h.plusSettings.def.gameProfile.default, "https://discord.com/games/1445160676522856458");
});

test("linking a game sends its real application ID and preserves custom artwork", () => {
    const h = harness("https://discord.com/games/1445160676522856458");
    h.plus.start();
    h.plusSettings.store.platform = "xbox";
    const assets = Object.freeze({
        large_image: "12345678901234568", small_image: "mp:external/existing/image.png",
        large_text: "Artwork", small_text: "Small", large_url: "https://example.com/old-link",
        small_url: "https://example.com/small-link"
    });
    const source = Object.freeze({ name: "Grand Theft Auto VI", application_id: "12345678901234567",
        type: 0, flags: 1, details: "Free roam", assets, buttons: ["Website"], metadata: { button_urls: ["https://example.com"] } });
    const event = { type: "LOCAL_ACTIVITY_UPDATE", socketId: "CustomRPC", activity: source };
    h.dispatcher.dispatch(event);
    assert.equal(event.activity.application_id, "1445160676522856458");
    assert.equal(event.activity.platform, "xbox");
    assert.equal(event.activity.assets.large_image, "mp:app-assets/12345678901234567/12345678901234568.png");
    assert.equal(event.activity.assets.small_image, assets.small_image);
    assert.equal(event.activity.assets.large_text, "Artwork");
    assert.equal(event.activity.assets.large_url, undefined);
    assert.equal(event.activity.assets.small_url, undefined);
    assert.equal(event.activity.metadata, source.metadata);
    assert.equal(event.activity.buttons, source.buttons);
    assert.equal(event.activity.details, source.details);
    assert.equal(source.application_id, "12345678901234567");
    assert.equal(source.assets, assets);
    assert.equal(assets.large_url, "https://example.com/old-link");
});

test("linked game artwork is not rewritten when it belongs to the selected game", () => {
    const h = harness("1445160676522856458");
    h.plus.start();
    const event = { type: "LOCAL_ACTIVITY_UPDATE", socketId: "CustomRPC", activity: {
        application_id: "1445160676522856458", assets: { large_image: "12345678901234568", small_image: "12345678901234569" }
    } };
    h.dispatcher.dispatch(event);
    assert.equal(event.activity.assets.large_image, "12345678901234568");
    assert.equal(event.activity.assets.small_image, "12345678901234569");
});

test("preview and outgoing activity use the same linked game ID and clearing restores the original", async () => {
    const h = harness();
    await h.setRpc();
    const source = Object.freeze({ ...h.activity(), assets: Object.freeze({ small_image: "12345678901234569" }) });
    h.setPreview(source);
    h.plus.start();
    h.plusSettings.store.gameProfile = "https://discord.com/games/1445160676522856458";
    h.plusSettings.store.platform = "ps5";
    await h.settle();
    let preview = descendants(h.original.settingsAboutComponent()).find(node => node.type === "ActivityView");
    assert.equal(preview.props.activity.application_id, h.activity().application_id);
    assert.equal(preview.props.activity.application_id, "1445160676522856458");
    assert.equal(preview.props.activity.assets.small_image, "mp:app-assets/12345678901234567/12345678901234569.png");
    h.plusSettings.store.gameProfile = "";
    await h.settle();
    preview = descendants(h.original.settingsAboutComponent()).find(node => node.type === "ActivityView");
    assert.equal(preview.props.activity.application_id, source.application_id);
    assert.equal(h.activity().application_id, source.application_id);
    assert.equal(preview.props.activity.assets, source.assets);
    h.plus.stop();
});

test("the game profile input commits valid links and supports clearing", () => {
    const h = harness();
    h.plus.start();
    const wrapper = renderRoot(h.original.settings.def.config.component());
    const field = wrapper.props.children.find(node => node.type.name === "GameProfileSetting");
    const input = descendants(field.type()).find(node => node.type === "TextInput");
    assert.ok(input);
    input.props.onChange("https://example.com/not-a-game");
    assert.equal(h.plusSettings.store.gameProfile, "");
    input.props.onChange("https://discord.com/games/1445160676522856458");
    assert.equal(h.plusSettings.store.gameProfile, "https://discord.com/games/1445160676522856458");
    input.props.onChange("");
    assert.equal(h.plusSettings.store.gameProfile, "");
});

test("missing artwork is loaded from the game and appears in the sender and preview", async () => {
    const h = harness("https://discord.com/games/1445160676522856458");
    const source = Object.freeze({ application_id: "12345678901234567", name: "My game", type: 0, flags: 1 });
    h.setPreview(source);
    h.resolveApplication(async id => ({ id, name: "Grand Theft Auto VI", icon: "game-artwork" }));
    h.plus.start();
    await h.settle();
    const expected = "mp:app-icons/1445160676522856458/game-artwork.png";
    assert.equal(h.activity().assets.large_image, expected);
    assert.equal(h.activity().assets.large_text, "Grand Theft Auto VI");
    const preview = descendants(h.original.settingsAboutComponent()).find(node => node.type === "ActivityView");
    assert.equal(preview.props.activity.assets.large_image, expected);
    assert.equal(source.assets, undefined);
    assert.equal(h.applicationRequests.length, 1);
});

test("a configured custom image wins over game artwork", async () => {
    const h = harness("1445160676522856458");
    h.applications.set("1445160676522856458", { id: "1445160676522856458", name: "Game", icon: "official-icon" });
    h.originalSettings.store.imageBig = "my-picture";
    h.plus.start();
    await h.settle();
    assert.equal(h.activity().assets.large_image, "asset:my-picture");
    assert.equal(h.applicationRequests.length, 0);
});

test("fallback artwork keeps the configured small image and tooltip", async () => {
    const h = harness("1445160676522856458");
    h.applications.set("1445160676522856458", { id: "1445160676522856458", name: "Game", icon: "official-icon" });
    h.plus.start();
    const event = { type: "LOCAL_ACTIVITY_UPDATE", socketId: "CustomRPC", activity: {
        application_id: "12345678901234567", assets: { small_image: "mp:external/my-small.png", large_text: "My tooltip" }
    } };
    h.dispatcher.dispatch(event);
    assert.equal(event.activity.assets.large_image, "mp:app-icons/1445160676522856458/official-icon.png");
    assert.equal(event.activity.assets.small_image, "mp:external/my-small.png");
    assert.equal(event.activity.assets.large_text, "My tooltip");
});

test("missing game artwork does not break the original presence", async () => {
    const h = harness("1445160676522856458");
    h.resolveApplication(async id => ({ id, name: "No icon", icon: null }));
    h.plus.start();
    await h.settle();
    assert.equal(h.activity().name, "Original game");
    assert.equal(h.activity().assets, undefined);
    assert.equal(h.errors.length, 0);
});

test("a late game image lookup cannot refresh a stopped add-on", async () => {
    const h = harness("1445160676522856458");
    let resolve;
    h.resolveApplication(() => new Promise(done => { resolve = done; }));
    h.plus.start();
    await h.settle();
    assert.equal(h.applicationRequests.length, 1);
    h.plus.stop();
    await h.settle();
    const count = h.events.length;
    resolve({ id: "1445160676522856458", name: "Game", icon: "late-icon" });
    await h.settle();
    assert.equal(h.events.length, count);
    assert.equal(h.activity().application_id, "12345678901234567");
});

test("an artwork lookup failure is logged once and does not interrupt the presence", async () => {
    const h = harness("1445160676522856458");
    h.resolveApplication(async () => { throw new Error("Not available"); });
    h.plus.start();
    await h.settle();
    await h.setRpc();
    await h.settle();
    assert.equal(h.errors.length, 1);
    assert.equal(h.applicationRequests.length, 1);
    assert.equal(h.activity().application_id, "1445160676522856458");
    assert.equal(h.activity().name, "Original game");
});

test("status display choices are sent and previewed, including Application Name zero", async () => {
    const h = harness();
    h.setPreview({ name: "Game", type: 0, flags: 1, state: "Lobby", details: "Free roam" });
    h.plus.start();
    for (const value of [2, 1, 0]) {
        const field = h.renderEditor().find(node => node.type === "Select"
            && node.props.options?.some(option => option.label === "Application Name"));
        assert.ok(field);
        field.props.select(value);
        await h.settle();
        assert.equal(h.activity().status_display_type, value);
        const preview = descendants(h.original.settingsAboutComponent()).find(node => node.type === "ActivityView");
        assert.equal(preview.props.activity.status_display_type, value);
        assert.equal(h.plusSettings.store.statusDisplayType, value);
    }
});

async function savePreset(h, name) {
    await h.loadCompletePresets(h.plusOptions());
    let nodes = h.renderEditor();
    nodes.find(node => node.type === "TextInput" && node.props.placeholder === "Complete preset name").props.onChange(name);
    nodes = h.renderEditor();
    await nodes.find(node => node.type === "Button" && node.props.children === "Save Complete Preset").props.onClick();
}

async function loadPreset(h, name) {
    await h.loadCompletePresets(h.plusOptions());
    let nodes = h.renderEditor();
    nodes.find(node => node.type === "Select" && node.props.placeholder === "Select a complete preset").props.select(name);
    nodes = h.renderEditor();
    nodes.find(node => node.type === "Button" && node.props.children === "Load Complete Preset").props.onClick();
}

test("complete preset buttons save and restore every CustomRPC field and Plus option", async () => {
    const h = harness();
    h.plus.start();
    const originalValues = {
        appID: "12345678901234567", appName: "Saved game", details: "Mission", detailsURL: "https://example.com/details",
        state: "Lobby", stateURL: "https://example.com/state", type: 0, streamLink: "https://twitch.tv/example",
        timestampMode: 3, startTime: 1000, endTime: 6000, imageBig: "cover", imageBigURL: "https://example.com/cover",
        imageBigTooltip: "My cover", imageSmall: "small", imageSmallURL: "https://example.com/small", imageSmallTooltip: "Small image",
        buttonOneText: "Website", buttonOneURL: "https://example.com/one", buttonTwoText: "Second", buttonTwoURL: "https://example.com/two",
        partySize: 2, partyMaxSize: 8, enablePresence: true
    };
    Object.assign(h.originalSettings.store, originalValues);
    Object.assign(h.plusSettings.store, { platform: "xbox", gameProfile: "https://discord.com/games/1445160676522856458", statusDisplayType: 2 });
    await savePreset(h, "Complete");
    const saved = h.data.get(h.COMPLETE_PRESETS_KEY)[0];
    const plus = saved.config.plus;
    assert.equal(plus.platform, "xbox");
    assert.equal(plus.statusDisplayType, 2);
    assert.equal(plus.gameProfile, "https://discord.com/games/1445160676522856458");
    Object.assign(h.originalSettings.store, { appName: "Changed", details: "Changed", imageBig: "", partySize: 1, timestampMode: 0 });
    Object.assign(h.plusSettings.store, { platform: "ps5", gameProfile: "", statusDisplayType: 0 });
    await h.settle();
    const eventStart = h.events.length;
    await loadPreset(h, "Complete");
    await h.settle();
    assert.ok(h.events.slice(eventStart).filter(event => event.activity).every(event => event.activity.details === "Mission"));
    for (const [key, value] of Object.entries(originalValues)) assert.equal(h.originalSettings.store[key], value, key);
    assert.equal(h.plusSettings.store.platform, "xbox");
    assert.equal(h.plusSettings.store.statusDisplayType, 2);
    assert.equal(h.plusSettings.store.gameProfile, plus.gameProfile);
    h.renderEditor();
    const field = h.renderEditor().find(node => node.type === "TextInput" && node.props.placeholder === "Discord game page URL or game Application ID");
    assert.equal(field.props.value, plus.gameProfile);
    assert.equal(h.activity().status_display_type, 2);
    assert.equal(h.activity().platform, "xbox");
    assert.equal(h.activity().name, "Saved game");
});

test("a complete preset survives a new plugin session and restores empty links and status zero", async () => {
    const first = harness();
    first.plus.start();
    first.plusSettings.store.statusDisplayType = 0;
    await savePreset(first, "Plain");
    const stored = structuredClone(first.data.get(first.COMPLETE_PRESETS_KEY));
    first.plus.stop();
    const next = harness("https://discord.com/games/1445160676522856458");
    next.data.set(next.COMPLETE_PRESETS_KEY, stored);
    next.plus.start();
    next.plusSettings.store.platform = "xbox";
    next.plusSettings.store.statusDisplayType = 2;
    await loadPreset(next, "Plain");
    await next.settle();
    assert.equal(next.plusSettings.store.gameProfile, "");
    assert.equal(next.plusSettings.store.platform, "");
    assert.equal(next.plusSettings.store.statusDisplayType, 0);
    assert.equal(next.activity().status_display_type, 0);
    assert.equal(next.activity().application_id, "12345678901234567");
    assert.equal(next.activity().platform, undefined);
    const listener = next.settingListeners.get("plugins.CustomRPC.customRPCPlus");
    assert.equal(listener.size, 1);
    next.plus.stop();
    assert.equal(listener.size, 0);
    assert.equal(next.originalSettings.store.customRPCPlus, undefined);
});

test("old CustomRPC presets remain usable and keep the current Plus settings", async () => {
    const h = harness();
    h.data.set("CustomRPC_presets", [{ name: "Legacy", config: { appName: "Old game", details: "Old details" } }]);
    h.plus.start();
    Object.assign(h.plusSettings.store, { platform: "xbox", statusDisplayType: 1 });
    await loadPreset(h, "Legacy");
    await h.settle();
    assert.equal(h.originalSettings.store.appName, "Old game");
    assert.equal(h.originalSettings.store.details, "Old details");
    assert.equal(h.plusSettings.store.platform, "xbox");
    assert.equal(h.plusSettings.store.statusDisplayType, 1);
    await savePreset(h, "Legacy");
    assert.equal(h.data.get(h.COMPLETE_PRESETS_KEY).length, 1);
    assert.equal(h.data.get(h.COMPLETE_PRESETS_KEY)[0].config.plus.statusDisplayType, 1);
    assert.equal(h.data.get("CustomRPC_presets")[0].config.customRPCPlus, undefined);
});

test("damaged Plus preset metadata cannot replace valid current options", () => {
    const h = harness();
    h.plus.start();
    h.plusSettings.store.statusDisplayType = 2;
    for (const value of ["invalid JSON", "null", "{}", JSON.stringify({ platform: "xbox", gameProfile: "", statusDisplayType: 99 })]) {
        h.originalSettings.store.customRPCPlus = value;
        assert.equal(h.plusSettings.store.statusDisplayType, 2);
        assert.equal(h.plusSettings.store.platform, "");
    }
});

test("existing Equicord and standalone Plus presets are imported without changing the originals", async () => {
    const h = harness();
    const original = [{ name: "Shared", config: {
        appName: "Original", details: "Mission", customRPCPlus: JSON.stringify({ platform: "xbox", gameProfile: "", statusDisplayType: 1 })
    } }];
    const standalone = [
        { name: "Shared", config: { appName: "Do not overwrite" } },
        { name: "Standalone", config: { appName: "Old Plus", platform: "ps5", statusDisplayType: 2 } }
    ];
    h.data.set("CustomRPC_presets", structuredClone(original));
    h.data.set("CustomRPCPlus_presets", structuredClone(standalone));
    const imported = await h.loadCompletePresets(h.plusOptions());
    assert.equal(imported.length, 2);
    assert.equal(imported.find(preset => preset.name === "Shared").config.rpc.appName, "Original");
    assert.equal(imported.find(preset => preset.name === "Shared").config.plus.statusDisplayType, 1);
    assert.equal(imported.find(preset => preset.name === "Standalone").config.plus.platform, "ps5");
    assert.deepEqual(h.data.get("CustomRPC_presets"), original);
    assert.deepEqual(h.data.get("CustomRPCPlus_presets"), standalone);
});

test("deleting the last complete preset does not automatically import it again", async () => {
    const h = harness();
    h.data.set("CustomRPC_presets", [{ name: "Old", config: { appName: "Game" } }]);
    h.plus.start();
    await h.loadCompletePresets(h.plusOptions());
    let nodes = h.renderEditor();
    nodes.find(node => node.type === "Select" && node.props.placeholder === "Select a complete preset").props.select("Old");
    nodes = h.renderEditor();
    await nodes.find(node => node.type === "Button" && node.props.children === "Delete Complete Preset").props.onClick();
    assert.equal(h.data.get(h.COMPLETE_PRESETS_KEY).length, 0);
    assert.equal((await h.loadCompletePresets(h.plusOptions())).length, 0);
    assert.equal(h.data.get("CustomRPC_presets").length, 1);
});

test("copying legacy presets preserves complete presets with matching names", async () => {
    const h = harness();
    h.plus.start();
    h.originalSettings.store.appName = "Keep this game";
    await savePreset(h, "Shared");
    h.data.set("CustomRPC_presets", [
        { name: "Shared", config: { appName: "Wrong game" } },
        { name: "New", config: { appName: "Imported game" } }
    ]);
    const nodes = h.renderEditor();
    await nodes.find(node => node.type === "Button" && node.props.children === "Copy Existing Presets").props.onClick();
    const saved = h.data.get(h.COMPLETE_PRESETS_KEY);
    assert.equal(saved.length, 2);
    assert.equal(saved.find(preset => preset.name === "Shared").config.rpc.appName, "Keep this game");
    assert.equal(saved.find(preset => preset.name === "New").config.rpc.appName, "Imported game");
});

test("legacy native Equicord preset controls still restore Plus metadata", { skip: !nativePresetsAvailable }, async () => {
    const h = harness();
    h.plus.start();
    Object.assign(h.plusSettings.store, { platform: "xbox", statusDisplayType: 2 });
    let nodes = h.renderEditor();
    nodes.find(node => node.type === "TextInput" && node.props.placeholder === "Preset name").props.onChange("Native");
    nodes = h.renderEditor();
    await nodes.find(node => node.type === "Button" && node.props.children === "Save").props.onClick();
    h.plusSettings.store.platform = "ps5";
    h.plusSettings.store.statusDisplayType = 0;
    nodes = h.renderEditor();
    nodes.find(node => node.type === "Button" && node.props.children === "Load").props.onClick();
    await h.settle();
    assert.equal(h.plusSettings.store.platform, "xbox");
    assert.equal(h.plusSettings.store.statusDisplayType, 2);
});
