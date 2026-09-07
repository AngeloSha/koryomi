# Configuration

Every setting is an environment variable in `.env`, and `.env.example` is the authoritative list — if the two
ever disagree, `.env.example` is right and this page is stale.

## Environment variables

The ones worth knowing:

- `LIBRARY_BACKEND`: `owned` (read your CBZ library, default) or `komga` (read from a Komga server).
- `LIBRARY_PATH`: host path to your CBZ library (mounted at `/library`).
- `PUID` / `PGID`: run as the user that owns your library, so file operations work. Unset means the app runs
  as its own uid and treats your library as read-only.
- `SOURCES_PATH`: host path to a built source pack (empty by default = no sources).
- `WEB_PORT`: host port the app is published on — `8080` everywhere. (`SPLIT_WEB_PORT`, default `8081`, is
  the split's own port under `--profile split`, so both can run side by side.)
- `PUBLIC_ORIGIN`: the URL the app is served from (match your domain behind a reverse proxy).


## Sources

This section covers one of the two fetch routes: the **generic engines**. The other, and the one most people
will use, is the one-click extension catalogue described under
[Mihon / Tachiyomi extensions](#features) and in [docs/extensions.md](extensions.md).

Uchiyomi bundles a few **generic engines** (parsers for the common manga-site families: Madara /
MangaThemesia / Manganato) but **no specific sites for them**. Along this route, nothing fetches anything
until *you* add a site:

**Admin → Providers → Add a site:** pick the engine, paste a site's homepage URL, done. It loads instantly
(no rebuild). The engines are generic parsers; you supply the URLs, and you're responsible for using them in
line with those sites' terms and your local law.

A handful of one-off, site-specific sources (e.g. an official API client) aren't engines and aren't bundled.
Nothing is published for you to drop in — the loader will register any compiled CommonJS plugin you build
yourself against the contract in [`bff/src/lib/sources/loader.ts`](../bff/src/lib/sources/loader.ts), mounted
read-only:

```bash
# .env
SOURCES_PATH=/path/to/your/plugins/dist     # compiled .js plugins, mounted read-only at /sources
```

The reader scans `SOURCES_DIR` (`/sources`) at boot and registers every plugin it finds. Drop in or update a
plugin and hit **Admin → Providers → Reload** (`POST /api/admin/sources/reload`); no rebuild. With no sites
added, no extensions installed and no pack mounted, Uchiyomi is just a clean reader for the library you
already own.
