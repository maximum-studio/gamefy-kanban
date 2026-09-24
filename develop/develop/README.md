# Gamefy Kanban

Team kanban board. A static page on GitHub Pages, data lives in Supabase.

## Links

| Environment | Branch | URL |
| --- | --- | --- |
| **PROD** | `main` (root) | https://maximum-studio.github.io/gamefy-kanban/gamefy-kanban.html |
| **DEV** | `develop` → `main/develop` | https://maximum-studio.github.io/gamefy-kanban/develop/gamefy-kanban.html |

## Structure

| File | What is inside |
| --- | --- |
| `gamefy-kanban.html` | Markup only: `<head>`, the SVG icon sprite, the board, modals, overlays and the `<template>` blocks |
| `styles.css` | All styles: the Onest font import, theme CSS variables, components, media queries |
| `app.js` | All logic: Supabase config, auth, loading and rendering the board, drag & drop, modals |

## Deploy

DEV deploys automatically: a push to `develop` triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which copies the
branch contents into the `develop/` folder of `main`.

PROD is the root of `main` and is updated manually (merge `develop` → `main`).

## Cache

The HTML carries `no-cache` meta tags, but they do not apply to the external
`styles.css` and `app.js`. That is why `gamefy-kanban.html` loads them with a
version:

```html
<link rel="stylesheet" href="styles.css?v=1">
<script src="app.js?v=1"></script>
```

**After editing CSS or JS, bump the version number** (`?v=2`, `?v=3`, …), or
users may keep the stale file from their browser cache.
