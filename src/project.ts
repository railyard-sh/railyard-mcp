import { randomBytes } from "node:crypto";

import type { Project } from "./client.js";

export interface MinimalProjectOptions {
  id?: string;
  createdAt?: string;
}

/** Build the canonical empty project shape accepted by the current Railyard schema. */
export function minimalProject(name: string, options: MinimalProjectOptions = {}): Project {
  const id = options.id ?? `prj_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
  return {
    schemaVersion: "1",
    id,
    name,
    createdAt: options.createdAt ?? new Date().toISOString(),
    containers: [],
    containerTypes: [],
    locations: [],
    dataCentres: [],
    rows: [],
    racks: [],
    podPatterns: [],
    namingRules: [],
    catalogue: [],
    rackTypes: [],
    meetMeRooms: [],
    cables: [],
    powerLinks: [],
    reviewDismissals: [],
    deviceRoles: [],
  };
}
