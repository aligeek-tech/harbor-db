# Harbor DB design

The visual reference is [harbor-concept.png](harbor-concept.png), generated before implementation and selected as the working direction. The interface is built from real HTML, React components, Monaco and TanStack; the reference is not displayed as the application UI.

## Design brief

A calm desktop workbench for developers who spend long sessions inspecting data. Keep the workspace dense and useful: a compact toolbar, a 248 px connection explorer, persistent context-bound tabs, a modest query editor, a wide results table and an optional cell inspector. Prioritize legibility and trustworthy target/status information over decoration.

Use deep graphite surfaces, restrained periwinkle actions, quiet dividers, a native sans-serif stack and locally bundled JetBrains Mono. Engine colors and environment badges have text/icon labels. Use a 4 px spacing base, 6–10 px radii, visible keyboard focus, and restrained transitions that respect reduced-motion settings. Keep onboarding separate from active database views. Light mode uses soft neutral surfaces and coordinated blue accents.

## Image concept prompt specification

Design a high-fidelity desktop database application called Harbor DB at approximately 1440×900. Show a complete active SQL workbench: small anchor brand and command search in the top bar, a narrow saved-connections sidebar with PostgreSQL, MariaDB and Redis, an expanded database object tree, a persistent query tab strip, a visible local database and read-only context, syntax-highlighted SQL in a restrained-height editor, Run and cancel controls, result-set tabs, and a dense customer table with exact readable values. Include a slim cell inspector and a quiet bottom status bar. Use main background #101318, sidebar #151A21, raised surfaces #1B222C, border #2B3543, primary text #E8EDF5, secondary text #A8B4C4 and accent #7C9CFF. Professional native developer-tool styling, precise alignment, compact 13–14 px typography, crisp icons, ample useful grid space, no decorative hero images or oversized cards.

## Implementation choices

- Tokens, restrained controls and the editor-over-results composition follow the reference.
- The operating system supplies real window controls and menus. No decorative imitation controls appear in the renderer.
- Real sessions include transaction, write-safeguard and transport controls; these take precedence over matching every reference label.
- Demo content is explicitly marked and execution is disabled. Live result counts and durations come from database responses.
- At 1024×700 the optional inspector collapses; grid overflow stays within the grid, and long dialogs scroll with their action footer visible.
- The sidebar and editor split can be resized with a pointer or keyboard; dimensions persist independently of connections.

Actual dark/light/compact screenshots and visual comparisons are recorded in [VALIDATION.md](../VALIDATION.md).
