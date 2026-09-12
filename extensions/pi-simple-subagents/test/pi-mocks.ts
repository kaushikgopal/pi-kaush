/**
 * Factories for the shared superset of package mocks in pi tests. Vitest runs
 * each test file in its own module graph, so test files register these via
 * hoisted vi.mock calls.
 */

class BoxComponent {
  children: unknown[] = [];
  constructor(
    // Pi extensions commonly construct Box(width, height, render).
    public _width = 0,
    public _height = 0,
    public _render?: (text: string) => string,
  ) {}
  addChild(child: unknown) {
    this.children.push(child);
  }
  clear() {}
  setBgFn() {}
}

class TextComponent {
  constructor(
    public text: string,
    public paddingX = 0,
    public paddingY = 0,
  ) {}
}

class ContainerComponent {
  children: unknown[] = [];
  addChild(child: unknown) {
    this.children.push(child);
  }
  clear() {}
}

export function createPiAiMock() {
  return {
    StringEnum: (
      values: readonly string[],
      options: Record<string, unknown> = {},
    ) => ({
      type: "string",
      enum: [...values],
      ...options,
    }),
  };
}

export function createPiTuiMock() {
  return {
    getCapabilities: () => ({ hyperlinks: false }),
    hyperlink: (text: string) => text,
    Box: BoxComponent,
    Text: TextComponent,
    Markdown: TextComponent,
    Container: ContainerComponent,
    Spacer: class {},
  };
}

export function createTypeboxMock() {
  return {
    Type: {
      String: (options: Record<string, unknown> = {}) => ({
        type: "string",
        ...options,
      }),
      Boolean: (options: Record<string, unknown> = {}) => ({
        type: "boolean",
        ...options,
      }),
      Optional: (schema: Record<string, unknown>) => ({
        ...schema,
        optional: true,
      }),
      Array: (
        items: Record<string, unknown>,
        options: Record<string, unknown> = {},
      ) => ({
        type: "array",
        items,
        ...options,
      }),
      Object: (properties: Record<string, unknown>) => ({
        type: "object",
        properties,
      }),
      Number: (options: Record<string, unknown> = {}) => ({
        type: "number",
        ...options,
      }),
    },
  };
}
