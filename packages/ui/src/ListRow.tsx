import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import styles from "./ListRow.module.css";

export type ListRowLayout = "flex" | "grid";

function classes(
  layout: ListRowLayout,
  selected: boolean,
  isButton: boolean,
  className: string | undefined,
): string {
  return [
    styles.base,
    layout === "grid" ? styles.grid : undefined,
    isButton ? styles.button : undefined,
    selected ? styles.selected : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ListRowProps {
  children: ReactNode;
  as?: "button" | "div";
  selected?: boolean;
  layout?: ListRowLayout;
  /** Only meaningful when layout="grid". */
  gridTemplate?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  onDoubleClick?: MouseEventHandler<HTMLElement>;
}

/** The one selected-row look for every list in the app: accent-colored text,
 *  no fill. Do not add a second selection style — pick this one so every
 *  list reads the same way. */
export function ListRow({
  children,
  as = "div",
  selected = false,
  layout = "flex",
  gridTemplate,
  className,
  onClick,
  onDoubleClick,
}: ListRowProps) {
  const isButton = as === "button";
  const resolved = classes(layout, selected, isButton, className);
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
