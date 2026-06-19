import fs from "fs";
import path from "path";
import { logger } from "../../utils/logger.js";

const log = logger.child({ service: "[NavMap]" });

const DEFAULT_PATH = process.env.NAV_INFO_PATH ?? path.resolve("etc/nav-info/nav-info.csv");

/** A named callout region — an axis-aligned box in world coordinates. */
interface Area {
  name: string;
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

/**
 * NavMap — "The Cartographer".
 *
 * Loads CS2 callout boxes (etc/nav-info.csv) and resolves a player coordinate to
 * the named area it sits in (e.g. [x,y,z] → "BodyShop"). Each map is tiled into
 * many small boxes; we pick the box that contains the point in X/Y and is closest
 * in Z, which disambiguates stacked areas (a Roof above the ground floor).
 */
export class NavMap {
  private readonly areas = new Map<string, Area[]>();

  constructor(filePath: string = DEFAULT_PATH) {
    this.load(filePath);
  }

  private load(filePath: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      log.warn({ err, filePath }, "nav-info.csv not found — callouts disabled");
      return;
    }

    const lines = raw.split("\n");
    let parsed = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // mapName,areaId,areaName,nwX,nwY,nwZ,seX,seY,seZ
      const c = line.split(",");
      if (c.length < 9) continue;
      const mapName = c[0];
      const areaName = c[2]?.trim();
      if (!mapName || !areaName) continue; // unnamed tiles aren't useful callouts

      const nwX = +c[3], nwY = +c[4], nwZ = +c[5], seX = +c[6], seY = +c[7], seZ = +c[8];
      if ([nwX, nwY, nwZ, seX, seY, seZ].some(Number.isNaN)) continue;

      const list = this.areas.get(mapName) ?? [];
      list.push({
        name: areaName,
        minX: Math.min(nwX, seX), maxX: Math.max(nwX, seX),
        minY: Math.min(nwY, seY), maxY: Math.max(nwY, seY),
        minZ: Math.min(nwZ, seZ), maxZ: Math.max(nwZ, seZ),
      });
      this.areas.set(mapName, list);
      parsed++;
    }

    log.info(
      { maps: this.areas.size, areas: parsed },
      `🗺️  loaded ${parsed} callout areas across ${this.areas.size} maps`
    );
  }

  /** Resolve a world coordinate to its callout name, or null if unknown. */
  locate(map: string, pos?: number[]): string | null {
    if (!pos || pos.length < 3) return null;
    const areas = this.areas.get(map);
    if (!areas) return null;

    const [x, y, z] = pos;
    let best: string | null = null;
    let bestZDist = Infinity;
    for (const a of areas) {
      if (x < a.minX || x > a.maxX || y < a.minY || y > a.maxY) continue;
      // vertical distance to the box's Z range (0 when inside) — picks the right floor.
      const zDist = z < a.minZ ? a.minZ - z : z > a.maxZ ? z - a.maxZ : 0;
      if (zDist < bestZDist) {
        bestZDist = zDist;
        best = a.name;
      }
    }
    return best;
  }
}
