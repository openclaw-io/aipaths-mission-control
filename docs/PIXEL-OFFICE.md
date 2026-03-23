# Pixel Office Integration

Pixel-art office visualization for Mission Control. Agents appear as animated characters whose state reflects their real task activity.

Based on [ClawBoard](https://github.com/kirillkuzin/clawboard) (MIT).

## Architecture

```
src/
  lib/
    agents.ts              # Canonical agent registry (single source of truth)
    office-status.ts       # Task → agent status mapping logic
    types/office.ts        # Pixel office types
  components/
    office/
      pixel-office.tsx     # Canvas 2D visualization (accepts layout + agents props)
      pixel-sprites.ts     # Tile & furniture drawing
      sprite-generator.ts  # Agent character drawing & particles
      OfficeClient.tsx      # View/edit wrapper, realtime wiring
    editor/
      office-editor.tsx    # Visual office layout editor
  hooks/
    use-office-agents.ts   # Realtime + polling hook → SpriteAgent[]
    use-office-state.ts    # Office layout state (localStorage)
    use-media-query.ts     # Responsive breakpoints
  app/
    office/page.tsx        # SSR data fetch → OfficeClient
```

## Task → Agent Animation Mapping

| Condition | Animation | Visual |
|-----------|-----------|--------|
| Has `in_progress` task | `working` | Typing arms + task bubble |
| `done` completed < 2min ago | `celebrating` | Bounce + sparkles |
| Only `blocked` tasks (queued) | `sleeping` | Dimmed + ZZZ |
| No activity for 1h+ | `sleeping` | Dimmed + ZZZ |
| Has `new` tasks only | `idle` | Subtle breathing |
| No tasks at all | `idle` | Subtle breathing |
| Idle + today's memory | `idle` | Speech bubble with memory |

## Data Flow

```
Supabase (agent_tasks, agent_memory)
  ↓ SSR fetch (page.tsx)
  ↓ Props: initialTasks, initialMemory
  ↓ useOfficeAgents hook
  ↓   ├─ Supabase Realtime subscription
  ↓   └─ Polling fallback (10s if Realtime fails)
  ↓ buildSpriteAgents() → SpriteAgent[]
  ↓ <PixelOffice agents={sprites} layout={layout} />
  ↓ Canvas 2D rendering
```

## Realtime Strategy

1. Primary: Supabase Realtime (`postgres_changes` on `agent_tasks` + `agent_memory`)
2. Fallback: If channel doesn't reach "SUBSCRIBED" in 5s, start polling every 10s
3. Prerequisite: Enable Realtime on both tables in Supabase dashboard

## Office Layout

- 30x20 tile grid (floor, wall, carpet)
- 8 workstations (one per agent, assigned by index)
- Furniture: desks, monitors, chairs, plants, bookshelves, server rack, etc.
- Layout persisted to localStorage (`mc-pixel-office-layout`)
- Customizable via visual editor (Edit tab)
- Export/import as JSON

---

## TODO

### Must Have (v1.1)
- [ ] Add `failed` task status to schema (migration + CHECK constraint update)
- [ ] Map `failed` → error animation (red flash), `blocked` stays as sleeping/queued
- [ ] Celebrating → idle automatic timer (setInterval fallback for when no Realtime events fire)

### Should Have (v2)
- [ ] Agent lifecycle table (spawning/despawning by actual process start/stop)
- [ ] Sub-agent support (isSubAgent, parentId from real data)
- [ ] Per-agent desk assignment UI (drag agent to specific desk)
- [ ] Supabase Realtime reconnection/retry logic
- [ ] Click agent in office → navigate to filtered tasks view

### Nice to Have (v3)
- [ ] Mobile sidebar collapse on office page
- [ ] Custom agent sprites (upload avatar per agent)
- [ ] Office themes (different color palettes)
- [ ] Sound effects toggle
- [ ] Full PixiJS upgrade for zoom/pan/interactivity
- [ ] Agent walking animation between desks on task reassignment
