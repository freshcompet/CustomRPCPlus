# Compatibility verification

Verified on 2026-11-26 with the same CustomRPCPlus source files in both checkouts.

## Vencord

- Version: 1.15.19.
- Upstream revision: `d086992fb674299a2fa05ac6432edc3a777389f3`.
- Dependencies installed using its lockfile.
- `pnpm build --dev`: passed.
- `pnpm test:ts`: passed.
- Plugin lint: passed.
- Integration tests: 30 passed; the Equicord native preset UI test was skipped because stock Vencord has no such controls.

## Equicord

- User checkout version: 1.15.18.2.
- Base revision: `8d63e9694b2ef5195806b3f8b2e03135a4b4ea2c`.
- The user's original CustomRPC source, including its PS5 edit and custom timer, was retained.
- `pnpm build`: passed.
- Plugin lint: passed.
- Integration tests: 31 passed.
- Full repository type checking retains the existing error in built-in CustomRPC: `platform: "ps5"` is outside its declared platform type. No CustomRPCPlus type errors remain.

## Scope of verification

The integration tests bundle each checkout's real CustomRPC implementation with mocked Discord services. They verify platforms, game identity, image fallback and priority, status display values, preview updates, repeating custom timestamps, complete preset saving/loading, legacy migration and cleanup.

The author supplied live Equicord screenshots of the console presence, Plus settings and native game page. They are included in `docs/screenshots`.

The Vencord build was tested in an isolated checkout. It was not installed over the author's running Equicord client. Live rendering and native game icon navigation in Vencord must still be checked after installing that build. Discord server acceptance and rendering can vary across versions and viewers.

To use complete saving in either client, open CustomRPC settings and use the **Complete Presets** section provided by Plus. Existing Equicord native preset controls remain supported.
