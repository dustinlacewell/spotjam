import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import styles from "./ListRow.module.css";

export type ListRowSelectionStyle = "subtle" | "fill" | "outline";
export type ListRowLayout = "flex" | "grid";

const selectionClass: Record<ListRowSelectionStyle, string> = {
  subtle: styles.subtle,
  fill: styles.fill,
  outline: styles.outline,
};

function classes(
  layout: ListRowLayout,
  selected: boolean,
  selectionStyle: ListRowSelectionStyle,
  isButton: boolean,
  className: string | undefined,
): string {
  return [
    styles.base,
    layout === "grid" ? styles.grid : undefined,
    isButton ? styles.button : undefined,
    selected ? selectionClass[selectionStyle] : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ListRowProps {
  children: ReactNode;
  as?: "button" | "div";
  selected?: boolean;
  selectionStyle?: ListRowSelectionStyle;
  layout?: ListRowLayout;
  /** Only meaningful when layout="grid". */
  gridTemplate?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  onDoubleClick?: MouseEventHandler<HTMLElement>;
}

export function ListRow({
  children,
  as = "div",
  selected = false,
  selectionStyle = "subtle",
  layout = "flex",
  gridTemplate,
  className,
  onClick,
  onDoubleClick,
}: ListRowProps) {
  const isButton = as === "button";
  const resolved = classes(
    layout,
    selected,
    selectionStyle,
    isButton,
    className,
  );
  const style: CSSProperties | undefined =
    layout === "grid" && gridTemplate !== undefined
      ? { gridTemplateColumns: gridTemplate }
      : undefined;

  if (isButton) {
    return (
      <button
        type="button"
        className={resolved}
        style={style}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        {children}
      </button>
    );
  }

  return (
    <div
      className={resolved}
      style={style}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </div>
  );
}
