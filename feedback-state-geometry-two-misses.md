# Two real state-shift bugs `fr --state-geometry` missed, and why

Field report from running the scan over a real codebase (midjourney/mj-gallery, branch
`proto-kit-adoption`, `prototype/` app). A user reported two layout bugs by feel; both are
textbook state-shift bugs — finite content states whose geometries disagree — and the scan
caught **neither**, while catching eight other shift-class findings in the *same files*. The
misses are model-scope boundaries, not implementation bugs, and both sit one step past the
current syntax domain. Repro trees: buggy code at commit `8520ff59bd`, fixes at `9dbfca954e`
(that diff is a precise spec of both bugs).

## What the scan got right (the boundary, from the catching side)

`bun fr.ts --state-geometry --json` from `prototype/`: 58 findings (8 shift, 7 motion,
37 unclear, 6 config), coverage 66. In the two files hosting the missed bugs it DID flag:

- `PromptBar.jsx:112` [shift] "left inset -6px" — a className-conditional inset.
- `Pill.jsx:141` [unclear] "display 'none' vs 'inline-flex', gap 'none' vs '4px'".
- `StylesBrowser.jsx:1599` [unclear] "±1px insets".

Hover-overlay reveals throughout classified as motion, correctly. So the extraction,
severity model, and overlay/transform demotion all worked as designed; the misses below are
about what never entered the model.

## Miss 1: conditional geometry in a `style` attribute, with a data-driven branch

`StylesBrowser.jsx` (`SrefThumb`, ~line 153 at `8520ff59bd`; same pattern in
`RelatedStyleCard` ~1396):

```jsx
const containerAspectRatio =
  (previewUrl || previewLoading) && previewAspectRatio ? previewAspectRatio : '16/9'
...
<div style={{ aspectRatio: containerAspectRatio }}>
  {previewUrl ? <img .../> : previewLoading ? <skeleton/> : <StyleFilmstrip/>}
```

The discriminants (`previewUrl`, `previewLoading`) flip on hover-enqueue while mounted —
severity would be `shift`. Selecting the loading state snapped the tile from 16/9 to the
preview's AR and reflowed a masonry column. The user's symptom verbatim: "mouse over a style
in the sidebar, it's replaced with a skeleton of the wrong size and it reflows the masonry."

Why it was missed — two independent gaps:

1. **Syntax domain**: the scan extracts branches of conditional *className* expressions.
   This state lives in a ternary feeding an inline `style={{...}}` value. Style-attribute
   conditionals never enter branch extraction, and (as far as the CLI JSON surfaces) produce
   no coverage record either — the gap is silent at the report surface.
2. **Data-driven branch value**: one branch is `'16/9'` (a literal), the other is
   `previewAspectRatio` (a runtime prop). The *value* is unknowable statically — but the
   *claim* is still decidable: "branches disagree on aspect-ratio unless `previewAspectRatio`
   proves equal to `'16/9'`". That's the same shape as the existing categorical findings
   (`magnitudePx: null`). The finding is the branch disagreement, not the delta.

Suggested extension: branch-extract conditional expressions inside `style` object literals
for a small family list — `aspectRatio`, `width`/`height`, insets, `display`, `position` —
treating literal-vs-literal as quantifiable, literal-vs-dynamic as categorical
("differs unless proven equal"), dynamic-vs-dynamic as a coverage record (a new
`dynamicStylePart` reason alongside `dynamicClassPart`). Note `aspectRatio` itself likely
needs adding to the geometry families: it couples inline size to block size, so it is a
reflow lever even though no length token changes.

## Miss 2: inline-level box taller than its line's strut (line-box growth)

`index.css` at `8520ff59bd`:

```css
.prompt-editable { line-height: 1.625; }        /* prose: 15px font -> 24.4px strut */
.pill--prompt-bar { padding: 2px 4px 2px 10px; font-size: 13px; }
                                                /* inherits 1.625 -> 21.1px label line
                                                   + 4px padding = 25.1px capsule */
```

A 25.1px inline-flex capsule inside a 24.4px strut: every pill add/remove grew/shrank the
line box (~±1px measured), hopping the input's baseline; baseline alignment also hung the
capsule's padding + descent below the prose baseline (the "not vertically centered" half of
the report). All the constants — 15px, 13px, 1.625, 2px — are statically readable. The state
space is the content states of the editable: {empty, text, pill, text+pill}.

Why it was missed — three gaps in increasing depth:

1. **Plain CSS classes are opaque tokens.** The scan evaluates Tailwind-ish utility tokens;
   `.pill--prompt-bar`'s geometry lives in a stylesheet the scan never reads, so the capsule
   has no height in the model at all.
2. **The discriminant isn't a className conditional.** The state is the presence/absence of
   an inline *child element* in a text context — closer to the JSX-alternatives evaluation
   the static evaluator does for `intrinsicBlockSize` than to the className scan.
3. **No inline-formatting model.** The claim needs line-box math: strut = font-size ×
   line-height; an inline-level box participates via its margin-box height and
   vertical-align; "capsule fits strut" ⇔ above/below-baseline extents both fit. That is a
   genuinely new claim type — call it **line-box containment**: "an inline-level box whose
   height exceeds its formatting context's strut grows the line when present; prove
   height ≤ strut or mean the shift."

Honest scoping note: (3) may not belong in a syntax-only advisory scan at all. It might fit
better as an `fr --layout` claim (the constants are all evaluable once CSS class geometry
resolution exists), or even as a framecheck *rendered* check with state-toggled captures.
But it's worth recording that everything needed was constant — no runtime data — so it is
inside the static-discernibility frontier even if outside this particular scan's charter.
The fix that follows from the claim is exactly the reserving-geometry doctrine the scan
already preaches: `line-height: 18px` (22px capsule ≤ 24.4px strut) + `vertical-align:
middle`, measured hop 0.00px after.

## Postscript: the "third bug" was the same claim class

A one-time −0.63px settle when the *first* pill ever enters the contenteditable was
initially dismissed as a DOM-rebuild artifact. Root-caused, it turned out to be **two more
instances of line-box containment**: (a) a caret-landing span (`min-height: 1.625em`,
`vertical-align: middle`) whose box equals the strut exactly, so middle alignment pushed
its descent half past the strut and grew the line 1.26px; (b) the pill wrapper's
`margin-bottom: 2px` — an atomic inline participates via its MARGIN box, so the 22px
capsule presented a 24px box. The line growth then halved into a −0.63px shift through a
`flex items-center` parent. Fixes: `vertical-align: top` on the exact-strut box (edge-to-
edge fit, zero growth) and dropping the wrapper margin. Both were, again, all-constant and
statically decidable under the same proposed claim — three real bugs from one claim type in
one small app is decent evidence it carries weight. Also caught at runtime by a framecheck
state-transition diff (same-page capture before/after the interaction, diff at 0.25px
tolerance, gate on moved/resized of pre-existing elements): `resized div#26 (block
-0.63px)` pre-fix, clean post-fix.
