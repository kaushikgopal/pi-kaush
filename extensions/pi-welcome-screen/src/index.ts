import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Component,
  type Container,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const MAX_STACKED_COLUMN_WIDTH = 80;
const MAX_RESOURCE_COLUMN_WIDTH = 80;
const BRAND_COLUMN_WIDTH = 40;
const WIDE_COLUMN_GAP = 4;
const MIN_WIDE_RESOURCE_COLUMN_WIDTH = 60;
const MIN_WIDE_LAYOUT_WIDTH =
  BRAND_COLUMN_WIDTH + WIDE_COLUMN_GAP + MIN_WIDE_RESOURCE_COLUMN_WIDTH;
const MAX_WIDE_LAYOUT_WIDTH =
  BRAND_COLUMN_WIDTH + WIDE_COLUMN_GAP + MAX_RESOURCE_COLUMN_WIDTH;
const MAX_LIST_ROWS_PER_COLUMN = 6;
const MIN_LIST_COLUMN_WIDTH = 22;
const LIST_COLUMN_GAP = 2;
const RESOURCE_POLL_INTERVAL_MS = 50;
const MAX_RESOURCE_RETRIES = 3;
const RESOURCE_PANEL_INDEX = 1;
const RESOURCE_BRIDGE_KEY = "__piKaushWelcomeScreenResourceBridge";

let cachedLocalExtensionNames: Set<string> | undefined;

const PI_BANNER = ["█████████", "███   ███", "██████   ███", "███      ███"];

type WelcomeSection = "Context" | "Skills" | "Prompts" | "Extensions";
const WELCOME_SECTIONS: readonly WelcomeSection[] = [
  "Context",
  "Skills",
  "Prompts",
  "Extensions",
];

export interface WelcomeResources {
  context: string[];
  skills: string[];
  prompts: string[];
  extensions: string[];
  /** Extensions not sourced from the user's Pi extensions directory. */
  vendoredExtensions?: string[];
}

interface CollapsedTextComponent extends Component {
  getCollapsedText?: () => string;
}

interface ResourcePanel extends Component {
  children: Component[];
}

interface ResourceBridge {
  panel: ResourcePanel;
  originalIndex: number;
}

interface ResourcePanelSnapshot {
  resourceText: string;
  requiresNativePanel: boolean;
}

type BridgeTui = TUI & {
  [RESOURCE_BRIDGE_KEY]?: ResourceBridge;
};

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function isResourcePanel(
  component: Component | undefined,
): component is ResourcePanel {
  if (!component || typeof component !== "object") return false;
  return Array.isArray((component as Partial<Container>).children);
}

function getSectionHeading(text: string): string | undefined {
  return stripAnsi(text.split("\n", 1)[0] ?? "")
    .trim()
    .match(/^\[([^\]]+)\]$/)?.[1];
}

function inspectResourcePanel(panel: ResourcePanel): ResourcePanelSnapshot {
  const sections: string[] = [];

  for (const child of panel.children) {
    const collapsible = child as CollapsedTextComponent;
    if (typeof collapsible.getCollapsedText === "function") {
      const text = collapsible.getCollapsedText();
      const heading = getSectionHeading(text);
      if (WELCOME_SECTIONS.some((section) => section === heading)) {
        sections.push(text);
      } else if (heading !== "Themes") {
        // Unknown native sections may contain actionable information. Keep
        // Pi's panel intact rather than guessing how to reproduce them.
        return { resourceText: "", requiresNativePanel: true };
      }
      continue;
    }

    const hasVisibleContent = child
      .render(1_000)
      .some((line) => stripAnsi(line).trim().length > 0);
    if (hasVisibleContent) {
      return { resourceText: "", requiresNativePanel: true };
    }
  }

  return { resourceText: sections.join("\n"), requiresNativePanel: false };
}

function splitList(body: string[]): string[] {
  return body
    .join(" ")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeExtensionName(label: string): string {
  let name = label.trim().replace(/^npm:/, "").replace(/\\/g, "/");
  // Windows drive letters use a colon as part of the path, not as the
  // separator between a package name and its extension entry point.
  const packageSeparator = /^[A-Za-z]:\//.test(name) ? -1 : name.indexOf(":");
  const isPackageLabel = packageSeparator !== -1;
  if (isPackageLabel) name = name.slice(0, packageSeparator);

  name = name.replace(/\/$/, "");
  if (!isPackageLabel && !name.startsWith("@")) {
    const segments = name.split("/").filter(Boolean);
    const fileName = segments.pop() ?? name;
    if (/^(?:index)\.(?:[cm]?[jt]s)$/.test(fileName)) {
      const parent = segments.pop() ?? "index";
      name = parent === "src" ? (segments.pop() ?? parent) : parent;
    } else {
      name = fileName;
    }
  }
  return name.replace(/\.(?:[cm]?[jt]s)$/, "");
}

function isWelcomeScreenExtension(name: string): boolean {
  return (
    name === "welcome-screen" ||
    name === "pi-welcome-screen" ||
    name === "@pi-kaush/pi-welcome-screen" ||
    name === "src"
  );
}

export function sortExtensionNames(names: string[]): string[] {
  return [...names].sort((left, right) => {
    const scopeOrder =
      Number(left.startsWith("@")) - Number(right.startsWith("@"));
    return scopeOrder || left.localeCompare(right);
  });
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function getLocalExtensionNames(): Set<string> {
  if (cachedLocalExtensionNames) return cachedLocalExtensionNames;

  const extensionsDir = join(getAgentDir(), "extensions");
  try {
    cachedLocalExtensionNames = new Set(
      readdirSync(extensionsDir, { withFileTypes: true }).flatMap((entry) => {
        if (/\.[cm]?[jt]s$/.test(entry.name))
          return normalizeExtensionName(entry.name);
        if (
          entry.isDirectory() &&
          existsSync(join(extensionsDir, entry.name, "index.ts"))
        ) {
          return entry.name;
        }
        return [];
      }),
    );
  } catch {
    cachedLocalExtensionNames = new Set();
  }
  return cachedLocalExtensionNames;
}

export function parseWelcomeResources(
  text: string,
  localExtensionNames = getLocalExtensionNames(),
): WelcomeResources {
  const bodies = new Map<WelcomeSection, string[]>();
  let currentSection: WelcomeSection | undefined;

  for (const rawLine of text.split("\n")) {
    const line = stripAnsi(rawLine).trim();
    const header = line.match(/^\[([^\]]+)\]$/)?.[1];
    if (header) {
      currentSection = WELCOME_SECTIONS.find((section) => section === header);
      if (currentSection && !bodies.has(currentSection))
        bodies.set(currentSection, []);
      continue;
    }

    if (line && currentSection) bodies.get(currentSection)?.push(line);
  }

  const context = unique(splitList(bodies.get("Context") ?? []));
  const skills = unique(splitList(bodies.get("Skills") ?? []));
  const prompts = unique(splitList(bodies.get("Prompts") ?? []));
  const extensionLabels = unique(splitList(bodies.get("Extensions") ?? []));
  const extensions = sortExtensionNames(
    unique(extensionLabels.map(normalizeExtensionName)),
  );
  const vendoredExtensions = extensions.filter(
    (name) => !localExtensionNames.has(name),
  );

  return { context, skills, prompts, extensions, vendoredExtensions };
}

function takeResourcePanel(tui: TUI): ResourceBridge | undefined {
  const host = tui as BridgeTui;
  if (host[RESOURCE_BRIDGE_KEY]) return undefined;

  // TODO: Replace this bridge when Pi exposes structured startup resources
  // through its custom-header API.
  // Pi 0.80 places the loaded-resources container immediately after the
  // header. Guard the full shape so an upstream layout change falls back to
  // Pi's untouched resource panel instead of moving an unrelated component.
  if (tui.children.length < 8 || !isResourcePanel(tui.children[0]))
    return undefined;
  const panel = tui.children[RESOURCE_PANEL_INDEX];
  if (!isResourcePanel(panel)) return undefined;

  const bridge = { panel, originalIndex: RESOURCE_PANEL_INDEX };
  tui.removeChild(panel);
  host[RESOURCE_BRIDGE_KEY] = bridge;
  return bridge;
}

function restoreResourcePanel(
  tui: TUI,
  bridge: ResourceBridge | undefined,
): void {
  if (!bridge) return;

  if (!tui.children.includes(bridge.panel)) {
    const index = Math.min(bridge.originalIndex, tui.children.length);
    tui.children.splice(index, 0, bridge.panel);
  }
  delete (tui as BridgeTui)[RESOURCE_BRIDGE_KEY];
}

function centerBlockLine(
  line: string,
  blockWidth: number,
  width: number,
): string {
  const clipped = truncateToWidth(line, width, "");
  return (
    " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2))) + clipped
  );
}

function wrapPrefixed(prefix: string, text: string, width: number): string[] {
  const prefixWidth = visibleWidth(prefix);
  if (width <= prefixWidth) return [truncateToWidth(prefix, width, "")];

  const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
  const continuation = " ".repeat(prefixWidth);
  return wrapped.map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

function appendSingleColumnRows(
  lines: string[],
  items: string[],
  theme: Theme,
  columnWidth: number,
): void {
  for (const item of items) {
    lines.push(
      ...wrapPrefixed(
        theme.fg("dim", "  • "),
        theme.fg("dim", item),
        columnWidth,
      ),
    );
  }
}

function getColumnWidths(listWidth: number, columnCount: number): number[] {
  const totalCellWidth = listWidth - LIST_COLUMN_GAP * (columnCount - 1);
  const baseCellWidth = Math.floor(totalCellWidth / columnCount);
  const widerCellCount = totalCellWidth % columnCount;
  return Array.from(
    { length: columnCount },
    (_, index) => baseCellWidth + (index < widerCellCount ? 1 : 0),
  );
}

function canUseThreeColumns(items: string[], columnWidth: number): boolean {
  const listWidth = Math.max(1, columnWidth - 2);
  const fittingColumns = Math.floor(
    (listWidth + LIST_COLUMN_GAP) / (MIN_LIST_COLUMN_WIDTH + LIST_COLUMN_GAP),
  );
  if (fittingColumns < 3) return false;

  const rowsPerColumn = Math.ceil(items.length / 3);
  const cellWidths = getColumnWidths(listWidth, 3);
  return items.every((item, index) => {
    const column = Math.floor(index / rowsPerColumn);
    return visibleWidth(`• ${item}`) <= (cellWidths[column] ?? 0);
  });
}

function getSharedMultiColumnCount(
  resources: WelcomeResources,
  columnWidth: number,
): 2 | 3 {
  const vendoredExtensions = new Set(
    resources.vendoredExtensions ??
      resources.extensions.filter((name) => name.startsWith("@")),
  );
  const localExtensions = resources.extensions.filter(
    (name) => !vendoredExtensions.has(name),
  );
  const multiColumnLists = [resources.skills, localExtensions].filter(
    (items) => items.length > MAX_LIST_ROWS_PER_COLUMN,
  );
  return multiColumnLists.every((items) =>
    canUseThreeColumns(items, columnWidth),
  )
    ? 3
    : 2;
}

function appendColumnRows(
  lines: string[],
  items: string[],
  theme: Theme,
  columnWidth: number,
  sharedColumnCount?: 2 | 3,
): void {
  const listWidth = Math.max(1, columnWidth - 2);
  const desiredColumns = Math.ceil(items.length / MAX_LIST_ROWS_PER_COLUMN);
  const fittingColumns = Math.max(
    1,
    Math.floor(
      (listWidth + LIST_COLUMN_GAP) / (MIN_LIST_COLUMN_WIDTH + LIST_COLUMN_GAP),
    ),
  );
  const requestedColumns =
    sharedColumnCount && items.length > MAX_LIST_ROWS_PER_COLUMN
      ? sharedColumnCount
      : desiredColumns;
  const columnCount = Math.min(requestedColumns, fittingColumns);

  if (columnCount === 1) {
    appendSingleColumnRows(lines, items, theme, columnWidth);
    return;
  }

  const rowsPerColumn = Math.ceil(items.length / columnCount);
  const cellWidths = getColumnWidths(listWidth, columnCount);

  for (let row = 0; row < rowsPerColumn; row += 1) {
    const cells = cellWidths.map((cellWidth, column) => {
      const item = items[column * rowsPerColumn + row];
      if (!item) return " ".repeat(cellWidth);

      // truncateToWidth inserts ANSI resets around its ellipsis. Strip those
      // because the complete row receives its muted color afterward; otherwise
      // one truncated cell resets the color of every following column.
      const cell = stripAnsi(truncateToWidth(`• ${item}`, cellWidth, "…"));
      return cell + " ".repeat(Math.max(0, cellWidth - visibleWidth(cell)));
    });
    const rowText = `  ${cells.join(" ".repeat(LIST_COLUMN_GAP))}`.trimEnd();
    lines.push(theme.fg("dim", rowText));
  }
}

function appendSection(
  lines: string[],
  title: WelcomeSection,
  body: string[],
  theme: Theme,
  columnWidth: number,
  singleColumn = false,
  sharedColumnCount?: 2 | 3,
): void {
  if (lines.length > 0) lines.push("");
  lines.push(theme.fg("mdHeading", `[${title}]`));

  if (body.length === 0) {
    lines.push(theme.fg("dim", "  (none)"));
    return;
  }

  if (singleColumn) appendSingleColumnRows(lines, body, theme, columnWidth);
  else appendColumnRows(lines, body, theme, columnWidth, sharedColumnCount);
}

function appendExtensionsSection(
  lines: string[],
  extensions: string[],
  vendoredExtensionNames: string[] | undefined,
  theme: Theme,
  columnWidth: number,
  sharedColumnCount: 2 | 3,
): void {
  if (lines.length > 0) lines.push("");
  lines.push(theme.fg("mdHeading", "[Extensions]"));

  if (extensions.length === 0) {
    lines.push(theme.fg("dim", "  (none)"));
    return;
  }

  const vendoredExtensions = new Set(
    // Keep direct callers that provide only `extensions` backward compatible.
    vendoredExtensionNames ?? extensions.filter((name) => name.startsWith("@")),
  );
  const localExtensions = extensions.filter(
    (name) => !vendoredExtensions.has(name),
  );
  const packageExtensions = extensions.filter((name) =>
    vendoredExtensions.has(name),
  );
  if (localExtensions.length > 0) {
    appendColumnRows(
      lines,
      localExtensions,
      theme,
      columnWidth,
      sharedColumnCount,
    );
  }
  if (localExtensions.length > 0 && packageExtensions.length > 0) {
    lines.push("");
  }
  if (packageExtensions.length > 0) {
    appendSingleColumnRows(lines, packageExtensions, theme, columnWidth);
  }
}

function renderBrandColumn(theme: Theme, columnWidth: number): string[] {
  const lines: string[] = [];
  const bannerWidth = Math.max(...PI_BANNER.map((line) => visibleWidth(line)));
  for (const bannerLine of PI_BANNER) {
    lines.push(
      centerBlockLine(
        theme.bold(theme.fg("accent", bannerLine)),
        bannerWidth,
        columnWidth,
      ),
    );
  }
  lines.push("");
  const versionSummary = theme.fg("dim", `v${VERSION}`);
  lines.push(
    centerBlockLine(versionSummary, visibleWidth(versionSummary), columnWidth),
  );
  return lines;
}

function renderResourceColumn(
  resources: WelcomeResources,
  theme: Theme,
  columnWidth: number,
): string[] {
  const lines: string[] = [];
  const sharedColumnCount = getSharedMultiColumnCount(resources, columnWidth);
  appendSection(lines, "Context", resources.context, theme, columnWidth, true);
  appendSection(
    lines,
    "Skills",
    resources.skills,
    theme,
    columnWidth,
    false,
    sharedColumnCount,
  );
  appendSection(lines, "Prompts", resources.prompts, theme, columnWidth);
  appendExtensionsSection(
    lines,
    resources.extensions,
    resources.vendoredExtensions,
    theme,
    columnWidth,
    sharedColumnCount,
  );
  return lines;
}

function renderStackedWelcome(
  resources: WelcomeResources | undefined,
  theme: Theme,
  columnWidth: number,
): string[] {
  const lines = ["", ...renderBrandColumn(theme, columnWidth)];
  if (resources)
    lines.push("", ...renderResourceColumn(resources, theme, columnWidth));
  lines.push("");
  return lines;
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function renderWideWelcome(
  resources: WelcomeResources,
  theme: Theme,
  layoutWidth: number,
): string[] {
  const resourceColumnWidth =
    layoutWidth - BRAND_COLUMN_WIDTH - WIDE_COLUMN_GAP;
  const brandLines = renderBrandColumn(theme, BRAND_COLUMN_WIDTH);
  const resourceLines = renderResourceColumn(
    resources,
    theme,
    resourceColumnWidth,
  );
  const rowCount = Math.max(brandLines.length, resourceLines.length);
  const brandTopPadding = Math.floor((rowCount - brandLines.length) / 2);

  return Array.from({ length: rowCount }, (_, row) => {
    const brandLine = brandLines[row - brandTopPadding] ?? "";
    const resourceLine = resourceLines[row] ?? "";
    const combined = [
      padToWidth(brandLine, BRAND_COLUMN_WIDTH),
      " ".repeat(WIDE_COLUMN_GAP),
      truncateToWidth(resourceLine, resourceColumnWidth, ""),
    ].join("");
    return combined.trimEnd();
  });
}

export function renderCenteredWelcome(
  resources: WelcomeResources | undefined,
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const useWideLayout =
    resources !== undefined && width >= MIN_WIDE_LAYOUT_WIDTH;
  const layoutWidth = useWideLayout
    ? Math.min(MAX_WIDE_LAYOUT_WIDTH, width)
    : Math.min(MAX_STACKED_COLUMN_WIDTH, width);
  const leftPadding = " ".repeat(Math.floor((width - layoutWidth) / 2));
  const lines =
    useWideLayout && resources
      ? renderWideWelcome(resources, theme, layoutWidth)
      : renderStackedWelcome(resources, theme, layoutWidth);

  return lines.map((line) =>
    line ? leftPadding + truncateToWidth(line, layoutWidth, "") : "",
  );
}

class WelcomeHeader implements Component {
  private resourceReadyTimer: ReturnType<typeof setTimeout> | undefined;
  private resources: WelcomeResources | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly bridge: ResourceBridge | undefined,
    forceInitialRender: boolean,
  ) {
    // session_start runs just before Pi populates its loaded-resource panel.
    this.resourceReadyTimer = setTimeout(
      () => this.captureResourcesWhenReady(forceInitialRender, 0),
      0,
    );
  }

  private captureResourcesWhenReady(
    forceInitialRender: boolean,
    attempt: number,
  ): void {
    if (this.disposed) return;
    if (!this.bridge) {
      this.resourceReadyTimer = undefined;
      if (attempt === 0) this.tui.requestRender(forceInitialRender);
      return;
    }

    let snapshot: ResourcePanelSnapshot;
    try {
      snapshot = inspectResourcePanel(this.bridge.panel);
    } catch {
      this.showNativePanel(forceInitialRender);
      return;
    }
    if (snapshot.requiresNativePanel) {
      this.showNativePanel(forceInitialRender);
      return;
    }

    const { resourceText } = snapshot;
    const candidateResources = resourceText
      ? parseWelcomeResources(resourceText)
      : undefined;
    // Pi 0.80 builds this panel synchronously. If a future Pi populates it
    // asynchronously after Extensions appears, this snapshot can be incomplete.
    const resourcePanelIsComplete = Boolean(
      candidateResources?.extensions.some(isWelcomeScreenExtension),
    );
    if (resourcePanelIsComplete) {
      this.resources = candidateResources;
      this.clearRenderCache();
      this.resourceReadyTimer = undefined;
      this.tui.requestRender(forceInitialRender);
      return;
    }

    if (attempt === 0) {
      // Remove Pi's pre-TUI model-scope line while leaving resource sections
      // hidden until the complete panel can be revealed atomically.
      this.tui.requestRender(forceInitialRender);
    }
    if (attempt < MAX_RESOURCE_RETRIES) {
      this.resourceReadyTimer = setTimeout(
        () => this.captureResourcesWhenReady(false, attempt + 1),
        RESOURCE_POLL_INTERVAL_MS,
      );
    } else {
      this.showNativePanel(false);
    }
  }

  private showNativePanel(forceRender: boolean): void {
    this.resourceReadyTimer = undefined;
    restoreResourcePanel(this.tui, this.bridge);
    this.clearRenderCache();
    this.tui.requestRender(forceRender);
  }

  private clearRenderCache(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const resources = this.resources;
    const lines = renderCenteredWelcome(resources, this.theme, width);
    if (resources) {
      this.cachedWidth = width;
      this.cachedLines = lines;
    }
    return lines;
  }

  invalidate(): void {
    this.clearRenderCache();
    this.bridge?.panel.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resourceReadyTimer) clearTimeout(this.resourceReadyTimer);
    restoreResourcePanel(this.tui, this.bridge);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader(
      (tui, theme) =>
        new WelcomeHeader(
          tui,
          theme,
          takeResourcePanel(tui),
          event.reason === "startup",
        ),
    );
  });
}
