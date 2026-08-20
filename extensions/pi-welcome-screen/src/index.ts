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
  Spacer,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export const WELCOME_SIDE_PADDING = 2;
const MAX_STACKED_COLUMN_WIDTH = 80;
const MIN_GRID_COLUMN_WIDTH = 40;
const MAX_GRID_COLUMN_WIDTH = 60;
const GRID_COLUMN_GAP = 4;
const MAX_LIST_ROWS_PER_COLUMN = 6;
const MIN_LIST_COLUMN_WIDTH = 22;
const LIST_COLUMN_GAP = 2;
const RESOURCE_POLL_INTERVAL_MS = 50;
const MAX_RESOURCE_RETRIES = 3;
const LAYOUT_NOTICE =
  "pi-welcome-screen: unrecognized Pi layout — using native panel";
const RESOURCE_PANEL_INDEX = 1;

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
  /** Extensions loaded from npm or git packages. */
  packageExtensions?: string[];
  /** Local extension entry points outside Pi's extension directories. */
  sourceExtensions?: string[];
  /** @deprecated Use packageExtensions. */
  vendoredExtensions?: string[];
}

interface CollapsedTextComponent extends Component {
  getCollapsedText?: () => string;
  getExpandedText?: () => string;
}

interface ResourcePanel extends Component {
  children: Component[];
  addChild(component: Component): void;
  removeChild(component: Component): void;
}

interface RemovedResourceChild {
  component: Component;
  originalIndex: number;
}

interface ResourceBridge {
  panel: ResourcePanel;
  removedChildren: RemovedResourceChild[];
}

interface ResourcePanelSnapshot {
  resourceText: string;
  expandedExtensionsText?: string;
  knownChildren: Component[];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function isResourcePanel(
  component: Component | undefined,
): component is ResourcePanel {
  if (!component || typeof component !== "object") return false;
  const candidate = component as Partial<Container>;
  return (
    Array.isArray(candidate.children) &&
    typeof candidate.addChild === "function" &&
    typeof candidate.removeChild === "function"
  );
}

function getSectionHeading(text: string): string | undefined {
  return stripAnsi(text.split("\n", 1)[0] ?? "")
    .trim()
    .match(/^\[([^\]]+)\]$/)?.[1];
}

function inspectResourcePanel(panel: ResourcePanel): ResourcePanelSnapshot {
  const sections: string[] = [];
  const knownChildren: Component[] = [];
  let expandedExtensionsText: string | undefined;

  for (const child of panel.children) {
    const collapsible = child as CollapsedTextComponent;
    if (typeof collapsible.getCollapsedText !== "function") continue;

    const text = collapsible.getCollapsedText();
    const heading = getSectionHeading(text);
    if (WELCOME_SECTIONS.some((section) => section === heading)) {
      knownChildren.push(child);
      sections.push(text);
      if (
        (heading === "Extensions" ||
          /(?:^|\n)\s*\[Extensions\]\s*(?:\n|$)/.test(stripAnsi(text))) &&
        typeof collapsible.getExpandedText === "function"
      ) {
        expandedExtensionsText = collapsible.getExpandedText();
      }
    } else if (heading === "Themes") {
      knownChildren.push(child);
    }
  }

  return {
    resourceText: sections.join("\n"),
    ...(expandedExtensionsText ? { expandedExtensionsText } : {}),
    knownChildren,
  };
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
    if (/\/(?:index)\.(?:[cm]?[jt]s)$/.test(name)) return name;
    const segments = name.split("/").filter(Boolean);
    const fileName = segments.pop() ?? name;
    name = fileName;
  }
  return name.replace(/\.(?:[cm]?[jt]s)$/, "");
}

function isWelcomeScreenExtension(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return (
    name === "welcome-screen" ||
    name === "pi-welcome-screen" ||
    name === "@pi-kaush/pi-welcome-screen" ||
    name === "src" ||
    /\/(?:pi-)?welcome-screen(?:\/|$)/.test(normalized)
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

interface ExtensionGroups {
  localExtensions: string[];
  packageExtensions: string[];
  sourceExtensions: string[];
}

function isPackageSource(label: string): boolean {
  return label.startsWith("npm:") || label.startsWith("git:");
}

function normalizePackageSource(label: string): string {
  return label.replace(/^(?:npm|git):/, "");
}

interface GitPackageSource {
  label: string;
  revision: string | undefined;
}

function splitGitRevision(pathWithRevision: string): {
  path: string;
  revision: string | undefined;
} {
  const separator = pathWithRevision.indexOf("@");
  if (separator === -1) return { path: pathWithRevision, revision: undefined };
  return {
    path: pathWithRevision.slice(0, separator),
    revision: pathWithRevision.slice(separator + 1),
  };
}

function parseGitPackageSource(source: string): GitPackageSource {
  const value = source.replace(/^git:/, "");
  const scpMatch = value.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    const { path, revision } = splitGitRevision(scpMatch[2] ?? "");
    return {
      label: `${scpMatch[1] ?? ""}/${path}`.replace(/\.git$/, ""),
      revision,
    };
  }

  if (value.includes("://")) {
    try {
      const url = new URL(value);
      const { path, revision } = splitGitRevision(
        url.pathname.replace(/^\/+/, ""),
      );
      return {
        label: `${url.hostname}/${path}`.replace(/\.git$/, ""),
        revision,
      };
    } catch {
      return { label: value, revision: undefined };
    }
  }

  const slash = value.indexOf("/");
  if (slash === -1) return { label: value, revision: undefined };
  const { path, revision } = splitGitRevision(value.slice(slash + 1));
  return {
    label: `${value.slice(0, slash)}/${path}`.replace(/\.git$/, ""),
    revision,
  };
}

function formatPackageExtensionLabel(
  source: string,
  extensionPaths: string[],
): string {
  const extensionNames = unique(
    extensionPaths
      .map((path) => path.replace(/\\/g, "/").split("/").pop() ?? "")
      .filter((name) => /\.[cm]?[jt]s$/.test(name)),
  );
  if (!source.startsWith("git:")) {
    return [normalizePackageSource(source), ...extensionNames].join(" ");
  }

  const { label, revision } = parseGitPackageSource(source);
  return [
    label,
    ...extensionNames,
    ...(revision ? [`@${revision.slice(0, 6)}`] : []),
  ].join(" ");
}

function isExplicitSourcePath(label: string): boolean {
  const normalized = label.replace(/\\/g, "/");
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /\/(?:index)\.(?:[cm]?[jt]s)$/.test(normalized)
  );
}

function parseExpandedExtensionGroups(
  text: string | undefined,
  localExtensionNames: Set<string>,
): ExtensionGroups | undefined {
  if (!text || getSectionHeading(text) !== "Extensions") return undefined;

  const localExtensions: string[] = [];
  const packageExtensions: string[] = [];
  const sourceExtensions: string[] = [];
  let foundItem = false;
  let currentPackageSource: string | undefined;
  let currentPackagePaths: string[] = [];
  const flushPackage = () => {
    if (!currentPackageSource) return;
    packageExtensions.push(
      formatPackageExtensionLabel(currentPackageSource, currentPackagePaths),
    );
    currentPackageSource = undefined;
    currentPackagePaths = [];
  };

  for (const rawLine of text.split("\n").slice(1)) {
    const line = stripAnsi(rawLine).replace(/\s+$/, "");
    const packageSource = line.match(/^ {4}((?:npm|git):.+)$/)?.[1];
    if (packageSource) {
      flushPackage();
      currentPackageSource = packageSource;
      foundItem = true;
      continue;
    }

    const packagePath = line.match(/^ {6}(\S.*)$/)?.[1];
    if (packagePath && currentPackageSource) {
      currentPackagePaths.push(packagePath);
      continue;
    }

    flushPackage();
    const path = line.match(/^ {4}(\S.*)$/)?.[1];
    if (!path || /^(?:project|user|path)$/.test(path)) continue;

    const name = normalizeExtensionName(path);
    if (
      localExtensionNames.has(name) ||
      /(?:^|\/)\.pi\/(?:agent\/)?extensions(?:\/|$)/.test(
        path.replace(/\\/g, "/"),
      )
    ) {
      localExtensions.push(name);
    } else {
      sourceExtensions.push(path.replace(/\\/g, "/"));
    }
    foundItem = true;
  }

  flushPackage();

  if (!foundItem) return undefined;
  return {
    localExtensions: sortExtensionNames(unique(localExtensions)),
    packageExtensions: sortExtensionNames(unique(packageExtensions)),
    sourceExtensions: sortExtensionNames(unique(sourceExtensions)),
  };
}

function classifyCompactExtensionLabels(
  labels: string[],
  localExtensionNames: Set<string>,
): ExtensionGroups {
  const localExtensions: string[] = [];
  const packageExtensions: string[] = [];
  const sourceExtensions: string[] = [];

  for (const label of labels) {
    const name = normalizeExtensionName(label);
    const indexParent = label
      .replace(/\\/g, "/")
      .match(/(?:^|\/)([^/]+)\/index\.(?:[cm]?[jt]s)$/)?.[1];
    if (
      localExtensionNames.has(name) ||
      localExtensionNames.has(indexParent ?? "")
    )
      localExtensions.push(name);
    else if (isPackageSource(label) || name.startsWith("@"))
      packageExtensions.push(
        isPackageSource(label) ? normalizePackageSource(label) : name,
      );
    else if (isExplicitSourcePath(label)) sourceExtensions.push(name);
    else packageExtensions.push(name);
  }

  return {
    localExtensions: sortExtensionNames(unique(localExtensions)),
    packageExtensions: sortExtensionNames(unique(packageExtensions)),
    sourceExtensions: sortExtensionNames(unique(sourceExtensions)),
  };
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
  expandedExtensionsText?: string,
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
  const groups =
    parseExpandedExtensionGroups(expandedExtensionsText, localExtensionNames) ??
    classifyCompactExtensionLabels(extensionLabels, localExtensionNames);
  const extensions = [
    ...groups.localExtensions,
    ...groups.packageExtensions,
    ...groups.sourceExtensions,
  ];

  return {
    context,
    skills,
    prompts,
    extensions,
    packageExtensions: groups.packageExtensions,
    sourceExtensions: groups.sourceExtensions,
  };
}

function findResourcePanel(tui: TUI): ResourcePanel | undefined {
  // TODO: Replace this bridge when Pi exposes structured startup resources
  // through its custom-header API.
  //
  // Pi 0.84 mounts one stable document in both regular and fullscreen modes:
  // [header, loaded-resources, chat]. Fullscreen scrolls that document without
  // changing the mounted TUI children, so keep both containers mounted.
  const documentContainer = tui.children[0];
  if (isResourcePanel(documentContainer)) {
    const [header, panel, chat] = documentContainer.children;
    if (
      isResourcePanel(header) &&
      isResourcePanel(panel) &&
      isResourcePanel(chat)
    ) {
      return panel;
    }
  }

  // Pi 0.80–0.83 place the loaded-resources container directly after the
  // header. Keep the old full-shape guard so an unknown layout stays untouched.
  if (
    tui.children.length >= 8 &&
    isResourcePanel(tui.children[0]) &&
    isResourcePanel(tui.children[RESOURCE_PANEL_INDEX])
  ) {
    return tui.children[RESOURCE_PANEL_INDEX];
  }

  return undefined;
}

function removeKnownResourceChildren(
  panel: ResourcePanel,
  knownChildren: Component[],
): ResourceBridge {
  const currentChildren = [...panel.children];
  const known = new Set(
    knownChildren.filter((child) => currentChildren.includes(child)),
  );
  const removedChildren = currentChildren.flatMap(
    (component, originalIndex) => {
      const previous = currentChildren[originalIndex - 1];
      const next = currentChildren[originalIndex + 1];
      const remove =
        known.has(component) ||
        (component instanceof Spacer &&
          Boolean(
            (previous && known.has(previous)) || (next && known.has(next)),
          ));
      return remove ? [{ component, originalIndex }] : [];
    },
  );

  for (const { component } of removedChildren) panel.removeChild(component);
  return { panel, removedChildren };
}

function restoreResourcePanel(bridge: ResourceBridge): void {
  for (const { component, originalIndex } of bridge.removedChildren) {
    if (bridge.panel.children.includes(component)) continue;
    const index = Math.min(originalIndex, bridge.panel.children.length);
    bridge.panel.children.splice(index, 0, component);
  }
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
  const packageExtensions = new Set(
    resources.packageExtensions ??
      resources.vendoredExtensions ??
      resources.extensions.filter((name) => name.startsWith("@")),
  );
  const sourceExtensions = new Set(resources.sourceExtensions ?? []);
  const localExtensions = resources.extensions.filter(
    (name) => !packageExtensions.has(name) && !sourceExtensions.has(name),
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
  packageExtensionNames: string[] | undefined,
  sourceExtensionNames: string[] | undefined,
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

  const packageExtensions = new Set(
    // Keep direct callers that provide only `extensions` backward compatible.
    packageExtensionNames ?? extensions.filter((name) => name.startsWith("@")),
  );
  const sourceExtensions = new Set(sourceExtensionNames ?? []);
  const localExtensions = extensions.filter(
    (name) => !packageExtensions.has(name) && !sourceExtensions.has(name),
  );
  const installedPackageExtensions = extensions.filter((name) =>
    packageExtensions.has(name),
  );
  const linkedSourceExtensions = extensions.filter((name) =>
    sourceExtensions.has(name),
  );
  const groups = [
    { title: "Local", items: localExtensions, multiColumn: true },
    {
      title: "Packages",
      items: installedPackageExtensions,
      multiColumn: false,
    },
    {
      title: "Source paths",
      items: linkedSourceExtensions,
      multiColumn: false,
    },
  ].filter(({ items }) => items.length > 0);

  for (const [index, group] of groups.entries()) {
    if (index > 0) lines.push("");
    lines.push(theme.fg("muted", `  ${group.title}`));
    if (group.multiColumn) {
      appendColumnRows(
        lines,
        group.items,
        theme,
        columnWidth,
        sharedColumnCount,
      );
    } else {
      appendSingleColumnRows(lines, group.items, theme, columnWidth);
    }
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
  const versionSummary = theme.fg(
    "dim",
    theme.name ? `v${VERSION} [${theme.name}]` : `v${VERSION}`,
  );
  lines.push(
    centerBlockLine(versionSummary, visibleWidth(versionSummary), columnWidth),
  );
  return lines;
}

function appendResourceSection(
  lines: string[],
  title: WelcomeSection,
  resources: WelcomeResources,
  theme: Theme,
  columnWidth: number,
  sharedColumnCount: 2 | 3,
): void {
  if (title === "Extensions") {
    appendExtensionsSection(
      lines,
      resources.extensions,
      resources.packageExtensions ?? resources.vendoredExtensions,
      resources.sourceExtensions,
      theme,
      columnWidth,
      sharedColumnCount,
    );
    return;
  }

  const body =
    title === "Context"
      ? resources.context
      : title === "Skills"
        ? resources.skills
        : resources.prompts;
  appendSection(
    lines,
    title,
    body,
    theme,
    columnWidth,
    title === "Context",
    title === "Skills" ? sharedColumnCount : undefined,
  );
}

function renderResourceColumn(
  resources: WelcomeResources,
  theme: Theme,
  columnWidth: number,
): string[] {
  const lines: string[] = [];
  const sharedColumnCount = getSharedMultiColumnCount(resources, columnWidth);
  for (const title of WELCOME_SECTIONS)
    appendResourceSection(
      lines,
      title,
      resources,
      theme,
      columnWidth,
      sharedColumnCount,
    );
  return lines;
}

type WelcomeGridItem = "Brand" | WelcomeSection;

const GRID_COLUMNS: Record<2 | 3, readonly (readonly WelcomeGridItem[])[]> = {
  2: [["Context", "Skills", "Prompts"], ["Extensions"]],
  3: [["Brand"], ["Context", "Skills", "Prompts"], ["Extensions"]],
};

function renderGridItem(
  item: WelcomeGridItem,
  resources: WelcomeResources,
  theme: Theme,
  columnWidth: number,
  sharedColumnCount: 2 | 3,
): string[] {
  if (item === "Brand") return renderBrandColumn(theme, columnWidth);

  const lines: string[] = [];
  appendResourceSection(
    lines,
    item,
    resources,
    theme,
    columnWidth,
    sharedColumnCount,
  );
  return lines;
}

function renderGridWelcome(
  resources: WelcomeResources,
  theme: Theme,
  columnWidth: number,
  columnCount: 2 | 3,
): string[] {
  const sharedColumnCount = getSharedMultiColumnCount(resources, columnWidth);
  const topAlignedColumns = GRID_COLUMNS[columnCount].map((items) =>
    items.flatMap((item, index) => [
      ...(index > 0 ? [""] : []),
      ...renderGridItem(item, resources, theme, columnWidth, sharedColumnCount),
    ]),
  );
  const rowCount = Math.max(
    ...topAlignedColumns.map((column) => column.length),
  );
  if (columnCount === 2) {
    const layoutWidth = columnWidth * 2 + GRID_COLUMN_GAP;
    const resourceRows = Array.from({ length: rowCount }, (_, row) =>
      topAlignedColumns
        .map((column) => padToWidth(column[row] ?? "", columnWidth))
        .join(" ".repeat(GRID_COLUMN_GAP))
        .trimEnd(),
    );
    return ["", ...renderBrandColumn(theme, layoutWidth), "", ...resourceRows];
  }

  const columns = topAlignedColumns.map((column, index) =>
    index === 0
      ? [
          ...Array.from(
            { length: Math.floor((rowCount - column.length) / 2) },
            () => "",
          ),
          ...column,
        ]
      : column,
  );

  return Array.from({ length: rowCount }, (_, row) =>
    columns
      .map((column) => padToWidth(column[row] ?? "", columnWidth))
      .join(" ".repeat(GRID_COLUMN_GAP))
      .trimEnd(),
  );
}

function renderStackedWelcome(
  resources: WelcomeResources | undefined,
  theme: Theme,
  columnWidth: number,
  notice?: string,
): string[] {
  const lines = ["", ...renderBrandColumn(theme, columnWidth)];
  if (notice) {
    const noticeText = theme.fg("dim", notice);
    lines.push(
      centerBlockLine(noticeText, visibleWidth(noticeText), columnWidth),
    );
  }
  if (resources)
    lines.push("", ...renderResourceColumn(resources, theme, columnWidth));
  lines.push("");
  return lines;
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function getGridColumnCount(width: number): 1 | 2 | 3 {
  if (width >= MIN_GRID_COLUMN_WIDTH * 3 + GRID_COLUMN_GAP * 2) return 3;
  if (width >= MIN_GRID_COLUMN_WIDTH * 2 + GRID_COLUMN_GAP) return 2;
  return 1;
}

export function renderCenteredWelcome(
  resources: WelcomeResources | undefined,
  theme: Theme,
  width: number,
  notice?: string,
): string[] {
  if (width <= 0) return [];
  const sidePadding = Math.min(
    WELCOME_SIDE_PADDING,
    Math.max(0, Math.floor((width - 1) / 2)),
  );
  const contentWidth = width - sidePadding * 2;
  const columnCount = resources ? getGridColumnCount(contentWidth) : 1;
  const columnWidth =
    columnCount === 1
      ? Math.min(MAX_STACKED_COLUMN_WIDTH, contentWidth)
      : Math.min(
          MAX_GRID_COLUMN_WIDTH,
          Math.floor(
            (contentWidth - GRID_COLUMN_GAP * (columnCount - 1)) / columnCount,
          ),
        );
  const layoutWidth =
    columnWidth * columnCount + GRID_COLUMN_GAP * (columnCount - 1);
  const leftPadding = " ".repeat(
    sidePadding + Math.floor((contentWidth - layoutWidth) / 2),
  );
  const lines =
    columnCount !== 1 && resources
      ? renderGridWelcome(resources, theme, columnWidth, columnCount)
      : renderStackedWelcome(resources, theme, layoutWidth, notice);

  return lines.map((line) =>
    line ? leftPadding + truncateToWidth(line, layoutWidth, "") : "",
  );
}

class WelcomeHeader implements Component {
  private resourceReadyTimer: ReturnType<typeof setTimeout> | undefined;
  private resources: WelcomeResources | undefined;
  private notice: string | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly bridges = new Map<ResourcePanel, ResourceBridge>();
  private sawResourcePanel = false;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
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

    let panel: ResourcePanel | undefined;
    let snapshot: ResourcePanelSnapshot | undefined;
    try {
      panel = findResourcePanel(this.tui);
      if (panel) {
        this.sawResourcePanel = true;
        snapshot = inspectResourcePanel(panel);
      }
    } catch {
      panel = undefined;
      snapshot = undefined;
    }

    const { resourceText, expandedExtensionsText } = snapshot ?? {
      resourceText: "",
      expandedExtensionsText: undefined,
    };
    const candidateResources = resourceText
      ? parseWelcomeResources(
          resourceText,
          getLocalExtensionNames(),
          expandedExtensionsText,
        )
      : undefined;
    // Do not alter a partial panel: resource discovery may still be filling it.
    const resourcePanelIsComplete = Boolean(
      candidateResources?.extensions.some(isWelcomeScreenExtension),
    );
    if (resourcePanelIsComplete && panel && snapshot) {
      this.bridges.set(
        panel,
        removeKnownResourceChildren(panel, snapshot.knownChildren),
      );
      this.resources = candidateResources;
      this.notice = undefined;
      this.clearRenderCache();
      // The document height changed. Force a redraw so retained diagnostics or
      // third-party rows cannot leave stale content below the custom header.
      this.tui.requestRender(true);
    } else if (attempt === 0) {
      this.tui.requestRender(forceInitialRender);
    }

    // Keep watching briefly after capture. On /reload Pi can rebuild its native
    // resource children after session_start; a later snapshot must replace the
    // stale generation rather than appearing below the custom summary.
    if (attempt < MAX_RESOURCE_RETRIES) {
      this.resourceReadyTimer = setTimeout(
        () => this.captureResourcesWhenReady(false, attempt + 1),
        RESOURCE_POLL_INTERVAL_MS,
      );
      return;
    }

    this.resourceReadyTimer = undefined;
    if (!this.sawResourcePanel) {
      this.notice = LAYOUT_NOTICE;
      this.clearRenderCache();
      this.tui.requestRender(false);
    }
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
    const lines = renderCenteredWelcome(
      resources,
      this.theme,
      width,
      this.notice,
    );
    if (resources) {
      this.cachedWidth = width;
      this.cachedLines = lines;
    }
    return lines;
  }

  invalidate(): void {
    this.clearRenderCache();
    for (const bridge of this.bridges.values()) bridge.panel.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resourceReadyTimer) clearTimeout(this.resourceReadyTimer);
    for (const bridge of this.bridges.values()) restoreResourcePanel(bridge);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader(
      (tui, theme) => new WelcomeHeader(tui, theme, event.reason === "startup"),
    );
  });
}
