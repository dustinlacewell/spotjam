/**
 * What the detail pane shows: the owner's live queue, or one of their
 * playlists. The queue is a pinned pseudo-playlist at the top of the list, so
 * both live in one selection rather than behind a tab.
 */
export type PaneSelection = typeof QUEUE_PANE | string;

export const QUEUE_PANE = "queue" as const;
