import type { OfficeTemplate } from "@/lib/types/office";

/**
 * Built-in office template: AIPaths HQ
 * 3 zones: Lounge (left), Kitchen (center), Work area (right)
 * Grid: 24 cols x 16 rows
 */
export const BUILTIN_TEMPLATES: OfficeTemplate[] = [
  {
    id: "builtin-aipaths-hq",
    name: "AIPaths HQ",
    builtIn: true,
    createdAt: "2026-03-24T00:00:00Z",
    updatedAt: "2026-03-24T00:00:00Z",
    layout: {
      name: "AIPaths HQ",
      cols: 24,
      rows: 16,
      tilemap: (() => {
        // 0=floor, 1=wall, 2=carpet
        const map: number[][] = [];
        for (let r = 0; r < 16; r++) {
          const row: number[] = [];
          for (let c = 0; c < 24; c++) {
            if (r === 0) {
              row.push(1); // top wall
            } else if (c <= 7) {
              row.push(2); // lounge = carpet
            } else if (c >= 16) {
              row.push(0); // work = floor
            } else {
              row.push(0); // kitchen = floor
            }
          }
          map.push(row);
        }
        return map as (0 | 1 | 2)[][];
      })(),
      furniture: [
        // === LOUNGE (left, cols 0-7) ===
        // Sofas
        { id: "l-sofa1", type: "sofa", x: 1, y: 3, label: "" },
        { id: "l-sofa2", type: "sofa", x: 1, y: 8, label: "" },
        // Armchair
        { id: "l-arm1", type: "armchair", x: 5, y: 6, label: "" },
        // Side table between sofas
        { id: "l-side1", type: "sidetable", x: 4, y: 5, label: "" },
        // Bookshelf against wall
        { id: "l-book1", type: "bookshelf", x: 1, y: 1, label: "" },
        { id: "l-book2", type: "bookshelf", x: 3, y: 1, label: "" },
        // Rug in center of lounge
        { id: "l-rug1", type: "rug", x: 2, y: 5, label: "" },
        // Lamp
        { id: "l-lamp1", type: "lamp", x: 0, y: 3, label: "" },
        { id: "l-lamp2", type: "lamp", x: 0, y: 8, label: "" },
        // Plant
        { id: "l-plant1", type: "plant", x: 7, y: 1, label: "" },
        { id: "l-plant2", type: "plant", x: 7, y: 13, label: "" },

        // === KITCHEN (center, cols 8-15) ===
        // Counter against top
        { id: "k-counter1", type: "counter", x: 9, y: 1, label: "" },
        // Coffee machine on counter
        { id: "k-coffee1", type: "coffee", x: 10, y: 1, label: "" },
        // Fridge
        { id: "k-fridge1", type: "fridge", x: 14, y: 1, label: "" },
        // Microwave
        { id: "k-micro1", type: "microwave", x: 12, y: 1, label: "" },
        // Snack table
        { id: "k-snack1", type: "snack_table", x: 10, y: 6, label: "" },
        // Stools around snack table
        { id: "k-stool1", type: "stool", x: 9, y: 5, label: "" },
        { id: "k-stool2", type: "stool", x: 12, y: 5, label: "" },
        { id: "k-stool3", type: "stool", x: 9, y: 8, label: "" },
        { id: "k-stool4", type: "stool", x: 12, y: 8, label: "" },
        // Plant
        { id: "k-plant1", type: "plant", x: 8, y: 1, label: "" },
        // Water cooler
        { id: "k-cooler1", type: "watercooler", x: 15, y: 5, label: "" },

        // === WORK AREA (right, cols 16-23) ===
        // Row 1 of desks (4 desks)
        { id: "w-desk1", type: "desk", x: 17, y: 3, label: "" },
        { id: "w-mon1", type: "monitor", x: 17, y: 3, label: "" },
        { id: "w-chair1", type: "chair", x: 17, y: 5, label: "" },

        { id: "w-desk2", type: "desk", x: 19, y: 3, label: "" },
        { id: "w-mon2", type: "monitor", x: 19, y: 3, label: "" },
        { id: "w-chair2", type: "chair", x: 19, y: 5, label: "" },

        { id: "w-desk3", type: "desk", x: 21, y: 3, label: "" },
        { id: "w-mon3", type: "monitor", x: 21, y: 3, label: "" },
        { id: "w-chair3", type: "chair", x: 21, y: 5, label: "" },

        { id: "w-desk4", type: "desk", x: 23, y: 3, label: "" },
        { id: "w-mon4", type: "monitor", x: 23, y: 3, label: "" },
        { id: "w-chair4", type: "chair", x: 23, y: 5, label: "" },

        // Row 2 of desks (4 desks)
        { id: "w-desk5", type: "desk", x: 17, y: 9, label: "" },
        { id: "w-mon5", type: "monitor", x: 17, y: 9, label: "" },
        { id: "w-chair5", type: "chair", x: 17, y: 11, label: "" },

        { id: "w-desk6", type: "desk", x: 19, y: 9, label: "" },
        { id: "w-mon6", type: "monitor", x: 19, y: 9, label: "" },
        { id: "w-chair6", type: "chair", x: 19, y: 11, label: "" },

        { id: "w-desk7", type: "desk", x: 21, y: 9, label: "" },
        { id: "w-mon7", type: "monitor", x: 21, y: 9, label: "" },
        { id: "w-chair7", type: "chair", x: 21, y: 11, label: "" },

        { id: "w-desk8", type: "desk", x: 23, y: 9, label: "" },
        { id: "w-mon8", type: "monitor", x: 23, y: 9, label: "" },
        { id: "w-chair8", type: "chair", x: 23, y: 11, label: "" },

        // Whiteboard
        { id: "w-wb1", type: "whiteboard", x: 20, y: 1, label: "" },

        // Plants in work area
        { id: "w-plant1", type: "plant", x: 16, y: 1, label: "" },
        { id: "w-plant2", type: "plant", x: 16, y: 13, label: "" },

        // Window on right wall
        { id: "w-win1", type: "window", x: 23, y: 1, label: "" },
      ],
    },
  },
];
