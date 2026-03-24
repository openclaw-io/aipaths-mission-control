import type { OfficeLayout } from "@/lib/types/office";

export interface Position {
  x: number;
  y: number;
}

export interface ZonePositions {
  work: Position[];        // Desk positions (agent sits at desk)
  kitchen: {
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    spots: Position[];     // Hangout spots for wandering
  };
  lounge: {
    seats: Position[];     // Sofa/armchair positions (agent sits)
    area: { minX: number; maxX: number; minY: number; maxY: number };
  };
}

/**
 * Extract zone positions from an office layout.
 * Work = desk furniture positions
 * Kitchen = counter/coffee/fridge area + random spots
 * Lounge = sofa/armchair positions
 */
export function getZonePositions(layout: OfficeLayout): ZonePositions {
  const desks: Position[] = [];
  const loungeSeats: Position[] = [];
  const kitchenFurniture: Position[] = [];

  for (const f of layout.furniture) {
    switch (f.type) {
      case "desk":
        // Agent sits 2 tiles below desk (at the chair position)
        desks.push({ x: f.x, y: f.y + 2 });
        break;
      case "sofa":
      case "armchair":
        loungeSeats.push({ x: f.x + 1, y: f.y + 1 });
        break;
      case "counter":
      case "coffee":
      case "fridge":
      case "snack_table":
      case "stool":
        kitchenFurniture.push({ x: f.x, y: f.y });
        break;
    }
  }

  // Kitchen bounds from furniture positions
  const kitchenXs = kitchenFurniture.map((p) => p.x);
  const kitchenYs = kitchenFurniture.map((p) => p.y);
  const kitchenBounds = kitchenFurniture.length > 0
    ? {
        minX: Math.min(...kitchenXs) - 1,
        maxX: Math.max(...kitchenXs) + 2,
        minY: Math.min(...kitchenYs),
        maxY: Math.max(...kitchenYs) + 3,
      }
    : { minX: 8, maxX: 15, minY: 2, maxY: 12 }; // Fallback for AIPaths HQ

  // Generate hangout spots in kitchen area
  const kitchenSpots: Position[] = [];
  for (let x = kitchenBounds.minX + 1; x < kitchenBounds.maxX; x += 2) {
    for (let y = kitchenBounds.minY + 2; y < kitchenBounds.maxY; y += 3) {
      kitchenSpots.push({ x, y });
    }
  }

  // Lounge area from seat positions
  const loungeXs = loungeSeats.map((p) => p.x);
  const loungeYs = loungeSeats.map((p) => p.y);
  const loungeArea = loungeSeats.length > 0
    ? {
        minX: Math.min(...loungeXs) - 1,
        maxX: Math.max(...loungeXs) + 2,
        minY: Math.min(...loungeYs) - 1,
        maxY: Math.max(...loungeYs) + 2,
      }
    : { minX: 0, maxX: 7, minY: 2, maxY: 12 }; // Fallback

  return {
    work: desks,
    kitchen: { bounds: kitchenBounds, spots: kitchenSpots },
    lounge: { seats: loungeSeats, area: loungeArea },
  };
}

/**
 * Pick a position from a zone for an agent.
 * Uses agentIndex to spread agents across available positions instead of
 * randomly stacking them on the same spot.
 */
export function getRandomZonePosition(
  zonePositions: ZonePositions,
  zone: "work" | "kitchen" | "lounge",
  occupiedDesks: Set<number> = new Set(),
  agentIndex: number = 0,
): Position {
  if (zone === "work") {
    // Find first free desk
    for (let i = 0; i < zonePositions.work.length; i++) {
      if (!occupiedDesks.has(i)) return zonePositions.work[i];
    }
    // All occupied, use last desk
    return zonePositions.work[zonePositions.work.length - 1] || { x: 18, y: 5 };
  }

  if (zone === "kitchen") {
    const spots = zonePositions.kitchen.spots;
    if (spots.length > 0) return spots[agentIndex % spots.length];
    return { x: 11, y: 6 };
  }

  // Lounge — spread agents across seats, then generate overflow positions
  const seats = zonePositions.lounge.seats;
  if (seats.length > 0) {
    if (agentIndex < seats.length) return seats[agentIndex];
    // Overflow: offset from existing seats
    const baseSeat = seats[agentIndex % seats.length];
    const overflowOffset = Math.floor(agentIndex / seats.length);
    return { x: baseSeat.x + overflowOffset * 2, y: baseSeat.y + overflowOffset };
  }

  // No lounge furniture at all — spread across the lounge area
  const area = zonePositions.lounge.area;
  const areaW = area.maxX - area.minX;
  const cols = Math.max(Math.floor(areaW / 3), 1);
  const col = agentIndex % cols;
  const row = Math.floor(agentIndex / cols);
  return {
    x: area.minX + 1 + col * 3,
    y: area.minY + 1 + row * 3,
  };
}
