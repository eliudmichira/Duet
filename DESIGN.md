# Soft-Embossed Pill — a portable design language

A name for what the new Create/Join buttons are doing, so you can apply it
consistently across Duet and reuse it on the next project.

## The one-line pitch

> **Physical pills sitting on a dark, dusty backdrop, lit from above.**
> Every interactive surface is a small object with a top edge, a bottom edge,
> and a shadow it casts on the world.

The whole system follows from that sentence. If a control doesn't read as a
*lit object*, it's wrong.

## Three states of matter

Every element on screen is in exactly one of four states. Picking the right
one is most of the design work.

| State        | What it is                              | Recipe                                                   | Examples                                |
| ------------ | --------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| **Lifted**   | An object you can press                 | Top-light gradient + rim + base + cast shadow            | Buttons, status pill, drift pill        |
| **Recessed** | A surface things sit on / a hole        | Dark fill + inset top shadow only                        | Partner card, diag panel, text inputs   |
| **Carved**   | A label cut *into* a Lifted parent      | Inverse of Lifted: inset top, faint bottom rim           | Code-cells inside the room-card         |
| **Compartment** | The window itself                    | Subtle 1px white rim at top edge of the body             | The popup body                          |

The trick to a coherent UI: **never have two states at the same elevation in
the same row.** A lifted button next to a recessed input is correct. Two
lifted buttons of different sizes is correct. Two recessed cards stacked is
correct. A lifted card holding a lifted button is wrong (everything floats,
nothing leads).

## The four ingredients (Lifted recipe)

A Lifted element is a stack of exactly four light effects. Memorize this — it's the entire system.

| Layer            | What it does                          | CSS                                               |
| ---------------- | ------------------------------------- | ------------------------------------------------- |
| 1. Body fill     | Vertical gradient, lighter at the top | `linear-gradient(180deg, lighter 0%, base 50%, darker 100%)` |
| 2. Rim highlight | 1px bright edge along the top         | `inset 0 1px 0 rgba(255,255,255, 0.10–0.45)`       |
| 3. Recessed base | Soft inner shadow at the bottom       | `inset 0 -2px 4px rgba(0,0,0, 0.18–0.20)`          |
| 4. Cast shadow   | Soft external drop, below the object  | `0 8px 20px rgba(<accent or black>, 0.35–0.40)`    |

The gradient angle is **always 180deg**. Light comes from above. Don't rotate
it for variety — consistency is what makes the room feel real.

The Carved recipe is layers 2 and 3 *swapped*: inset shadow on **top**, faint rim on **bottom**, slightly darker fill than parent. Same vocabulary, opposite direction. That's how the code-cells read as cut into the room-card instead of floating on it.

The Recessed recipe is just one ingredient: `inset 0 1px 2px rgba(0,0,0,0.35)` plus a darker fill. No gradient, no rim, no cast. Things that hold content shouldn't compete with the content.

## State physics

Press feedback isn't a color change — it's the object moving in space.

```
default → hover  : translateY(-2px), shadow grows + accent intensifies
hover   → active : translateY(0),    shadow shrinks → button "presses in"
```

Active state should feel *flatter* than default, not just darker. That's the
trick: rim highlight dims, cast shadow tightens, inner-bottom shadow softens.
The button momentarily becomes part of the surface.

Transition: `transform 0.15s ease, box-shadow 0.25s ease`. Shadows fade
slightly slower than position — that lag is what sells the weight.

**Travel scales with object size.** Big buttons lift `-2px`. Small pills (copy, status, drift) lift `-1px`. Emoji-key reactions scale up *and* lift `-1px`. A 30px-wide pill that travels 4px feels weightless; a 280px button that travels 1px feels stuck.

## Tier system

Three tiers, three shadow palettes, same recipe.

| Tier      | When                              | Cast shadow tint           | Rim highlight |
| --------- | --------------------------------- | -------------------------- | ------------- |
| Primary   | The one action on the screen      | Brand accent (coral/rose)  | 0.45 white    |
| Secondary | Equal-weight alternative          | Pure black                 | 0.10 white    |
| Ghost     | Destructive / tertiary (no lift)  | None                       | None          |

Ghost intentionally breaks the system — it shouldn't feel like a primary
object. That's how "Leave room" reads as a quieter action.

## Echoed accent shadows

When a small element has a strong accent color (peach icon, rose chip, danger pill), tint its **cast shadow** in that color at 0.20–0.30 alpha. The shadow becomes a soft halo of the same hue, so the object looks like it's *radiating* its identity instead of just being painted with it.

Examples shipped:
- `.btn-icon` — peach-tinted cast shadow because its icon is peach.
- `.together` chip — rose-tinted cast because the chip is rose.
- `.drift.warn` — peach-tinted; `.drift.bad` — danger-tinted; `.drift` (good) — success-tinted. The pill's cast shadow turns red when sync goes bad — you feel the problem before you read the number.
- `.btn-primary` — coral-tinted (the brand accent).

Black cast shadow is the **default for neutrals**. Color-tinted is reserved for elements with a meaningful accent — don't tint everything or the page becomes Christmas.

## Shape: pill vs. card vs. input

- **Pills** (`border-radius: 999px`): single actions. Buttons. Status badges. Drift pill. Together chip.
- **Cards** (`border-radius: 16px` / `--radius`): containers holding other things. Room-code card.
- **Sub-cards** (`border-radius: 10px` / `--radius-sm`): smaller containers and inputs. Partner card, diag panel, text inputs.

Never mix. A pill-shaped input or a card-shaped button breaks the metaphor.

## CSS tokens (full as-shipped set)

```css
:root {
  /* Lifted: rim highlights — light catching the top edge */
  --emboss-rim:        inset 0 1px 0 rgba(255,255,255,0.45);  /* primary */
  --emboss-rim-soft:   inset 0 1px 0 rgba(255,255,255,0.10);  /* neutral */
  --emboss-rim-faint:  inset 0 1px 0 rgba(255,255,255,0.06);  /* active state */

  /* Lifted: base shadow — the bottom edge sinking into itself */
  --emboss-base:       inset 0 -2px 4px rgba(0,0,0,0.18);
  --emboss-base-soft:  inset 0 -1px 2px rgba(0,0,0,0.12);

  /* Cast shadows — the object's shadow on the world */
  --lift-primary:      0 8px 20px rgba(255,138,107,0.40);
  --lift-primary-hi:   0 12px 28px rgba(255,138,107,0.50);
  --lift-primary-lo:   0 3px 10px rgba(255,138,107,0.30);

  --lift-neutral:      0 6px 16px rgba(0,0,0,0.35);
  --lift-neutral-hi:   0 10px 22px rgba(0,0,0,0.45);
  --lift-neutral-lo:   0 2px 8px rgba(0,0,0,0.30);

  --lift-small:        0 3px 8px rgba(0,0,0,0.30);     /* small pills (copy, status) */
  --lift-small-hi:     0 6px 14px rgba(0,0,0,0.40);

  /* Recessed: holes and surfaces that hold content */
  --recess:            inset 0 1px 2px rgba(0,0,0,0.35),
                       inset 0 -1px 0 rgba(255,255,255,0.04);
}
```

Compose Lifted controls by stacking three tokens:

```css
.thing         { box-shadow: var(--lift-primary),    var(--emboss-rim),      var(--emboss-base); }
.thing:hover   { box-shadow: var(--lift-primary-hi), var(--emboss-rim),      var(--emboss-base); transform: translateY(-2px); }
.thing:active  { box-shadow: var(--lift-primary-lo), var(--emboss-rim-soft), var(--emboss-base-soft); transform: translateY(0); }
```

Recessed controls are one token:

```css
.surface { background: rgba(0,0,0,0.20); box-shadow: var(--recess); }
.input   { background: rgba(0,0,0,0.25); box-shadow: var(--recess); }
```

## The compartment pattern

The popup window itself is part of the system. Two extra rules on `<body>`:

```css
body {
  background: linear-gradient(180deg, #0c0a14 0%, var(--bg-0) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.07),  /* top edge catches ambient light */
    inset 0 -1px 0 rgba(0,0,0,0.5);        /* bottom edge seats the window */
}
```

This is what makes everything *inside* the popup feel like it's in a real container. Without this, the recessed cards look like floating slabs on a flat black void; with it, they look like panels installed into a compartment.

## The grid-of-buttons pattern

A row of small same-sized actions (emoji reactions, tab switchers) gets a special variant: **recessed tray, embossed keys**.

```
[ recessed tray ]
  └── [key] [key] [key] [key]   ← flat at rest, emboss + lift on :hover
                                  recess on :active (key pressed back in)
```

The tray reads as a slot the keys live in; pressing a key feels like it pops up to greet you, then sinks back when released. Duet's reactions tray is the canonical instance.

## Duet: as-built map

| Element                       | State        | Notes                                              |
| ----------------------------- | ------------ | -------------------------------------------------- |
| `body`                        | Compartment  | Top rim, bottom seat, vertical gradient bg         |
| `.btn-primary` (Create)       | Lifted       | Coral cast, full-strength rim, -2px hover travel   |
| `.btn-secondary` (Join)       | Lifted       | Black cast, soft rim, -2px hover travel            |
| `.btn-ghost` (Leave)          | Flat         | Intentional system-break — destructive action      |
| `.copy-btn`                   | Lifted (sm)  | Neutral cast, -1px hover travel                    |
| `.btn-icon` (Sync)            | Lifted       | Peach-tinted cast, -1px hover travel               |
| `.partner-mismatch button`    | Lifted (sm)  | Peach gradient, primary recipe at small scale      |
| `.status` pill                | Lifted (sm)  | Neutral cast, no hover                             |
| `.together` chip              | Lifted (sm)  | Rose-tinted cast                                   |
| `.drift` pill                 | Lifted (sm)  | Cast tinted by health state (success/peach/danger) |
| `.room-card`                  | Lifted (lg)  | Neutral cast + faint top rim                       |
| `.code-cells span`            | Carved       | Top inset, faint bottom rim, sunk into room-card   |
| `.peer-hint`                  | Recessed     | Surface, not object                                |
| `.partner-card`               | Recessed     | Container holding its own content                  |
| `.diag` panel                 | Recessed     | Container                                          |
| `.reactions` tray             | Recessed     | Slot                                               |
| `.reactions button`           | Lifted-on-hover | Key-press pattern; flat at rest                 |
| `.code-input`, `.chat-input`  | Recessed     | Holes you type into                                |
| `#leave-btn` (`.btn-ghost`)   | Ghost        | Muted text, danger colour only on hover            |
| `.trouble-link`               | Flat         | Text link; diagnostics live behind it              |

### In-page badge (content script, closed Shadow DOM)

Same tokens, scoped to a shadow root so the host page can't restyle it.

| Element                       | State        | Notes                                              |
| ----------------------------- | ------------ | -------------------------------------------------- |
| `.badge`                      | Lifted (lg)  | Cast shadow echoes sync health (`data-health`: good / warn / bad / idle) |
| `.btn-primary` (Catch up)     | Lifted (sm)  | The badge's one raised action; -1px travel         |
| `.tray` + `.key` (reactions)  | Recessed tray, keys lift on hover | Canonical grid-of-buttons pattern |
| `.chat input`                 | Recessed     | Hole you type into                                 |
| `.drawer` (emoji picker)      | Lifted (lg)  | Pops above the badge; tabs are pills, grid is a tray |
| `.puck` (minimized)           | Lifted (sm)  | Same health echo as the badge                      |
| `.flash`, `.toast`            | Lifted       | Accent-tinted cast: play green, pause peach, leave red |
| `.icon-key` (minimize)        | Flat → lifts on hover | Small object, -1px travel                  |

## Hierarchy rule of thumb

> The number of elements that look "raised" on screen at once should equal the number of distinct actions the user is being offered.

- **Disconnected view**: 2 raised buttons (Create, Join). Correct — two paths to the same goal.
- **Connected view**: 1 raised primary action (Catch up), with raised *small* indicators (status pill, together chip, drift pill). Copy, Leave, reactions, and all containers stay flat or recessed. Once the partner joins, the room-code card collapses — the code has done its job.
- **In-page badge**: 1 raised action (Catch up). Everything else is a recessed tray/input or a flat key until hovered.

If you find yourself raising a fourth or fifth button, you don't have a design problem — you have an information-architecture problem. Cut something or demote it to recessed/flat.

That's the system. Three tokens deep, infinitely composable, recognizable
across projects without copying anyone's specific UI.
