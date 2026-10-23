# CLI mobile readability

The UI uses self-hosted Inter from `@fontsource/inter@5.2.8`. Font files, the
original OFL-1.1 license, and provenance are in `public/fonts/inter/`. Unicode
subsets load on demand. Code and the terminal retain their monospace fonts.

| Setting | Before this change | After |
| --- | --- | --- |
| Chat text | 14 px | 16 px |
| Chat line height | Prose small: about 24 px | 24 px (1.5) |
| Composer text | 14 px | 16 px, 24 px line height |
| Mobile form text | Some 14 px fields | At least 16 px |
| Highlighted code | 13 px | 14 px, 22.4 px line height |
| Message gap | 12 px mobile / 16 px desktop | 24 px |
| Transcript maximum width | 868 px | 768 px |
| Mobile user bubble | 85% of available width | Full available width |
| Small icon controls | Some 20–32 px | At least 44 × 44 px |

Long URLs wrap. Code preserves indentation and scrolls horizontally inside its
panel; tables have minimum column widths and their own horizontal scroll area.
Pinch zoom is enabled. Placeholder text uses the theme's muted foreground color.
Small syntax colors were adjusted for at least 4.5:1 contrast on the light muted
and dark zinc panels; the orange link shade was darkened for light mode.

The display name is CLI across web/PWA, auth, notifications, standalone pages,
and Electron. Every sidebar locale includes the exact attribution
“CLI · a modification of CloudCLI v1.37.5 - Open Source”, linked from the footer to
https://github.com/siteboon/claudecodeui. The service worker cache version changed
so installed PWAs refresh their manifest.

## Verification (2026-10-23)

- Chromium at 360 × 800, light and dark: actual login, setup, and workspace views;
  rendered transcript components with paragraphs, accents, long URLs, code and tables.
  Inputs measured 16 px, login/setup fields 46 px tall, transcript buttons at least
  44 px, and no document overflow at 360 px. Inter loaded from the local origin.
- `npm run test:client`: 106 files, 744 tests passed.
- Backend: 727 passed, one skipped across two isolated runs. Plain `npm test`
  initially had two failures because the environment injects `/tmp/.git`, which
  changes the topmost repository root in skill fixtures. Running the other 722
  tests normally gave 721 passed and one skipped; the six skill tests passed with
  a temporary directory whose ancestry excludes that injected marker. No
  application code was changed to accommodate the test environment.
- `npm run build`, `npm run typecheck`, `npm run lint`: passed. The build retains
  the existing large-chunk warnings; lint reports existing repository warnings.

Pre-existing uncommitted feature and branding work was preserved.
