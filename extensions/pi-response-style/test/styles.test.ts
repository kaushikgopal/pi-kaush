import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInjection,
  GUARDRAIL,
  loadStyles,
  parseStyleFile,
} from "../src/styles.ts";

const VALID = `---
title: Plain English
description: Smart-friend explanations, no jargon
---

Respond in plain English. Prefer short words and short sentences.
`;

describe("parseStyleFile", () => {
  it("parses title, description, and body", () => {
    const { style, warning } = parseStyleFile("plain-english", VALID);
    expect(warning).toBeUndefined();
    expect(style).toEqual({
      name: "plain-english",
      title: "Plain English",
      description: "Smart-friend explanations, no jargon",
      body: "Respond in plain English. Prefer short words and short sentences.",
      origin: "bundled",
    });
  });

  it("falls back to the filename when title is missing and allows a missing description", () => {
    const { style } = parseStyleFile("terse", "---\n---\n\nBe terse.\n");
    expect(style?.title).toBe("terse");
    expect(style?.description).toBe("");
    expect(style?.body).toBe("Be terse.");
  });

  it("collapses multi-line frontmatter values to one line", () => {
    const content = `---
title: >
  Multi
  Line Title
description: first
  second
---

Body.
`;
    const { style } = parseStyleFile("multi", content);
    expect(style?.title).toBe("Multi Line Title");
    expect(style?.description).toBe("first second");
  });

  it("replaces terminal controls and collapses metadata whitespace", () => {
    const content = `---
title: "Tabs\\t Escape\\e DEL\\x7F C1\\x85 End"
description: "first\\t\\t second\\e\\x7F\\x85 third"
---

Body.
`;
    const { style } = parseStyleFile("controls", content);
    expect(style?.title).toBe("Tabs Escape DEL C1 End");
    expect(style?.description).toBe("first second third");
  });

  it("keeps a body that contains --- lines", () => {
    const { style } = parseStyleFile(
      "dashes",
      "---\ntitle: Dashes\n---\n\nAbove\n\n---\n\nBelow\n",
    );
    expect(style?.body).toBe("Above\n\n---\n\nBelow");
  });

  it("handles CRLF and BOM", () => {
    const { style, warning } = parseStyleFile(
      "crlf",
      "---\r\ntitle: Windows\r\ndescription: line endings\r\n---\r\n\r\nBody text.\r\n".replace(
        /^/,
        "﻿",
      ),
    );
    expect(warning).toBeUndefined();
    expect(style?.title).toBe("Windows");
    expect(style?.body).toBe("Body text.");
  });

  it("skips files with no prompt body", () => {
    const { style, warning } = parseStyleFile(
      "empty",
      "---\ntitle: Empty\n---\n\n",
    );
    expect(style).toBeUndefined();
    expect(warning).toMatch(/no prompt body/);
  });

  it("skips files with unparseable frontmatter", () => {
    const { style, warning } = parseStyleFile(
      "broken",
      "---\n: : :\n---\nBody\n",
    );
    expect(style).toBeUndefined();
    expect(warning).toBeDefined();
  });
});

describe("buildInjection", () => {
  it("appends title, body, and the thinking guardrail", () => {
    const style = parseStyleFile("x", VALID).style!;
    const injection = buildInjection(style);
    expect(injection).toContain("# Communication");
    expect(injection).toContain("Respond in plain English.");
    expect(injection).toContain(GUARDRAIL);
  });
});

describe("loadStyles", () => {
  it("layers user styles over bundled styles by filename", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-response-style-"));
    const bundled = join(root, "bundled");
    const user = join(root, "user");
    mkdirSync(bundled);
    mkdirSync(user);
    writeFileSync(
      join(bundled, "shared.md"),
      "---\ntitle: Bundled\n---\n\nBundled body.\n",
    );
    writeFileSync(
      join(bundled, "bundled-only.md"),
      "---\ntitle: Only\n---\n\nOnly body.\n",
    );
    writeFileSync(
      join(user, "shared.md"),
      "---\ntitle: User\n---\n\nUser body.\n",
    );

    const { styles, warnings } = loadStyles(bundled, user);
    expect(warnings).toEqual([]);
    const byName = new Map(styles.map((s) => [s.name, s]));
    expect(byName.get("shared")?.title).toBe("User");
    expect(byName.get("bundled-only")?.title).toBe("Only");
    expect(styles).toHaveLength(2);
  });

  it("tolerates a missing user dir and reports malformed files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-response-style-"));
    writeFileSync(join(root, "good.md"), VALID);
    writeFileSync(join(root, "bad.md"), "---\ntitle: Bad\n---\n\n");

    const { styles, warnings } = loadStyles(join(root, "missing"), root);
    expect(styles.map((s) => s.name)).toEqual(["good"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/bad/);
  });

  it("skips the reserved off name", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-response-style-"));
    writeFileSync(join(root, "off.md"), VALID);

    const { styles, warnings } = loadStyles(join(root, "missing"), root);
    expect(styles).toEqual([]);
    expect(warnings).toContain('response style "off": reserved name, skipped');
  });

  it("skips control-bearing filenames without echoing them", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-response-style-"));
    const unsafeName = "unsafe\u001b.md";
    writeFileSync(join(root, unsafeName), VALID);

    const { styles, warnings } = loadStyles(join(root, "missing"), root);
    expect(styles).toEqual([]);
    expect(warnings).toEqual([
      "response style filename contains terminal control characters, skipped",
    ]);
    expect(warnings.join("\n")).not.toContain(unsafeName);
  });
});

describe("project layer", () => {
  it("layers project over user over bundled and tags origins", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-response-style-"));
    const bundled = join(root, "bundled");
    const user = join(root, "user");
    const project = join(root, "project");
    mkdirSync(bundled);
    mkdirSync(user);
    mkdirSync(project);
    writeFileSync(
      join(bundled, "shared.md"),
      "---\ntitle: Bundled\n---\n\nBundled body.\n",
    );
    writeFileSync(
      join(user, "shared.md"),
      "---\ntitle: User\n---\n\nUser body.\n",
    );
    writeFileSync(
      join(project, "shared.md"),
      "---\ntitle: Project\n---\n\nProject body.\n",
    );
    writeFileSync(
      join(project, "proj-only.md"),
      "---\ntitle: ProjOnly\n---\n\nProj body.\n",
    );

    const { styles } = loadStyles(bundled, user, project);
    const byName = new Map(styles.map((s) => [s.name, s]));
    expect(byName.get("shared")?.title).toBe("Project");
    expect(byName.get("shared")?.origin).toBe("project");
    expect(byName.get("proj-only")?.origin).toBe("project");

    const withoutProject = loadStyles(bundled, user);
    expect(
      new Map(withoutProject.styles.map((s) => [s.name, s])).get("shared")
        ?.title,
    ).toBe("User");
  });
});
