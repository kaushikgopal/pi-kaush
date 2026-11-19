import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { contentInset } from "./render.ts";

// Structural mirror of pi-intercom's `intercom_message` details payload, so
// this package can restyle the message without depending on pi-intercom.
// Malformed payloads make the renderer return undefined, which drops back to
// pi-intercom's own box (or Pi's default custom-message box).
export type IntercomMessageDetails = {
  from?: { id?: string; name?: string; cwd?: string };
  message?: {
    replyTo?: string;
    expectsReply?: boolean;
    content?: { text?: string; attachments?: { name?: string }[] };
  };
  replyCommand?: string;
  bodyText?: string;
};

// Geometry contract with the rest of the transcript: the frame's left border
// sits on the tool-marker column (contentInset), and title/body text start
// two columns inside the frame, sharing the text column used by tool rows
// and Thought labels. A frame needs room for "│ x │", so below MIN_BOX_WIDTH
// the message degrades to plain truncated text instead of a broken frame.
const MIN_BOX_WIDTH = 8;

class IntercomMessageComponent implements Component {
  private readonly bodyText: string;
  private collapsedPreview?: string;
  // Cache is keyed by frame width; a fresh component is built by Pi on every
  // expand toggle or invalidate(), so theme styling can live inside it.
  private wrappedBody?: { width: number; lines: string[] };

  constructor(
    private readonly details: IntercomMessageDetails,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {
    this.bodyText = sanitizeIntercomText(
      details.bodyText ?? details.message?.content?.text ?? "",
      true,
    );
  }

  invalidate(): void {}

  render(width: number): string[] {
    // Pi only chooses its default box at rebuild time. Until then the
    // registered component can still display the body it already captured.
    return (
      this.renderFrame(width) ??
      wrapTextWithAnsi(this.bodyText, Math.max(1, width)).map((line) =>
        truncateToWidth(line, width, ""),
      )
    );
  }

  renderFrame(width: number): string[] | undefined {
    // Metadata stays live, so the construction check cannot protect these reads.
    if (!hasValidIntercomFields(this.details, "live")) return undefined;

    const inset = contentInset(width);
    const boxWidth = Math.max(1, width - inset * 2);
    const margin = " ".repeat(inset);
    const from = this.details.from ?? {};
    const senderName =
      sanitizeIntercomText(from.name ?? "") ||
      sanitizeIntercomText(from.id ?? "").slice(0, 8) ||
      "unknown";
    const cwd = sanitizeIntercomText(from.cwd ?? "");

    if (boxWidth < MIN_BOX_WIDTH) {
      const text = truncateToWidth(`From: ${senderName}`, boxWidth, "");
      return [margin + this.theme.fg("muted", text) + margin];
    }

    // The frame borrows customMessageLabel — Pi's token for extension-message
    // labels (orange in cobalt2) — so the border matches the sender name.
    // Everything textual inside the frame is muted, matching tool-row summaries.
    const border = (text: string) => this.theme.fg("customMessageLabel", text);
    const bodyColor = (text: string) => this.theme.fg("muted", text);
    // Columns inside the frame: │ + space + content(innerWidth) + space + │.
    const innerWidth = boxWidth - 4;

    const frameLine = (content: string): string => {
      const text = truncateToWidth(content, innerWidth, "");
      const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
      return `${margin}${border("│")} ${text}${fill} ${border("│")}${margin}`;
    };
    const bottomBorder = `${margin}${border(`╰${"─".repeat(boxWidth - 2)}╯`)}${margin}`;

    // The sender name alone rides customMessageLabel — Pi's token for the
    // label of an extension message (orange in cobalt2).
    const titlePrefix = "From: ";
    const title = `${titlePrefix}${senderName}${cwd ? ` (${cwd})` : ""}`;
    const titleText = truncateToWidth(title, Math.max(1, innerWidth - 1), "");
    const nameEnd = Math.min(
      titleText.length,
      titlePrefix.length + senderName.length,
    );
    const styledTitle =
      bodyColor(titleText.slice(0, titlePrefix.length)) +
      this.theme.fg(
        "customMessageLabel",
        titleText.slice(titlePrefix.length, nameEnd),
      ) +
      bodyColor(titleText.slice(nameEnd));
    const dashes = "─".repeat(
      Math.max(1, innerWidth - visibleWidth(titleText)),
    );
    const topBorder = `${margin}${border("╭")} ${styledTitle} ${border(dashes + "╮")}${margin}`;

    const contentLines = this.expanded
      ? this.renderExpanded(innerWidth, frameLine, bodyColor)
      : this.renderCollapsed(frameLine, bodyColor);
    return [topBorder, ...contentLines, bottomBorder];
  }

  private renderCollapsed(
    frameLine: (content: string) => string,
    bodyColor: (text: string) => string,
  ): string[] {
    this.collapsedPreview ??= this.bodyText.replace(/\s+/g, " ").trim();
    const lines = [frameLine(bodyColor(this.collapsedPreview))];

    const meta: string[] = [];
    const replyCommand = sanitizeIntercomText(this.details.replyCommand ?? "");
    if (replyCommand) {
      meta.push(`To reply: ${replyCommand}`);
    }
    const attachments = this.details.message?.content?.attachments;
    if (attachments?.length) {
      meta.push(
        `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
      );
    }
    const replyTo = sanitizeIntercomText(this.details.message?.replyTo ?? "");
    if (replyTo && !this.details.message?.expectsReply) {
      meta.push(`Reply to ${replyTo.slice(0, 8)}`);
    }
    meta.push("Ctrl+O to expand");
    lines.push(frameLine(bodyColor(meta.join(" · "))));
    return lines;
  }

  private renderExpanded(
    innerWidth: number,
    frameLine: (content: string) => string,
    bodyColor: (text: string) => string,
  ): string[] {
    if (this.wrappedBody?.width !== innerWidth) {
      this.wrappedBody = {
        width: innerWidth,
        lines: wrapTextWithAnsi(this.bodyText, innerWidth),
      };
    }
    const lines = this.wrappedBody.lines.map((line) =>
      frameLine(bodyColor(line)),
    );

    const replyCommand = sanitizeIntercomText(this.details.replyCommand ?? "");
    if (replyCommand) {
      lines.push(frameLine(""));
      const replyLines = wrapTextWithAnsi(
        bodyColor(`To reply: ${replyCommand}`),
        innerWidth,
      );
      for (const line of replyLines) {
        lines.push(frameLine(line));
      }
    }

    const attachments = this.details.message?.content?.attachments;
    if (attachments?.length) {
      lines.push(frameLine(""));
      for (const attachment of attachments) {
        const name = sanitizeIntercomText(`${attachment.name}`);
        lines.push(frameLine(bodyColor(`Attachment: ${name}`)));
      }
    }

    const replyTo = sanitizeIntercomText(this.details.message?.replyTo ?? "");
    if (replyTo && !this.details.message?.expectsReply) {
      lines.push(frameLine(""));
      lines.push(frameLine(bodyColor(`Reply to ${replyTo.slice(0, 8)}`)));
    }
    return lines;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function hasValidIntercomFields(
  details: unknown,
  phase: "initial" | "live",
): boolean {
  if (!isRecord(details)) return false;
  if (phase === "initial" && !isOptionalString(details.bodyText)) return false;
  if (!isOptionalString(details.replyCommand)) return false;

  const from = details.from;
  if (
    from !== undefined &&
    (!isRecord(from) || ![from.id, from.name, from.cwd].every(isOptionalString))
  )
    return false;

  const message = details.message;
  if (message !== undefined) {
    if (!isRecord(message)) return false;
    if (
      !isOptionalString(message.replyTo) ||
      (message.expectsReply !== undefined &&
        typeof message.expectsReply !== "boolean")
    )
      return false;

    const content = message.content;
    if (content !== undefined) {
      if (!isRecord(content)) return false;
      if (phase === "initial" && !isOptionalString(content.text)) return false;
      const attachments = content.attachments;
      if (attachments !== undefined) {
        if (!Array.isArray(attachments)) return false;
        for (const attachment of attachments) {
          if (!isRecord(attachment) || !isOptionalString(attachment.name))
            return false;
        }
      }
    }
  }
  return true;
}

function isIntercomMessageDetails(
  details: unknown,
): details is IntercomMessageDetails {
  return hasValidIntercomFields(details, "initial");
}

// Details carry text, not terminal output. Strip external ANSI before adding
// our own theme styling; only message bodies may retain literal line feeds.
function sanitizeIntercomText(text: string, multiline = false): string {
  return stripVTControlCharacters(text).replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    (control) => (multiline && control === "\n" ? "\n" : " "),
  );
}

export function renderIntercomMessage(
  details: unknown,
  expanded: boolean,
  theme: Theme,
): Component | undefined {
  return intercomBox(details, expanded, theme);
}

function intercomBox(
  details: unknown,
  expanded: boolean,
  theme: Theme,
): IntercomMessageComponent | undefined {
  if (!isIntercomMessageDetails(details)) return undefined;
  const text = details.bodyText ?? details.message?.content?.text;
  if (typeof text !== "string") return undefined;
  return new IntercomMessageComponent(details, expanded, theme);
}

// Structural mirror of Pi's CustomMessageComponent: the fields this package
// reads to restyle a box Pi already built with another renderer.
type IntercomMessageHost = {
  message?: { customType?: unknown; details?: unknown };
  customRenderer?: unknown;
  _expanded?: unknown;
  render(width: number): string[];
};

function isIntercomMessageHost(
  child: unknown,
  ownRenderer: unknown,
): child is IntercomMessageHost {
  if (!child || typeof child !== "object") return false;
  const host = child as IntercomMessageHost;
  if (typeof host.render !== "function") return false;
  // Pi picks one renderer per customType by load order; when this package's
  // registration won, Pi already renders the styled box and there is nothing
  // left to intercept.
  if (host.customRenderer === ownRenderer) return false;
  return host.message?.customType === "intercom_message";
}

// Pi re-renders the transcript on every keystroke, so a box rebuilt per frame
// would re-wrap the body text each time. Cache per host component instead,
// keyed on the inputs that change what the box looks like.
const intercomBoxes = new WeakMap<
  object,
  {
    theme: Theme;
    details: unknown;
    expanded: boolean;
    component: IntercomMessageComponent;
  }
>();

function intercomBoxFor(
  host: IntercomMessageHost,
  details: unknown,
  expanded: boolean,
  theme: Theme,
): IntercomMessageComponent | undefined {
  const cached = intercomBoxes.get(host);
  if (
    cached &&
    cached.theme === theme &&
    cached.details === details &&
    cached.expanded === expanded
  ) {
    return cached.component;
  }
  const component = intercomBox(details, expanded, theme);
  if (!component) {
    intercomBoxes.delete(host);
    return undefined;
  }
  intercomBoxes.set(host, { theme, details, expanded, component });
  return component;
}

/**
 * Swap this package's box into an intercom message Pi rendered with another
 * extension's renderer. Pi resolves a customType's renderer by extension load
 * order (first registration wins), so the registration above only wins when
 * this package loads before pi-intercom; this hook makes the restyle hold in
 * either order.
 *
 * Returns the undo for the current render pass, or undefined when no child
 * needed intercepting. Malformed payloads fall back to the render Pi built.
 */
export function interceptIntercomMessages(
  children: unknown[],
  theme: Theme | undefined,
  ownRenderer: unknown,
): (() => void) | undefined {
  if (!theme || !Array.isArray(children)) return undefined;
  const restores: Array<() => void> = [];
  const substitute = (child: unknown) => {
    if (!isIntercomMessageHost(child, ownRenderer)) return;
    const ownRender = Object.getOwnPropertyDescriptor(child, "render");
    const originalRender = child.render;
    child.render = (width: number): string[] => {
      const box = intercomBoxFor(
        child,
        child.message?.details,
        child._expanded === true,
        theme,
      );
      const lines = box?.renderFrame(width);
      if (!lines) return originalRender.call(child, width);
      // Pi's CustomMessageComponent renders a Spacer(1) ahead of the box.
      // The swap bypasses the host's own render, so reproduce that blank
      // line to keep the frame separated from the entry above it.
      return ["", ...lines];
    };
    restores.push(() => {
      if (ownRender) Object.defineProperty(child, "render", ownRender);
      else delete (child as Partial<IntercomMessageHost>).render;
    });
  };
  const restoreRenderers = () => {
    for (const restore of restores.reverse()) restore();
  };

  try {
    for (const child of children) substitute(child);
  } catch (error) {
    // The shared runner can restore the child list, but not instance renderers.
    restoreRenderers();
    throw error;
  }
  return restores.length === 0 ? undefined : restoreRenderers;
}
