import { describe, expect, test } from "vitest";
import { buildOutline, type SnapshotNode } from "../src/core/ax-snapshot.ts";

const nodes: SnapshotNode[] = [
  {
    nodeId: "1",
    childIds: ["2", "5", "7", "8"],
    role: { value: "RootWebArea" },
    name: { value: "Example" },
  },
  {
    nodeId: "2",
    parentId: "1",
    childIds: ["3", "4"],
    role: { value: "generic" },
  },
  {
    nodeId: "3",
    parentId: "2",
    role: { value: "heading" },
    name: { value: "Example Domain" },
  },
  {
    nodeId: "4",
    parentId: "2",
    role: { value: "link" },
    name: { value: "More information" },
    backendDOMNodeId: 42,
  },
  {
    nodeId: "5",
    parentId: "1",
    childIds: ["6"],
    ignored: true,
    role: { value: "generic" },
  },
  {
    nodeId: "6",
    parentId: "5",
    role: { value: "textbox" },
    name: { value: "Email" },
    value: { value: "a@b.com" },
    backendDOMNodeId: 77,
  },
  {
    nodeId: "7",
    parentId: "1",
    role: { value: "StaticText" },
    name: { value: "plain words" },
  },
  {
    nodeId: "8",
    parentId: "1",
    role: { value: "InlineTextBox" },
    name: { value: "noise" },
  },
];

describe("buildOutline", () => {
  const built = buildOutline(nodes, 400, 0);

  test("renders structure, flattens generic and ignored wrappers", () => {
    expect(built.text).toContain('RootWebArea "Example"');
    expect(built.text).toContain('  heading "Example Domain"');
    expect(built.text).toContain('"plain words"');
    expect(built.text).not.toContain("generic");
    expect(built.text).not.toContain("InlineTextBox");
  });

  test("assigns refs to interactive elements with backend ids", () => {
    expect(built.text).toContain('[e1] link "More information"');
    expect(built.text).toContain('[e2] textbox "Email" = "a@b.com"');
    expect(built.refs).toEqual([
      { id: "e1", backendNodeId: 42, role: "link", name: "More information" },
      { id: "e2", backendNodeId: 77, role: "textbox", name: "Email" },
    ]);
  });

  test("interactive node without backend id renders without a ref", () => {
    const orphan = buildOutline(
      [{ nodeId: "1", role: { value: "button" }, name: { value: "Ghost" } }],
      400,
      0,
    );
    expect(orphan.text).toBe('button "Ghost"');
    expect(orphan.refs).toEqual([]);
  });

  test("truncates at maxLines", () => {
    const many: SnapshotNode[] = [
      {
        nodeId: "r",
        role: { value: "RootWebArea" },
        name: { value: "Many" },
        childIds: Array.from({ length: 20 }, (_, i) => `c${i}`),
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        nodeId: `c${i}`,
        parentId: "r",
        role: { value: "link" },
        name: { value: `l${i}` },
        backendDOMNodeId: i + 1,
      })),
    ];
    const built = buildOutline(many, 5, 0);
    expect(built.truncated).toBe(true);
    expect(built.text).toContain("truncated at 5 lines");
  });
});
