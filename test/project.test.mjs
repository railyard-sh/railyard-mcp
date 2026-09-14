import assert from "node:assert/strict";
import test from "node:test";

import { minimalProject } from "../dist/project.js";

test("new projects use the current canonical empty document shape", () => {
  const project = minimalProject("New estate", {
    id: "prj_test",
    createdAt: "2026-09-13T12:00:00.000Z",
  });

  assert.deepEqual(project, {
    schemaVersion: "1",
    id: "prj_test",
    name: "New estate",
    createdAt: "2026-09-13T12:00:00.000Z",
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
  });
  assert.equal(project.example, undefined);
});
