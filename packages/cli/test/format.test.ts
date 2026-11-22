import { expect, test } from "bun:test";
import type { TodoId } from "@todo/core";
import { formatDetail, formatLine, formatList, type TodoView } from "../src/format";

const base: TodoView = {
  id: "01JD3K7Q9XW2M4V8R5T6Y13FK2" as TodoId,
  short_id: "t-3fk2",
  title: "Buy milk",
  status: "open",
  tags: [],
  created_at: "2026-11-01T09:00:00.000Z",
  updated_at: "2026-11-02T10:00:00.000Z",
  created_by: "human:ada",
  updated_by: "agent:claude",
  rev: 2,
  body: "",
};

test("formatLine shows id and title, then project, tags and due when set", () => {
  expect(formatLine(base)).toBe("t-3fk2  Buy milk");
  expect(formatLine({ ...base, project: "home", tags: ["errand", "food"], due: "2026-12-01" })).toBe(
    "t-3fk2  Buy milk  project:home tag:errand tag:food due:2026-12-01",
  );
});

test("formatLine marks done and cancelled todos", () => {
  expect(formatLine({ ...base, status: "done" })).toBe("t-3fk2  [done] Buy milk");
  expect(formatLine({ ...base, status: "cancelled" })).toBe("t-3fk2  [cancelled] Buy milk");
});

test("formatList aligns titles past the longest short id", () => {
  expect(formatList([base, { ...base, short_id: "t-a3fk2", title: "Other" }])).toBe("t-3fk2   Buy milk\nt-a3fk2  Other");
  expect(formatList([])).toBe("");
});

test("formatDetail lists the set fields, then the body", () => {
  expect(formatDetail({ ...base, project: "home", tags: ["a", "b"], priority: 1, body: "Oat, not cow." })).toBe(
    [
      "t-3fk2  Buy milk",
      "status    open",
      "project   home",
      "tags      a, b",
      "priority  1",
      "created   2026-11-01T09:00:00.000Z by human:ada",
      "updated   2026-11-02T10:00:00.000Z by agent:claude (rev 2)",
      "id        01JD3K7Q9XW2M4V8R5T6Y13FK2",
      "",
      "Oat, not cow.",
    ].join("\n"),
  );
});
