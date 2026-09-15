import type { DragEventHandler, MouseEventHandler, ReactNode } from "react";
import styles from "./Card.module.css";

export type CardTone = "default" | "raised";
export type CardPadding = "sm" | "md" | "lg";

const toneClass: Record<CardTone, string | undefined> = {
  default: undefined,
  raised: styles.raised,
};

const paddingClass: Record<CardPadding, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

function classes(
  tone: CardTone,
  padding: CardPadding,
  interactive: boolean,
  selected: boolean,
  className: string | undefined,
): string {
  return [
    styles.base,
    paddingClass[padding],
    toneClass[tone],
    interactive ? styles.interactive : undefined,
    selected ? styles.selected : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface CardProps {
  children: ReactNode;
  as?: "div" | "li";
  tone?: CardTone;
  padding?: CardPadding;
  interactive?: boolean;
  selected?: boolean;
  className?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLElement>;
  onDragOver?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
  onDragEnd?: DragEventHandler<HTMLElement>;
}

export function Card({
  children,
  as: Tag = "div",
  tone = "default",
  padding = "md",
  interactive = false,
  selected = false,
  className,
  onClick,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: CardProps) {
  return (
    <Tag
      className={classes(tone, padding, interactive, selected, className)}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {children}
    </Tag>
  );
}
