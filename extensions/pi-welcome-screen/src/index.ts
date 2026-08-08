import {
  CONFIG_DIR_NAME,
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  type Component,
  type Container,
  Spacer,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const MAX_STACKED_COLUMN_WIDTH = 80;
const MIN_GRID_COLUMN_WIDTH = 40;
const GRID_COLUMN_GAP = 4;
const BRAND_COLUMN_WIDTH = 24;
const MAX_RESOURCE_COLUMN_WIDTH = 72;
const MAX_EXTENSION_COLUMN_WIDTH = 120;
const MAX_LIST_ROWS_PER_COLUMN = 6;
const MIN_LIST_COLUMN_WIDTH = 22;
const LIST_COLUMN_GAP = 2;
const RESOURCE_POLL_INTERVAL_MS = 50;
const MAX_RESOURCE_RETRIES = 3;
const EXTENSION_SETTINGS_KEY = "welcomeScreen";

export interface WelcomeSettings {
  showCounts: boolean;
  showWorkspace: boolean;
  showEstimate: boolean;
  showHealth: boolean;
  sourcePathDisplay: "full" | "compact";
  splitExtensionsAt: number | false;
}

export const DEFAULT_WELCOME_SETTINGS: Readonly<WelcomeSettings> = {
  showCounts: true,
  showWorkspace: false,
  showEstimate: true,
  showHealth: true,
  sourcePathDisplay: "full",
  splitExtensionsAt: 180,
};

export interface WelcomeEstimate {
  promptChars: number;
  promptTokens: number;
  denominator: number;
  activeTools?: number | undefined;
  model?: string | undefined;
  contextWindow?: number | undefined;
}

export interface LoadedWelcomeSettings {
  settings: WelcomeSettings;
  warnings: string[];
}

interface WelcomeDisplayContext {
  settings: WelcomeSettings;
  workspace: string[];
  estimate: WelcomeEstimate | undefined;
  healthWarnings: string[];
}

export interface WelcomeRenderOptions {
  settings?: Partial<WelcomeSettings>;
  workspace?: string[];
  estimate?: WelcomeEstimate | undefined;
  healthWarnings?: string[];
}

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
  addChild: (component: Component) => void;
  removeChild: (component: Component) => void;
}

interface ResourceBridge {
  panel: ResourcePanel;
  removedChildren: Component[];
}

interface ResourcePanelSnapshot {
  resourceText: string;
  expandedExtensionsText?: string;
  knownChildren: Component[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSettingsObject(
  settingsPath: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (isRecord(parsed)) return parsed;
    warnings.push(`${settingsPath}: expected a JSON object.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return undefined;
}

function readWelcomeSettingsBlock(
  settingsPath: string,
  warnings: string[],
): Partial<WelcomeSettings> {
  const root = readSettingsObject(settingsPath, warnings);
  if (!root || root[EXTENSION_SETTINGS_KEY] === undefined) return {};
  const raw = root[EXTENSION_SETTINGS_KEY];
  if (!isRecord(raw)) {
    warnings.push(
      `${settingsPath}:${EXTENSION_SETTINGS_KEY} must be an object.`,
    );
    return {};
  }

  const result: Partial<WelcomeSettings> = {};
  for (const field of [
    "showCounts",
    "showWorkspace",
    "showEstimate",
    "showHealth",
  ] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] === "boolean") result[field] = raw[field];
    else
      warnings.push(
        `${settingsPath}:${EXTENSION_SETTINGS_KEY}.${field} must be a boolean.`,
      );
  }

  if (raw.sourcePathDisplay !== undefined) {
    if (
      raw.sourcePathDisplay === "full" ||
      raw.sourcePathDisplay === "compact"
    ) {
      result.sourcePathDisplay = raw.sourcePathDisplay;
    } else {
      warnings.push(
        `${settingsPath}:${EXTENSION_SETTINGS_KEY}.sourcePathDisplay must be "full" or "compact".`,
      );
    }
  }

  if (raw.splitExtensionsAt !== undefined) {
    if (
      raw.splitExtensionsAt === false ||
      (typeof raw.splitExtensionsAt === "number" &&
        Number.isSafeInteger(raw.splitExtensionsAt) &&
        raw.splitExtensionsAt > 0)
    ) {
      result.splitExtensionsAt = raw.splitExtensionsAt;
    } else {
      warnings.push(
        `${settingsPath}:${EXTENSION_SETTINGS_KEY}.splitExtensionsAt must be a positive integer or false.`,
      );
    }
  }

  const knownFields = new Set([
    "showCounts",
    "showWorkspace",
    "showEstimate",
    "showHealth",
    "sourcePathDisplay",
    "splitExtensionsAt",
  ]);
  for (const field of Object.keys(raw)) {
    if (!knownFields.has(field)) {
      warnings.push(
        `${settingsPath}:${EXTENSION_SETTINGS_KEY}.${field} is not supported.`,
      );
    }
  }
  return result;
}

function compactCount(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const unit = value >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = unit === 1_000_000 ? "M" : "k";
  return `${(value / unit).toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

// Keep this deliberately smaller than a context inspector: Claude is the material
// exception to the honest chars/4 fallback for Pi-shaped system text. These ratios
// follow pi-contextimate's measured family boundary; tool schemas stay excluded because
// provider wire transforms need a substantially larger, provider-specific estimator.
function promptTokenDenominator(
  model:
    | Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">
    | undefined,
): number {
  if (!model) return 4;
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  if (!provider.includes("anthropic") && !id.includes("claude")) return 4;
  if (
    /claude.*(?:4[-.]?[7-9](?=$|[-.:@])|(?:fable|opus|sonnet|haiku)[-.]?5(?=$|[-.:@]))|4[-.]?[7-9](?=$|[-.:@]).*claude/.test(
      id,
    )
  )
    return 2.6;
  if (/claude.*4[-.]?[56]|4[-.]?[56].*claude/.test(id)) return 3.8;
  return 3.5;
}

export function buildWelcomeEstimate(
  pi: Pick<ExtensionAPI, "getActiveTools">,
  ctx: Pick<ExtensionContext, "getSystemPrompt" | "model">,
): WelcomeEstimate | undefined {
  let prompt: string;
  try {
    prompt = ctx.getSystemPrompt();
  } catch {
    return undefined;
  }
  if (!prompt) return undefined;

  let activeTools: number | undefined;
  try {
    activeTools = pi.getActiveTools().length;
  } catch {
    activeTools = undefined;
  }

  const denominator = promptTokenDenominator(ctx.model);
  const contextWindow = ctx.model?.contextWindow;
  return {
    promptChars: prompt.length,
    promptTokens: Math.ceil(prompt.length / denominator),
    denominator,
    activeTools,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    contextWindow:
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0
        ? contextWindow
        : undefined,
  };
}

export function loadWelcomeSettings(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
): LoadedWelcomeSettings {
  const warnings: string[] = [];
  const globalSettings = readWelcomeSettingsBlock(
    join(agentDir, "settings.json"),
    warnings,
  );
  const projectSettings = projectTrusted
    ? readWelcomeSettingsBlock(
        join(cwd, CONFIG_DIR_NAME, "settings.json"),
        warnings,
      )
    : {};
  return {
    settings: {
      ...DEFAULT_WELCOME_SETTINGS,
      ...globalSettings,
      ...projectSettings,
    },
    warnings,
  };
}

function getWorkspaceLines(cwd: string, sessionReason: string): string[] {
  let root = cwd;
  while (!existsSync(join(root, ".git"))) {
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }

  if (!existsSync(join(root, ".git"))) {
    const displayPath = cwd.startsWith(`${homedir()}/`)
      ? `~/${relative(homedir(), cwd)}`
      : cwd;
    return [basename(cwd), displayPath, `Session: ${sessionReason}`];
  }

  const relativeCwd = relative(root, cwd);
  return [
    basename(root),
    ...(relativeCwd ? [relativeCwd] : []),
    `Session: ${sessionReason}`,
  ];
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
    if (typeof collapsible.getCollapsedText === "function") {
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
      } else if (heading === "Themes") knownChildren.push(child);
      continue;
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

function getLocalExtensionName(
  path: string,
  localExtensionNames: Set<string>,
): string | undefined {
  const normalizedPath = path.replace(/\\/g, "/");
  const pathName = normalizedPath.match(
    /(?:^|\/)\.pi\/(?:agent\/)?extensions\/([^/]+)(?:\/|$)/,
  )?.[1];
  if (pathName) return normalizeExtensionName(pathName);

  const name = normalizeExtensionName(path);
  return localExtensionNames.has(name) ? name : undefined;
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

    const localName = getLocalExtensionName(path, localExtensionNames);
    if (localName) localExtensions.push(localName);
    else sourceExtensions.push(path.replace(/\\/g, "/"));
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

interface ResourcePanelMatch {
  panel: ResourcePanel;
  snapshot: ResourcePanelSnapshot;
}

function inspectResourceCandidate(
  candidate: Component | undefined,
): ResourcePanelMatch | undefined {
  if (!isResourcePanel(candidate)) return undefined;
  const snapshot = inspectResourcePanel(candidate);
  return snapshot.resourceText ? { panel: candidate, snapshot } : undefined;
}

function findResourcePanel(tui: TUI): ResourcePanelMatch | undefined {
  // Pi 0.84 keeps one document container in both renderers. Fullscreen wraps
  // that stable document in a ScrollView, but the mounted TUI children remain
  // [document, dock...]. Keep this bridge surgical: never walk or render the
  // transcript, editor, layout stacks, or scroll views.
  const document = tui.children[0];
  if (isResourcePanel(document)) {
    const nested = inspectResourceCandidate(document.children[1]);
    if (nested) return nested;
  }

  // Pi 0.80 mounted the startup-resource panel directly after the header.
  return inspectResourceCandidate(tui.children[1]);
}

function getKnownChildHeadings(component: Component): Set<string> {
  const collapsible = component as CollapsedTextComponent;
  if (typeof collapsible.getCollapsedText !== "function") return new Set();
  return new Set(
    stripAnsi(collapsible.getCollapsedText())
      .split("\n")
      .map((line) => line.trim().match(/^\[([^\]]+)\]$/)?.[1])
      .filter((heading): heading is string =>
        Boolean(
          heading &&
            (heading === "Themes" ||
              WELCOME_SECTIONS.some((section) => section === heading)),
        ),
      ),
  );
}

function removeKnownResourceChildren(
  panel: ResourcePanel,
  knownChildren: Component[],
  previous?: ResourceBridge,
): ResourceBridge {
  // Never clear and replay this container. Third-party startup components may
  // self-heal from a transient detach and insert the same logical block twice.
  const currentChildren = [...panel.children];
  const known = new Set(
    knownChildren.filter((child) => currentChildren.includes(child)),
  );
  const removedChildren = currentChildren.filter((child, index) => {
    if (known.has(child)) return true;
    if (!(child instanceof Spacer)) return false;
    const previousChild = currentChildren[index - 1];
    const nextChild = currentChildren[index + 1];
    return Boolean(
      (previousChild && known.has(previousChild)) ||
        (nextChild && known.has(nextChild)),
    );
  });
  for (const child of removedChildren) panel.removeChild(child);

  if (!previous || previous.panel !== panel) return { panel, removedChildren };

  // Reload may rebuild Pi's native resource components after session_start.
  // Retain only the newest component for each known section so dispose() cannot
  // restore stale and current copies of the same native startup information.
  const replacementHeadings = new Set(
    removedChildren.flatMap((child) => [...getKnownChildHeadings(child)]),
  );
  const removedNewSpacers = removedChildren.some(
    (child) => child instanceof Spacer,
  );
  if (removedNewSpacers) {
    return {
      panel,
      removedChildren: [
        ...previous.removedChildren.filter(
          (child) =>
            !(child instanceof Spacer) &&
            [...getKnownChildHeadings(child)].every(
              (heading) => !replacementHeadings.has(heading),
            ),
        ),
        ...removedChildren,
      ],
    };
  }

  // A reload can replace just the collapsible component while leaving Pi's
  // existing spacers detached in our bridge. Put the replacement back into the
  // old component's slot so dispose() restores the native section spacing.
  const replacementChildren = removedChildren.filter(
    (child) => !(child instanceof Spacer),
  );
  let insertedReplacement = false;
  const mergedChildren = previous.removedChildren.flatMap((child) => {
    const replacesChild = [...getKnownChildHeadings(child)].some((heading) =>
      replacementHeadings.has(heading),
    );
    if (!replacesChild) return [child];
    if (insertedReplacement) return [];
    insertedReplacement = true;
    return replacementChildren;
  });
  if (!insertedReplacement) mergedChildren.push(...replacementChildren);
  return { panel, removedChildren: mergedChildren };
}

function restoreResourcePanel(bridge: ResourceBridge | undefined): void {
  if (!bridge) return;
  for (const child of bridge.removedChildren) {
    if (!bridge.panel.children.includes(child)) bridge.panel.addChild(child);
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

function compactSourcePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  for (const marker of ["extensions", "packages", "standalone"]) {
    const markerIndex = segments.lastIndexOf(marker);
    const owner = segments[markerIndex + 1];
    if (markerIndex !== -1 && owner) {
      return owner.replace(/\.(?:[cm]?[jt]s)$/, "");
    }
  }

  const last = segments.at(-1) ?? normalized;
  const fileStem = last.replace(/\.(?:[cm]?[jt]s)$/, "");
  if (fileStem !== last && !/^(?:index|extension|main)$/.test(fileStem)) {
    return fileStem;
  }

  const genericTail =
    /^(?:src|lib|dist|index|extension|main)(?:\.[cm]?[jt]s)?$/;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment && !genericTail.test(segment)) return segment;
  }
  return last;
}

function formatSourcePathLabels(
  paths: string[],
  display: WelcomeSettings["sourcePathDisplay"],
): string[] {
  if (display === "full") return paths;
  const labels = paths.map(compactSourcePath);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return labels.map((label, index) =>
    counts.get(label) === 1 ? label : (paths[index] ?? label),
  );
}

function appendExtensionsSection(
  lines: string[],
  extensions: string[],
  packageExtensionNames: string[] | undefined,
  sourceExtensionNames: string[] | undefined,
  theme: Theme,
  columnWidth: number,
  sharedColumnCount: 2 | 3,
  terminalWidth: number,
  settings: WelcomeSettings,
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
    { title: "Local", items: localExtensions },
    {
      title: "Packages",
      items: installedPackageExtensions,
    },
    {
      title: "Source paths",
      items: formatSourcePathLabels(
        linkedSourceExtensions,
        settings.sourcePathDisplay,
      ),
    },
  ].filter(({ items }) => items.length > 0);
  const splitNonLocalGroups =
    settings.splitExtensionsAt !== false &&
    terminalWidth >= settings.splitExtensionsAt;
  const multiColumnGroups = groups.filter(
    (group) =>
      group.title === "Local" ||
      (splitNonLocalGroups &&
        (group.title === "Packages" ||
          (group.title === "Source paths" &&
            settings.sourcePathDisplay === "compact"))),
  );
  for (const [index, group] of groups.entries()) {
    if (index > 0) lines.push("");
    lines.push(theme.fg("muted", `  ${group.title}`));
    if (multiColumnGroups.includes(group)) {
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

function renderBrandColumn(
  resources: WelcomeResources | undefined,
  theme: Theme,
  columnWidth: number,
  display: WelcomeDisplayContext,
): string[] {
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

  if (resources && display.settings.showCounts) {
    const countRows = [
      `${resources.context.length} ctx · ${resources.skills.length} ${resources.skills.length === 1 ? "skill" : "skills"}`,
      `${resources.prompts.length} ${resources.prompts.length === 1 ? "prompt" : "prompts"} · ${resources.extensions.length} ext`,
    ];
    lines.push("");
    for (const countRow of countRows) {
      const themedRow = theme.fg("dim", countRow);
      lines.push(
        centerBlockLine(themedRow, visibleWidth(themedRow), columnWidth),
      );
    }
  }

  if (display.settings.showWorkspace && display.workspace.length > 0) {
    lines.push("", theme.fg("mdHeading", "[Workspace]"));
    appendSingleColumnRows(lines, display.workspace, theme, columnWidth);
  }
  return lines;
}

function appendHealthSection(
  lines: string[],
  display: WelcomeDisplayContext,
  theme: Theme,
  columnWidth: number,
): void {
  if (!display.settings.showHealth || display.healthWarnings.length === 0)
    return;
  if (lines.length > 0) lines.push("");
  lines.push(theme.fg("mdHeading", "[Health]"));
  appendSingleColumnRows(lines, display.healthWarnings, theme, columnWidth);
}

function appendEstimateSection(
  lines: string[],
  display: WelcomeDisplayContext,
  theme: Theme,
  columnWidth: number,
): void {
  const estimate = display.estimate;
  if (!display.settings.showEstimate || !estimate) return;

  const rows: string[] = [];
  if (estimate.model) {
    rows.push(
      estimate.contextWindow
        ? `${estimate.model} · ${compactCount(estimate.contextWindow)} ctx`
        : estimate.model,
    );
  }
  rows.push(
    `System prompt ~${compactCount(estimate.promptTokens)} tokens (${compactCount(estimate.promptChars)} ch ÷ ${estimate.denominator})`,
  );
  if (estimate.activeTools !== undefined) {
    rows.push(
      `${estimate.activeTools} active ${estimate.activeTools === 1 ? "tool" : "tools"} · schemas excluded`,
    );
  }

  if (lines.length > 0) lines.push("");
  lines.push(theme.fg("mdHeading", "[Estimate]"));
  appendSingleColumnRows(lines, rows, theme, columnWidth);
}

function appendResourceSection(
  lines: string[],
  title: WelcomeSection,
  resources: WelcomeResources,
  theme: Theme,
  columnWidth: number,
  sharedColumnCount: 2 | 3,
  terminalWidth: number,
  display: WelcomeDisplayContext,
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
      terminalWidth,
      display.settings,
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
  if (title === "Prompts") {
    appendEstimateSection(lines, display, theme, columnWidth);
    appendHealthSection(lines, display, theme, columnWidth);
  }
}

function renderResourceColumn(
  resources: WelcomeResources,
  theme: Theme,
  columnWidth: number,
  terminalWidth: number,
  display: WelcomeDisplayContext,
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
      terminalWidth,
      display,
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
  terminalWidth: number,
  display: WelcomeDisplayContext,
): string[] {
  if (item === "Brand")
    return renderBrandColumn(resources, theme, columnWidth, display);

  const lines: string[] = [];
  appendResourceSection(
    lines,
    item,
    resources,
    theme,
    columnWidth,
    sharedColumnCount,
    terminalWidth,
    display,
  );
  return lines;
}

function renderGridWelcome(
  resources: WelcomeResources,
  theme: Theme,
  columnWidths: readonly number[],
  columnCount: 2 | 3,
  terminalWidth: number,
  display: WelcomeDisplayContext,
): string[] {
  const resourceColumnWidths = GRID_COLUMNS[columnCount].flatMap(
    (items, column) =>
      items.some((item) => item !== "Brand") ? [columnWidths[column] ?? 1] : [],
  );
  const sharedColumnCount = resourceColumnWidths.every(
    (columnWidth) => getSharedMultiColumnCount(resources, columnWidth) === 3,
  )
    ? 3
    : 2;
  const topAlignedColumns = GRID_COLUMNS[columnCount].map((items, column) =>
    items.flatMap((item, index) => [
      ...(index > 0 ? [""] : []),
      ...renderGridItem(
        item,
        resources,
        theme,
        columnWidths[column] ?? 1,
        sharedColumnCount,
        terminalWidth,
        display,
      ),
    ]),
  );
  const rowCount = Math.max(
    ...topAlignedColumns.map((column) => column.length),
  );
  if (columnCount === 2) {
    const layoutWidth =
      (columnWidths[0] ?? 0) + GRID_COLUMN_GAP + (columnWidths[1] ?? 0);
    const resourceRows = Array.from({ length: rowCount }, (_, row) =>
      topAlignedColumns
        .map((column, index) =>
          padToWidth(column[row] ?? "", columnWidths[index] ?? 1),
        )
        .join(" ".repeat(GRID_COLUMN_GAP))
        .trimEnd(),
    );
    return [
      "",
      ...renderBrandColumn(resources, theme, layoutWidth, display),
      "",
      ...resourceRows,
    ];
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
      .map((column, index) =>
        padToWidth(column[row] ?? "", columnWidths[index] ?? 1),
      )
      .join(" ".repeat(GRID_COLUMN_GAP))
      .trimEnd(),
  );
}

function renderStackedWelcome(
  resources: WelcomeResources | undefined,
  theme: Theme,
  columnWidth: number,
  display: WelcomeDisplayContext,
): string[] {
  const lines = [
    "",
    ...renderBrandColumn(resources, theme, columnWidth, display),
  ];
  if (resources)
    lines.push(
      "",
      ...renderResourceColumn(
        resources,
        theme,
        columnWidth,
        columnWidth,
        display,
      ),
    );
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

function splitResourceWidths(availableWidth: number): [number, number] {
  const totalWidth = Math.min(
    availableWidth,
    MAX_RESOURCE_COLUMN_WIDTH + MAX_EXTENSION_COLUMN_WIDTH,
  );
  let extensionWidth = Math.floor(totalWidth * 0.6);
  let resourceWidth = totalWidth - extensionWidth;

  if (resourceWidth < MIN_GRID_COLUMN_WIDTH) {
    resourceWidth = MIN_GRID_COLUMN_WIDTH;
    extensionWidth = totalWidth - resourceWidth;
  } else if (extensionWidth < MIN_GRID_COLUMN_WIDTH) {
    extensionWidth = MIN_GRID_COLUMN_WIDTH;
    resourceWidth = totalWidth - extensionWidth;
  }

  if (resourceWidth > MAX_RESOURCE_COLUMN_WIDTH) {
    resourceWidth = MAX_RESOURCE_COLUMN_WIDTH;
    extensionWidth = totalWidth - resourceWidth;
  } else if (extensionWidth > MAX_EXTENSION_COLUMN_WIDTH) {
    extensionWidth = MAX_EXTENSION_COLUMN_WIDTH;
    resourceWidth = totalWidth - extensionWidth;
  }

  return [resourceWidth, extensionWidth];
}

function getGridColumnWidths(width: number, columnCount: 2 | 3): number[] {
  const gapWidth = GRID_COLUMN_GAP * (columnCount - 1);
  if (columnCount === 2) return splitResourceWidths(width - gapWidth);

  const availableResourceWidth = Math.min(
    width - gapWidth - BRAND_COLUMN_WIDTH,
    MAX_RESOURCE_COLUMN_WIDTH + MAX_EXTENSION_COLUMN_WIDTH,
  );
  return [BRAND_COLUMN_WIDTH, ...splitResourceWidths(availableResourceWidth)];
}

export function renderCenteredWelcome(
  resources: WelcomeResources | undefined,
  theme: Theme,
  width: number,
  options: WelcomeRenderOptions = {},
): string[] {
  if (width <= 0) return [];
  const requestedSettings = options.settings;
  const display: WelcomeDisplayContext = {
    settings: {
      showCounts:
        requestedSettings?.showCounts ?? DEFAULT_WELCOME_SETTINGS.showCounts,
      showWorkspace:
        requestedSettings?.showWorkspace ??
        DEFAULT_WELCOME_SETTINGS.showWorkspace,
      showEstimate:
        requestedSettings?.showEstimate ??
        DEFAULT_WELCOME_SETTINGS.showEstimate,
      showHealth:
        requestedSettings?.showHealth ?? DEFAULT_WELCOME_SETTINGS.showHealth,
      sourcePathDisplay:
        requestedSettings?.sourcePathDisplay ??
        DEFAULT_WELCOME_SETTINGS.sourcePathDisplay,
      splitExtensionsAt:
        requestedSettings?.splitExtensionsAt ??
        DEFAULT_WELCOME_SETTINGS.splitExtensionsAt,
    },
    workspace: [...(options.workspace ?? [])],
    estimate: options.estimate,
    healthWarnings: [...(options.healthWarnings ?? [])],
  };
  const columnCount = resources ? getGridColumnCount(width) : 1;
  const columnWidths =
    columnCount === 1
      ? [Math.min(MAX_STACKED_COLUMN_WIDTH, width)]
      : getGridColumnWidths(width, columnCount);
  const layoutWidth =
    columnWidths.reduce((total, columnWidth) => total + columnWidth, 0) +
    GRID_COLUMN_GAP * (columnCount - 1);
  const leftPadding = " ".repeat(Math.floor((width - layoutWidth) / 2));
  const lines =
    columnCount !== 1 && resources
      ? renderGridWelcome(
          resources,
          theme,
          columnWidths,
          columnCount,
          width,
          display,
        )
      : renderStackedWelcome(resources, theme, layoutWidth, display);

  return lines.map((line) =>
    line ? leftPadding + truncateToWidth(line, layoutWidth, "") : "",
  );
}

class WelcomeHeader implements Component {
  private resourceReadyTimer: ReturnType<typeof setTimeout> | undefined;
  private resources: WelcomeResources | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private bridges: ResourceBridge[] = [];
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    forceInitialRender: boolean,
    private readonly display: WelcomeDisplayContext,
  ) {
    // Resource discovery and the loaded-resource panel are finalized after
    // session_start. Search lazily so both regular and fullscreen TUI layouts
    // work without relying on a root child index.
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

    let match: ResourcePanelMatch | undefined;
    try {
      match = findResourcePanel(this.tui);
    } catch {
      match = undefined;
    }

    const { resourceText, expandedExtensionsText } = match?.snapshot ?? {
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
    // Do not detach a partial panel: resource discovery may still be filling it
    // after the first render tick.
    const resourcePanelIsComplete = Boolean(
      candidateResources?.extensions.some(isWelcomeScreenExtension),
    );
    if (resourcePanelIsComplete && match) {
      const bridgeIndex = this.bridges.findIndex(
        (bridge) => bridge.panel === match.panel,
      );
      const previousBridge =
        bridgeIndex === -1 ? undefined : this.bridges[bridgeIndex];
      const bridge = removeKnownResourceChildren(
        match.panel,
        match.snapshot.knownChildren,
        previousBridge,
      );
      if (bridgeIndex === -1) this.bridges.push(bridge);
      else this.bridges[bridgeIndex] = bridge;
      this.resources = candidateResources;
      this.clearRenderCache();
      // Removing native rows changes the document height. Main-screen rendering
      // needs a full redraw or stale rows can survive below the retained startup
      // components and look like duplicated third-party blocks.
      this.tui.requestRender(true);
    } else if (attempt === 0) {
      this.tui.requestRender(forceInitialRender);
    }

    // Keep watching briefly after the first successful capture. During /reload,
    // Pi can replace its native resource component after session_start; stopping
    // at the first match leaves both the custom and rebuilt native panels visible.
    if (attempt < MAX_RESOURCE_RETRIES) {
      this.resourceReadyTimer = setTimeout(
        () => this.captureResourcesWhenReady(false, attempt + 1),
        RESOURCE_POLL_INTERVAL_MS,
      );
    } else {
      // The panel was absent, incomplete, or unfamiliar. It was never moved,
      // so leave Pi's native startup information untouched.
      this.resourceReadyTimer = undefined;
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
      this.display,
    );
    if (resources) {
      this.cachedWidth = width;
      this.cachedLines = lines;
    }
    return lines;
  }

  invalidate(): void {
    this.clearRenderCache();
    for (const bridge of this.bridges) bridge.panel.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resourceReadyTimer) clearTimeout(this.resourceReadyTimer);
    for (const bridge of this.bridges) restoreResourcePanel(bridge);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    const loaded = loadWelcomeSettings(ctx.cwd, ctx.isProjectTrusted());
    const display: WelcomeDisplayContext = {
      settings: loaded.settings,
      workspace: loaded.settings.showWorkspace
        ? getWorkspaceLines(ctx.cwd, event.reason)
        : [],
      estimate: loaded.settings.showEstimate
        ? buildWelcomeEstimate(pi, ctx)
        : undefined,
      healthWarnings: loaded.warnings,
    };

    ctx.ui.setHeader(
      (tui, theme) =>
        new WelcomeHeader(tui, theme, event.reason === "startup", display),
    );
  });
}
