Caden made visible — a warm, organic blob that breathes and morphs; use it as the brand's living anchor on any canvas, hero, or chat surface.

```jsx
<PresenceOrb size={200} state="listening" />
```

States: `idle` (slow breathe + 14s morph), `listening` (tighter pulse + emitted ripple rings), `thinking` (faster breathe + visible rotating sheen), `speaking` (brighter glow). All motion runs off the global `caden-*` keyframes and collapses to a static blob under `prefers-reduced-motion`. Pass `showLabel` for the mono caption. To make it drift across a canvas, animate the orb's wrapper `transform` with `--ease` over `--dur-drift`.
