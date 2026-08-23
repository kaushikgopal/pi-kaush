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
    this.bodyText = details.bodyText ?? details.message?.content?.text ?? "";
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inset = contentInset(width);
    const boxWidth = Math.max(1, width - inset * 2);
    const margin = " ".repeat(inset);
    const from = this.details.from ?? {};
    const senderName = from.name || from.id?.slice(0, 8) || "unknown";

    if (boxWidth < MIN_BOX_WIDTH) {
      const text = truncateToWidth(`From: ${senderName}`, boxWidth, "");
      return [margin + this.theme.fg("muted", text) + margin];
    }

    // The frame borrows the bash-mode border green — the same token Pi uses
    // for the rules around user-run `!` shell blocks. Everything textual
    // inside the frame is muted, matching tool-row summaries.
    const border = (text: string) => this.theme.fg("bashMode", text);
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
    const title = `${titlePrefix}${senderName}${from.cwd ? ` (${from.cwd})` : ""}`;
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

    const lines: string[] = [topBorder];

    if (!this.expanded) {
      this.collapsedPreview ??= this.bodyText.replace(/\s+/g, " ").trim();
      lines.push(frameLine(bodyColor(this.collapsedPreview)));

      const meta: string[] = [];
      if (this.details.replyCommand) {
        meta.push(`To reply: ${this.details.replyCommand}`);
      }
      const attachments = this.details.message?.content?.attachments;
      if (attachments?.length) {
        meta.push(
          `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
        );
      }
      const replyTo = this.details.message?.replyTo;
      if (replyTo && !this.details.message?.expectsReply) {
        meta.push(`Reply to ${replyTo.slice(0, 8)}`);
      }
      meta.push("Ctrl+O to expand");
      lines.push(frameLine(bodyColor(meta.join(" · "))));
      lines.push(bottomBorder);
      return lines;
    }

    if (this.wrappedBody?.width !== innerWidth) {
      this.wrappedBody = {
        width: innerWidth,
        lines: wrapTextWithAnsi(this.bodyText, innerWidth),
      };
    }
    for (const line of this.wrappedBody.lines) {
      lines.push(frameLine(bodyColor(line)));
    }

    if (this.details.replyCommand) {
      lines.push(frameLine(""));
      const replyLines = wrapTextWithAnsi(
        bodyColor(`To reply: ${this.details.replyCommand}`),
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
        lines.push(frameLine(bodyColor(`Attachment: ${attachment.name}`)));
      }
    }

    const replyTo = this.details.message?.replyTo;
    if (replyTo && !this.details.message?.expectsReply) {
      lines.push(frameLine(""));
      lines.push(frameLine(bodyColor(`Reply to ${replyTo.slice(0, 8)}`)));
    }

    lines.push(bottomBorder);
    return lines;
  }
}

export function renderIntercomMessage(
  details: unknown,
  expanded: boolean,
  theme: Theme,
): Component | undefined {
  if (!details || typeof details !== "object") return undefined;
  const intercom = details as IntercomMessageDetails;
  const text = intercom.bodyText ?? intercom.message?.content?.text;
  if (typeof text !== "string") return undefined;
  return new IntercomMessageComponent(intercom, expanded, theme);
}
