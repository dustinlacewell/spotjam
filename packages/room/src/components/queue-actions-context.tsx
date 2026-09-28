// What a row-level menu can do to our own queue. Like the playlists api, it
// reaches menus buried in every track list, so it travels by context.

import { createContext, useContext } from "react";
import type { ParsedTrack } from "../lib/spotify-link";

export interface QueueActions {
  /** Add tracks to the end of our queue. */
  append(tracks: ParsedTrack[]): void;
}

const QueueActionsContext = createContext<QueueActions | null>(null);

export function QueueActionsProvider({
  actions,
  children,
}: {
  actions: QueueActions;
  children: React.ReactNode;
}) {
  return (
    <QueueActionsContext.Provider value={actions}>{children}</QueueActionsContext.Provider>
  );
}

export function useQueueActions(): QueueActions {
  const actions = useContext(QueueActionsContext);
  if (actions === null) {
    throw new Error("useQueueActions: no <QueueActionsProvider> above this component.");
  }
  return actions;
}
